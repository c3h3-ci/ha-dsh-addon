'use strict';

/**
 * vendor_check.js 单元测试（无需 HA / 无需真实 vendor，CI 可直接跑）。
 *
 *   node tests/test_vendor_check.js
 *
 * 覆盖 2026-09-27 的真实故障形态：顶层依赖齐全、**传递依赖缺失** ——
 * 旧校验器（只查 DSH 自己的顶层 dependencies）会误报 OK，导致
 * DSH 启动即 ERR_MODULE_NOT_FOUND → 崩溃循环。
 */

const fs = require('fs');
const path = require('path');
const { checkVendor, findInstalledPackage } = require(
  path.join(__dirname, '..', 'deepseek_harness', 'vendor_check.js')
);

const TMP = path.join(__dirname, '.tmp-vendor-check');
let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label);
  }
}

function pkg(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

/** 构造一棵最小 vendor 树：DSH 依赖 execa，execa 依赖 is-plain-obj + kleur。 */
function buildTree({ includePlainObj, nestedPlainObj = false, kleurIsOptional = false }) {
  fs.rmSync(TMP, { recursive: true, force: true });
  const nm = path.join(TMP, 'node_modules');
  pkg(path.join(nm, '@deepseek-ai/dsh'), {
    name: '@deepseek-ai/dsh', version: '0.1.7-rc.2',
    dependencies: { execa: '^8.0.0' },
  });
  fs.mkdirSync(path.join(nm, '@deepseek-ai/dsh/lib'), { recursive: true });
  fs.writeFileSync(path.join(nm, '@deepseek-ai/dsh/lib/bin.js'), '// stub\n');

  pkg(path.join(nm, 'execa'), {
    name: 'execa', version: '8.0.1',
    dependencies: { 'is-plain-obj': '^4.0.0', kleur: '^3.0.0' },
    ...(kleurIsOptional ? { optionalDependencies: { kleur: '^3.0.0' } } : {}),
  });
  pkg(path.join(nm, 'kleur'), { name: 'kleur', version: '3.0.3' });

  if (nestedPlainObj) {
    pkg(path.join(nm, 'execa', 'node_modules', 'is-plain-obj'),
      { name: 'is-plain-obj', version: '4.1.0' });
  } else if (includePlainObj) {
    pkg(path.join(nm, 'is-plain-obj'), { name: 'is-plain-obj', version: '4.1.0' });
  }
  return TMP;
}

console.log('vendor_check.js 测试');

console.log('\n[1] 真实故障形态：顶层依赖在、传递依赖缺失 → 必须判损坏');
{
  const v = buildTree({ includePlainObj: false });
  const r = checkVendor(v);
  assert(r.ok === false, '缺失传递依赖时判定为损坏（旧实现会误报 OK）');
  assert(
    r.missing.some((m) => m.includes('is-plain-obj')),
    '缺失列表点名了 is-plain-obj（可诊断）'
  );
}

console.log('\n[2] 依赖齐全 → 判完整');
{
  const v = buildTree({ includePlainObj: true });
  const r = checkVendor(v);
  assert(r.ok === true, '全部依赖存在时判定为完整');
  assert(r.packages >= 3, '统计到包数量（' + r.packages + '）');
}

console.log('\n[3] 嵌套 node_modules 安装也算满足（Node 解析语义）');
{
  const v = buildTree({ nestedPlainObj: true });
  const r = checkVendor(v);
  assert(r.ok === true, '依赖装在嵌套 node_modules 中视为已安装');
}

console.log('\n[4] optionalDependencies 不计入（避免误报）');
{
  const v = buildTree({ includePlainObj: true, kleurIsOptional: true });
  fs.rmSync(path.join(v, 'node_modules', 'kleur'), { recursive: true, force: true });
  const r = checkVendor(v);
  assert(r.ok === true, 'optional 依赖缺失不判损坏');
}

console.log('\n[5] 只认目录存在，不依赖包入口文件');
{
  const v = buildTree({ includePlainObj: true });
  // execa/kleur 均无 index.js —— 旧实现用 require.resolve 会误报缺失
  const r = checkVendor(v);
  assert(r.ok === true, '无入口文件的包不算缺失（require.resolve 会误报）');
  assert(
    findInstalledPackage('kleur', path.join(v, 'node_modules', 'execa')) !== null,
    'findInstalledPackage 命中上层 node_modules'
  );
}

console.log('\n[6] 空/不存在的 vendor → 判损坏且不抛异常');
{
  const r1 = checkVendor('/nonexistent/vendor-xyz');
  assert(r1.ok === false, '不存在的目录判损坏');
  assert(typeof r1.reason === 'string' && r1.reason.length > 0, '给出可读原因');
  fs.rmSync(path.join(TMP, 'node_modules', '@deepseek-ai/dsh', 'package.json'), { force: true });
  const r2 = checkVendor(TMP);
  assert(r2.ok === false, 'DSH package.json 缺失判损坏');
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);