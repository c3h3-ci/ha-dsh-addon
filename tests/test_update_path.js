'use strict';

/**
 * 一键更新路径测试（CI 可跑，不需要 HA / 不需要真 npm）。
 *
 *   node tests/test_update_path.js
 *
 * 覆盖 2026-09-27 两个真实故障：
 *   A. 半截安装被换上 → 容器崩溃循环。
 *      现在必须「切换前校验依赖图」，损坏的 vendor.tmp 一律拒绝切换，
 *      且**旧 vendor 保持可用**（更新失败不能把用户搞挂）。
 *   B. 安装期间 healthcheck 把容器判死 → watchdog 重启 → 安装被杀。
 *      现在安装期间写 /data/dsh/.installing，healthcheck.sh 据此豁免。
 *
 * 手法：用 DSH_TEST_INSTALL_SCRIPT 替换 npm 步骤，脚本按用例要求
 * 造出「完整」或「半截」的 vendor.tmp，再驱动 POST /api/update。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SANDBOX = path.join(__dirname, '.tmp-update-path');
// 假 npm 脚本必须放在 SANDBOX 之外：resetSandbox 会整体删除沙箱目录，
// 否则第二次用例启动时脚本已被删掉（ENOENT: install-ok.sh）。
const SCRIPTS_DIR = path.join(__dirname, '.tmp-update-scripts');
const PORT = parseInt(process.env.UPDATE_TEST_PORT || '3111', 10);
const TEST_TOKEN = 'update-test-token';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

function pkg(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
}

/** 造一棵完整的 vendor（DSH + 其依赖 execa → is-plain-obj）。 */
function makeGoodTree(dir) {
  const nm = path.join(dir, 'node_modules');
  pkg(path.join(nm, '@deepseek-ai/dsh'),
    { name: '@deepseek-ai/dsh', version: '0.1.7-rc.2', dependencies: { execa: '^8' } });
  fs.mkdirSync(path.join(nm, '@deepseek-ai/dsh/lib'), { recursive: true });
  fs.writeFileSync(path.join(nm, '@deepseek-ai/dsh/lib/bin.js'), '// stub\n');
  pkg(path.join(nm, 'execa'),
    { name: 'execa', version: '8.0.1', dependencies: { 'is-plain-obj': '^4' } });
  pkg(path.join(nm, 'is-plain-obj'), { name: 'is-plain-obj', version: '4.1.0' });
}

/** 造一棵半截 vendor：bin.js 在，但传递依赖 is-plain-obj 缺失（真实故障形态）。 */
function makeTruncatedTree(dir) {
  makeGoodTree(dir);
  fs.rmSync(path.join(dir, 'node_modules', 'is-plain-obj'), { recursive: true, force: true });
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method,
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode, json, buf });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return true;
    await sleep(200);
  }
  console.log(`    (超时等待: ${label})`);
  return false;
}

async function startBridge({ installScript, extraEnv = {} }) {
  const env = {
    ...process.env,
    DSH_API_PORT: String(PORT),
    DSH_API_TOKEN: TEST_TOKEN,
    DSH_VENDOR_DIR: path.join(SANDBOX, 'vendor'),
    DSH_VENDOR_TMP: path.join(SANDBOX, 'vendor.tmp'),
    DSH_INSTALL_FLAG: path.join(SANDBOX, 'installing.flag'),
    DSH_TEST_INSTALL_SCRIPT: installScript,
    DSH_WEB_PORT: '3199',
    ...extraEnv,
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'deepseek_harness', 'api_server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const up = await waitFor(async () => {
    try { await request('GET', '/api/status'); return true; } catch { return false; }
  }, 15000, 'bridge 启动');
  if (!up) throw new Error('bridge 未启动');
  return child;
}

function resetSandbox(goodExisting) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  if (goodExisting) makeGoodTree(path.join(SANDBOX, 'vendor'));
}

const INSTALL_OK = path.join(SCRIPTS_DIR, 'install-ok.sh');

/** 写一个"假 npm"：在 $1(vendor.tmp) 里造树；$2='ok' 或 'truncated'。 */
function writeInstallScripts() {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const script = `#!/bin/bash
# 假 npm：$1=vendor.tmp  $2=channel  （模式由文件名决定）
TMP="$1"
MODE="${'$'}{2:-ok}"
mkdir -p "$TMP/node_modules/@deepseek-ai/dsh/lib"
echo '{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2","dependencies":{"execa":"^8"}}' > "$TMP/node_modules/@deepseek-ai/dsh/package.json"
echo '// stub' > "$TMP/node_modules/@deepseek-ai/dsh/lib/bin.js"
mkdir -p "$TMP/node_modules/execa"
echo '{"name":"execa","version":"8.0.1","dependencies":{"is-plain-obj":"^4"}}' > "$TMP/node_modules/execa/package.json"
if [ "${'$'}{VC_MODE:-ok}" = "ok" ]; then
  mkdir -p "$TMP/node_modules/is-plain-obj"
  echo '{"name":"is-plain-obj","version":"4.1.0"}' > "$TMP/node_modules/is-plain-obj/package.json"
fi
exit 0
`;
  fs.writeFileSync(INSTALL_OK, script);
  fs.chmodSync(INSTALL_OK, 0o755);
}

