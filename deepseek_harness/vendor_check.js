'use strict';

/**
 * vendor DSH 完整性校验器（run.sh 与 api_server.js 共用，单一实现）。
 *
 * 用法：
 *   node vendor_check.js [vendorDir]      # 默认 /data/dsh/vendor
 * 退出码：
 *   0 = 完整    1 = 损坏/缺失
 *
 * 为什么需要它（2026-09-27 真实故障）：
 *   旧实现只遍历 `@deepseek-ai/dsh` 自己的顶层 dependencies（81 个），
 *   传递依赖一个都不查。真实损坏是 execa 的传递依赖 `is-plain-obj` 缺失，
 *   DSH 启动即 ERR_MODULE_NOT_FOUND → 进程退出 → Supervisor watchdog 反复拉起
 *   → 崩溃循环；而每次启动自检都打印 "integrity OK (deps: 81)"。
 *   体检一路绿灯、故障真实存在 —— 排查因此被误导很久。
 *
 * 现策略：扫描 node_modules 树下（含嵌套）每个已安装包，逐个校验其声明的
 * 运行时依赖能否从该包自身位置解析。任何一层缺失即判损坏。
 * peerDependencies / optionalDependencies 不计入（npm 不保证安装，计入会误报）。
 */

const fs = require('fs');
const path = require('path');

const MAX_DEPTH = 8;

/** 递归收集 node_modules 树下所有 package.json 的绝对路径。 */
function collectManifests(root) {
  const manifests = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      // .bin/.cache 及所有点开头目录都不是包
      if (name.charAt(0) === '.') continue;
      const full = path.join(dir, name);
      if (name.charAt(0) === '@') {
        // scope 目录：其下才是真正的包
        walk(full, depth);
        continue;
      }
      const mf = path.join(full, 'package.json');
      if (fs.existsSync(mf)) manifests.push(mf);
      const nested = path.join(full, 'node_modules');
      if (fs.existsSync(nested)) walk(nested, depth + 1);
    }
  };
  walk(root, 0);
  return manifests;
}

/**
 * 判断依赖 dep 是否**已安装**在 fromDir 可见的 node_modules 里。
 *
 * 为什么不用 require.resolve（2026-09-27 实测踩坑）：
 *   require.resolve 测的是"能否作为模块**加载**"，而不是"包**在不在**"。
 *   它要求包有可解析的入口（main / index.js / exports 映射）——
 *   于是一个存在但没有入口文件的包会被误判为"缺失"。
 *   测试夹具里 kleur（只有 package.json、无 index.js）就被误报过一次。
 *   这里改为手工实现 Node 的 node_modules 向上查找算法，
 *   只认「<dir>/node_modules/<dep>/package.json 存在」，语义准确且与
 *   包的入口/exports 写法无关。
 *
 * @returns {string|null} 命中的包目录，未安装返回 null
 */
function findInstalledPackage(dep, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', dep);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 到达文件系统根
    dir = parent;
  }
}

/** 校验一个 vendor 目录；返回 { ok, packages, missing: string[] }。 */
function checkVendor(vendorDir) {
  const root = path.join(vendorDir, 'node_modules');
  const dshPkg = path.join(root, '@deepseek-ai/dsh/package.json');

  let raw;
  try {
    raw = fs.readFileSync(dshPkg, 'utf8');
  } catch (e) {
    return { ok: false, packages: 0, missing: [], reason: 'DSH package.json 不可读: ' + e.message };
  }
  try {
    JSON.parse(raw);
  } catch (e) {
    return { ok: false, packages: 0, missing: [], reason: 'DSH package.json 解析失败: ' + e.message };
  }

  const manifests = collectManifests(root);
  const missing = [];
  for (const mf of manifests) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch (e) {
      continue; // 单个包 manifest 坏了不算依赖缺失，跳过
    }
    const optional = pkg.optionalDependencies || {};
    const peer = pkg.peerDependencies || {};
    const deps = Object.keys(pkg.dependencies || {}).filter(
      (d) => !optional[d] && !peer[d]
    );
    const fromDir = path.dirname(mf);
    for (const d of deps) {
      if (!findInstalledPackage(d, fromDir)) {
        missing.push(`${pkg.name || mf} -> ${d}`);
      }
    }
  }

  return { ok: missing.length === 0, packages: manifests.length, missing };
}

function main() {
  const vendorDir = process.argv[2] || '/data/dsh/vendor';
  const res = checkVendor(vendorDir);
  if (res.ok) {
    console.log(
      `vendor DSH integrity OK (packages: ${res.packages}, transitive checked)`
    );
    process.exit(0);
  }
  if (res.reason) console.error('vendor DSH invalid: ' + res.reason);
  if (res.missing.length) {
    console.error(
      `missing deps (${res.missing.length}): ` +
        res.missing.slice(0, 8).join(', ') +
        (res.missing.length > 8 ? ' ...' : '')
    );
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = { checkVendor, collectManifests, findInstalledPackage };