/**
 * 独立后台（LOCALVAULT_UI_ONLY=1）测试。
 *
 * 用户双击 vault-ui.cmd 时不经过浏览器扩展，host 需要：
 *  - 不读 native messaging（stdin 空闲也不退出），只保活回环 HTTP 服务
 *  - 写出 ui.port 供启动器打开浏览器
 *  - 若已有实例在服务（比如扩展拉起的那个），复用它的端口、不覆盖 ui.port，然后自行退出
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, 'vault-host.exe');
if (!existsSync(exe)) { console.error('FAIL: host 未构建'); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), 'lv-uionly-'));
const env = { ...process.env, LOCALVAULT_ROOT: root, LOCALVAULT_UI_ONLY: '1' };
let passed = 0;
const failures = [];
const ok = (c, m, d) => {
  if (c) { passed++; console.log('PASS: ' + m); }
  else { failures.push(m); console.log('FAIL: ' + m + (d ? ' -- ' + d : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFile = join(root, 'ui.port');
const readPort = () => (existsSync(portFile) ? parseInt(readFileSync(portFile, 'utf8').trim(), 10) : 0);

async function waitPort(limitMs = 8000) {
  for (let i = 0; i < limitMs / 100; i++) {
    const p = readPort();
    if (p > 0) return p;
    await sleep(100);
  }
  return 0;
}

const procs = [];
try {
  const a = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  procs.push(a);
  a.stdout.on('data', () => {});
  a.stderr.on('data', () => {});

  const port = await waitPort();
  ok(port > 0, 'UI-only 实例写出 ui.port（端口 ' + port + '）');

  // 不读 stdin 也不能退出：给一点时间确认进程还活着
  await sleep(400);
  ok(a.exitCode === null, 'stdin 空闲时 UI-only 进程仍存活');

  const res = await fetch(`http://127.0.0.1:${port}/`);
  ok(res.status === 200 && (await res.text()).includes('LocalVault 管理后台'), '独立后台 HTTP 可用');

  // 第二个实例：应复用端口、不覆盖 ui.port，并自行退出
  const before = readPort();
  const b = spawn(exe, [], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  procs.push(b);
  b.stdout.on('data', () => {});
  b.stderr.on('data', () => {});
  const exit = await new Promise((resolve) => {
    b.on('exit', (code) => resolve(code));
    setTimeout(() => resolve('timeout'), 6000);
  });
  ok(exit === 0, '第二个 UI-only 实例复用已有服务后正常退出', String(exit));
  ok(readPort() === before, 'ui.port 未被第二个实例覆盖');

  // /api/* 只接受 POST，且必须带本实例的令牌
  const token = readFileSync(join(root, 'ui.token'), 'utf8').trim();
  const still = await fetch(`http://127.0.0.1:${port}/api/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LV-Token': token },
    body: '{}',
  });
  ok(still.status === 200, '复用后原服务依然可用（令牌沿用第一个实例的）');
  const noTok = await fetch(`http://127.0.0.1:${port}/api/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  ok(noTok.status === 401, '复用场景下无令牌仍然 401');
} catch (e) {
  failures.push('异常：' + e.message);
  console.log('FAIL: 异常 -- ' + e.stack);
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
