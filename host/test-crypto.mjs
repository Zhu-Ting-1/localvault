/**
 * host 侧 AES-256-GCM 的兼容性测试。
 *
 * 判据只有一条：C# 用 bcrypt.dll 算出来的密文与 tag，必须和浏览器 WebCrypto 的
 * **逐字节一致**（基准向量由 WebCrypto 生成后硬编码在 Crypto.cs 里）。
 * 对不上，后面 host 接管解密就全是错的。
 *
 * 顺带验证：篡改 tag 必须被拒绝（GCM 认证生效），而不是"解出垃圾数据"。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, 'vault-host.exe');
if (!existsSync(exe)) {
  console.error('FAIL: host 未构建（先运行 host/build.ps1）');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'lv-crypto-'));
let child = null;
let buf = Buffer.alloc(0);
let pending = null;
let passed = 0;
const failures = [];

function check(cond, msg, detail) {
  if (cond) { passed++; console.log('PASS: ' + msg); }
  else { failures.push(msg); console.log('FAIL: ' + msg + (detail ? ' — ' + detail : '')); }
}

function drain() {
  while (pending && buf.length >= 4) {
    const len = buf.readInt32LE(0);
    if (buf.length < 4 + len) return;
    const body = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    const p = pending; pending = null;
    try { p.resolve(JSON.parse(body)); } catch (e) { p.reject(e); }
  }
}

function call(req, timeoutMs = 5000) {
  return new Promise((resolveP, rejectP) => {
    const payload = Buffer.from(JSON.stringify(req), 'utf8');
    const header = Buffer.alloc(4);
    header.writeInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
    const timer = setTimeout(() => { pending = null; rejectP(new Error('超时: ' + req.op)); }, timeoutMs);
    pending = { resolve: (v) => { clearTimeout(timer); resolveP(v); }, reject: (e) => { clearTimeout(timer); rejectP(e); } };
  });
}

try {
  child = spawn(exe, [], { env: { ...process.env, LOCALVAULT_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (c) => { buf = Buffer.concat([buf, c]); drain(); });
  child.stderr.on('data', (c) => process.stderr.write('[host] ' + c.toString()));
  await new Promise((r) => setTimeout(r, 200));

  const res = await call({ id: '1', op: 'selftest' });
  check(res.ok === true, 'selftest 调用成功', JSON.stringify(res).slice(0, 120));

  const c = res.data?.crypto;
  check(!!c, 'selftest 返回 crypto 段');
  check(c?.vectors === 3, '基准向量数量为 3', String(c?.vectors));
  check(c?.passed === 3, '三组向量全部通过（含篡改拒绝）', String(c?.passed));
  check(c?.ok === true, 'C# GCM 与 WebCrypto 字节级一致');
  if (Array.isArray(c?.failures) && c.failures.length) {
    console.log('    失败详情: ' + c.failures.join(' | '));
  }
} catch (e) {
  failures.push('异常：' + e.message);
  console.error(e.stack || e.message);
} finally {
  try { child?.stdin.end(); child?.kill(); } catch { }
  try { rmSync(root, { recursive: true, force: true }); } catch { }
}

console.log('');
console.log(failures.length === 0
  ? `✅ host 加密自检：${passed} 项全部通过`
  : `❌ ${failures.length} 项失败，${passed} 项通过`);
if (failures.length) process.exitCode = 1;