async function main() {
  resetSandbox(true);
  writeInstallScripts();

  // ── 用例 A：半截安装必须被拒绝，旧 vendor 存活 ──
  console.log('\n[A] 半截安装（传递依赖缺失）必须拒绝切换，旧版本保持可用');
  // VC_MODE=truncated → 假 npm 不写 is-plain-obj，模拟被 watchdog 打断的安装
  let child = await startBridge({ installScript: INSTALL_OK, extraEnv: { VC_MODE: 'truncated' } });
  assert(
    fs.existsSync(path.join(SANDBOX, 'vendor', 'node_modules', 'is-plain-obj')),
    '起点：旧 vendor 是完整的（含 is-plain-obj）'
  );

  const rA = await request('POST', '/api/update', { channel: 'next' });
  assert(rA.status === 202, 'POST /api/update 返回 202（后台执行）');

  const finished = await waitFor(async () => {
    const st = await request('GET', '/api/update/result');
    return st.json && st.json.status && st.json.status !== 'installing';
  }, 30000, '更新结束');
  const finalA = (await request('GET', '/api/update/result')).json;
  console.log('    更新结果:', JSON.stringify(finalA));
  assert(finished && finalA.status === 'error', '结果状态为 error（拒绝切换）');
  assert(/不完整|缺失/.test(finalA.error || ''), '错误信息说明依赖不完整');
  assert(
    fs.existsSync(path.join(SANDBOX, 'vendor', 'node_modules', 'is-plain-obj')),
    '★ 旧 vendor 未被破坏（旧版本仍可用）'
  );
  assert(!fs.existsSync(path.join(SANDBOX, 'vendor.tmp')), 'vendor.tmp 已清理');
  assert(
    !fs.existsSync(path.join(SANDBOX, 'installing.flag')),
    '★ 安装标记已清除（否则 watchdog 豁免永久生效）'
  );
  child.kill('SIGKILL');
  await sleep(300);

  // ── 用例 B：完整安装应切换成功并留下标记 ──
  console.log('\n[B] 完整安装在切换前校验通过 → 正常切换');
  resetSandbox(true);
  child = await startBridge({ installScript: INSTALL_OK, extraEnv: { VC_MODE: 'ok' } });
  const rB = await request('POST', '/api/update', { channel: 'next' });
  assert(rB.status === 202, 'POST /api/update 返回 202');
  await waitFor(async () => {
    const st = await request('GET', '/api/update/result');
    return st.json && st.json.status && st.json.status !== 'installing';
  }, 30000, '更新结束');
  const finalB = (await request('GET', '/api/update/result')).json;
  console.log('    更新结果:', JSON.stringify(finalB));
  assert(finalB.status === 'done', '结果状态为 done');
  assert(fs.existsSync(path.join(SANDBOX, 'vendor', 'node_modules', 'is-plain-obj')),
    '新 vendor 已就位且依赖完整');
  assert(
    fs.existsSync(path.join(SANDBOX, 'vendor.old', 'node_modules', 'is-plain-obj')),
    '旧 vendor 备份为 vendor.old（可回滚）'
  );
  assert(!fs.existsSync(path.join(SANDBOX, 'installing.flag')), '安装标记已清除');
  child.kill('SIGKILL');
  await sleep(300);

  // ── 用例 C：healthcheck 安装豁免 ──
  console.log('\n[C] healthcheck.sh 在安装期间豁免、标记陈旧后不再豁免');
  {
    const { execFileSync } = require('child_process');
    const hc = path.join(ROOT, 'deepseek_harness', 'healthcheck.sh');
    const flagDir = path.join(SANDBOX, 'hc');
    fs.mkdirSync(flagDir, { recursive: true });
    const flag = path.join(flagDir, '.installing');
    // healthcheck.sh 的标记路径与探测地址都支持环境变量覆盖
    // （DSH_INSTALL_FLAG / DSH_HEALTHCHECK_URL），无需 sed 改脚本 ——
    // 早期写法用 sed 替换字符串，结果命中了注释里的同名字符串而静默失效。
    const runHc = () => {
      try {
        execFileSync('bash', [hc], {
          stdio: 'pipe',
          env: { ...process.env, DSH_INSTALL_FLAG: flag, DSH_HEALTHCHECK_URL: 'http://127.0.0.1:9/' },
        });
        return 0;
      } catch (e) { return e.status; }
    };

    // C1: 无标记 + 服务无响应 → 判不健康
    fs.rmSync(flag, { force: true });
    assert(runHc() === 1, '无安装标记且服务无响应 → 退出码 1（判不健康）');

    // C2: 有新鲜标记 → 豁免（watchdog 不重启，安装得以跑完）
    fs.writeFileSync(flag, '{}');
    assert(runHc() === 0, '★ 安装进行中 → 退出码 0（豁免，watchdog 不重启）');

    // C3: 陈旧标记 → 不再豁免（防止失败残留永久关掉自愈）
    const old = Date.now() / 1000 - 3600; // 1 小时前，超过 30 分钟阈值
    fs.utimesSync(flag, old, old);
    assert(runHc() === 1, '★ 陈旧标记（>30min）→ 退出码 1（恢复自愈）');
  }

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.rmSync(SCRIPTS_DIR, { recursive: true, force: true });
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常:', e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); fs.rmSync(SCRIPTS_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});