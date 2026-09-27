'use strict';
/**
 * 针对真实 vendor 树的变异测试（只镜像 package.json，因为校验器只读 manifest）。
 *
 *   1) 真实树 → 应判定完整
 *   2) 镜像树移走一个"确实被某包 dependencies 声明"的包 → 应判定损坏
 *   3) 把该包补回为**嵌套**依赖（声明方之下）→ 应重新判定完整（验证 Node 嵌套解析语义）
 *
 * 用途：**人工诊断工具**，不进 CI（需要真实 vendor 树，约 500+ 包）。
 * 用于验证校验器对真实包树的判定能力 —— 特别是"移走一个被大量依赖的包"
 * 时的级联检出是否合理。
 *
 * 用法：
 *   node tests/mutation_test.js /path/to/vendor          # 本地
 *   VENDOR_CHECK_JS=/tmp/vendor_check.js \
 *     node mutation_test.js /data/dsh/vendor             # HA 容器内
 */
const fs = require('fs');
const path = require('path');
// 校验器路径：默认用仓库内实现；在 HA 容器里手测时可用
//   VENDOR_CHECK_JS=/tmp/vendor_check.js node mutation_test.js /data/dsh/vendor
const CHECKER = process.env.VENDOR_CHECK_JS
  || path.join(__dirname, '..', 'deepseek_harness', 'vendor_check.js');
const { checkVendor } = require(CHECKER);

const vendor = process.argv[2] || '/data/dsh/vendor';
const root = path.join(vendor, 'node_modules');
// 镜像目录：默认放 /tmp（容器内手测）；本地可用 VENDOR_MUT_DIR 覆盖，
// 便于在非 HA 环境复现。
const MIRROR = process.env.VENDOR_MUT_DIR || '/tmp/vc-mut';

/** 递归遍历真实树，收集 {relDir, pkg}。 */
function walk(dir, rel, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.charAt(0) === '.') continue;
    const full = path.join(dir, e.name);
    if (e.name.charAt(0) === '@') { walk(full, path.join(rel, e.name), out); continue; }
    const mf = path.join(full, 'package.json');
    if (fs.existsSync(mf)) {
      try { out.push({ rel: path.join(rel, e.name), pkg: JSON.parse(fs.readFileSync(mf, 'utf8')) }); } catch {}
    }
    const nested = path.join(full, 'node_modules');
    if (fs.existsSync(nested)) walk(nested, path.join(rel, e.name, 'node_modules'), out);
  }
  return out;
}

const pkgs = walk(root, '', []);
console.log(`[1] 真实树 package.json 数=${pkgs.length}`);
const base = checkVendor(vendor);
console.log(`    真实树完整=${base.ok}${base.ok ? '' : '  ' + JSON.stringify(base).slice(0, 300)}`);

// 统计被声明的依赖
const counts = {};
for (const { pkg } of pkgs) {
  for (const d of Object.keys(pkg.dependencies || {})) counts[d] = (counts[d] || 0) + 1;
}
const present = new Set(pkgs.map((p) => {
  const seg = p.rel.split('node_modules/').pop();
  return seg;
}));
const topLevel = Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .filter(([d]) => fs.existsSync(path.join(root, d, 'package.json')));
console.log(`    被声明最多的依赖: ${topLevel.slice(0, 8).map(([k, v]) => `${k}(${v})`).join(', ')}`);
console.log(`    树中可见的顶层包样例: ${[...present].slice(0, 5).join(', ')}`);

if (!topLevel.length) { console.log('!! 找不到可移走的候选（可能全部嵌套安装）'); process.exit(0); }
const victim = topLevel[0][0];

// 构建镜像（只写 package.json）
fs.rmSync(MIRROR, { recursive: true, force: true });
for (const { rel, pkg } of pkgs) {
  const d = path.join(MIRROR, 'node_modules', rel);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg));
}
console.log(`[1b] 镜像树（仅 manifest）完整性=${checkVendor(MIRROR).ok}  ← 应与真实树一致`);

console.log(`[2] 变异：移走 ${victim}（声明次数 ${counts[victim]}）`);
fs.rmSync(path.join(MIRROR, 'node_modules', victim), { recursive: true, force: true });
const b = checkVendor(MIRROR);
console.log(`    完整=${b.ok}  ← 期望 false`);
console.log(`    检出缺失 ${b.missing.length} 条: ${b.missing.slice(0, 4).join(' | ')}`);

// [3] 补回为嵌套依赖：只应满足"该声明方"这一个包。
//     注意：victim 往往被上百个包声明（如 schemastery 被 127 个包依赖），
//     嵌套装在某一个包下面，只能满足那一个 —— 其余仍应报缺失。
//     这正是 Node 的 node_modules 向上查找语义，校验器必须如实反映，
//     不能"只要树里任何位置有该包就算满足"（那会漏掉真实故障）。
//     为让"减少一个"可验证，特意挑一个**确实出现在缺失列表里**的声明方。
const missingDeclarers = pkgs.filter(({ pkg }) => {
  const label = (pkg.name || '') + ' -> ' + victim;
  return b.missing.includes(label);
});
const declarer = missingDeclarers[0] || pkgs.find(({ pkg }) => (pkg.dependencies || {})[victim]);
if (declarer) {
  const declarerLabel = declarer.pkg.name || declarer.rel;
  const wasMissing = b.missing.includes(declarerLabel + ' -> ' + victim);
  console.log(`[3] 把 ${victim} 补回为嵌套依赖（声明方 ${declarerLabel}，原缺失=${wasMissing}）`);
  const nested = path.join(MIRROR, 'node_modules', declarer.rel, 'node_modules', victim);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'package.json'),
    JSON.stringify({ name: victim, version: '9.9.9' }));
  const f = checkVendor(MIRROR);
  const stillMissing = f.missing.includes(declarerLabel + ' -> ' + victim);
  console.log(`    该声明方是否仍报缺失: ${stillMissing}  ← 期望 false（嵌套应满足它）`);
  console.log(`    缺失总数 ${b.missing.length} -> ${f.missing.length}  ← 期望 ${wasMissing ? '减 1' : '不变'}`);
  if (stillMissing) console.log('    !! 嵌套解析语义未生效');
  if (wasMissing && f.missing.length !== b.missing.length - 1) {
    console.log('    !! 缺失总数未按预期减少 1');
  }
}
fs.rmSync(MIRROR, { recursive: true, force: true });
console.log('DONE');