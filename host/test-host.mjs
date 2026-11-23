// LocalVault native host 协议测试（Node 版，替代 test-host.ps1）。
//
// 为什么用 Node：PowerShell 5.1 在某些环境下对 ProcessStartInfo 的
// EnvironmentVariables / 重定向属性会出现 null 异常，测试结果不可靠；
// Node 的 spawn 语义稳定，且本仓库已用 Node 跑识别器测试。
//
// 覆盖：hello / write CAS / conflict / read / ping / 原子写与备份 / 重启后持久化。
// 注意：host 通过 LOCALVAULT_ROOT 决定保险库目录，测试必须指向工作区内的临时目录，
// 绝不能写进真实的 %LOCALAPPDATA%\LocalVault。

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, 'vault-host.exe');
const root = join(here, '.test-vault');

if (!existsSync(exe)) {
  console.error('FAIL: host 未构建：' + exe + '（先运行 build.ps1）');
  process.exit(1);
}

// 清理边界：只允许删除 host 目录下的测试目录
const resolvedRoot = resolve(root);
if (!resolvedRoot.startsWith(resolve(here))) {
  console.error('FAIL: 拒绝清理 host 目录之外的路径：' + resolvedRoot);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });

let passed = 0;
const failures = [];

function check(cond, message) {
  if (cond) {
    passed += 1;
    console.log('PASS: ' + message);
  } else {
    failures.push(message);
    console.log('FAIL: ' + message);
  }
}

// ---- 进程封装：4 字节小端长度 + UTF-8 JSON ----

let child = null;
let stdoutBuf = Buffer.alloc(0);
let pending = null;

function startHost(rootOverride) {
  stopHost();
  child = spawn(exe, [], {
    env: { ...process.env, LOCALVAULT_ROOT: rootOverride ?? resolvedRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    drain();
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write('[host stderr] ' + chunk.toString());
  });
}

function drain() {
  while (pending && stdoutBuf.length >= 4) {
    const len = stdoutBuf.readInt32LE(0);
    if (len <= 0 || len > 16 * 1024 * 1024) {
      pending.reject(new Error('错误的帧长度：' + len));
      pending = null;
      return;
    }
    if (stdoutBuf.length < 4 + len) return;
    const body = stdoutBuf.subarray(4, 4 + len).toString('utf8');
    stdoutBuf = stdoutBuf.subarray(4 + len);
    const p = pending;
    pending = null;
    try {
      p.resolve(JSON.parse(body));
    } catch (e) {
      p.reject(e);
    }
  }
}

function call(request, timeoutMs = 5000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = Buffer.from(JSON.stringify(request), 'utf8');
    const header = Buffer.alloc(4);
    header.writeInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([header, payload]));
    const timer = setTimeout(() => {
      pending = null;
      rejectPromise(new Error('请求超时：' + request.op));
    }, timeoutMs);
    pending = {
      resolve: (v) => { clearTimeout(timer); resolvePromise(v); },
      reject: (e) => { clearTimeout(timer); rejectPromise(e); },
    };
  });
}

function stopHost() {
  if (!child) return;
  try { child.stdin.end(); } catch {}
  try { child.kill(); } catch {}
  child = null;
  stdoutBuf = Buffer.alloc(0);
  pending = null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 只组帧不等待响应：用于「发出去就杀进程」的场景 */
function frame(req) {
  const payload = Buffer.from(JSON.stringify(req), 'utf8');
  const header = Buffer.alloc(4);
  header.writeInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

// ---- 用例 ----

let current = null;

try {
  console.log('root = ' + resolvedRoot);
  startHost();
  await sleep(150);

  current = await call({ id: '1', op: 'hello' });
  check(current.ok === true, 'hello 成功');
  check(current.data.exists === false, '全新保险库不存在');
  check(current.data.revision === 0, '全新修订号为 0');
  check(current.data.vaultPath === join(resolvedRoot, 'vault.db'), 'vaultPath 指向测试目录');
  console.log('host pid=' + current.data.pid + ' version=' + current.data.version);

  current = await call({ id: '2', op: 'write', baseRevision: 0, ciphertext: 'CIPHER-1' });
  check(current.ok === true, '首次写入成功');
  check(current.data.revision === 1, '首次写入后修订号为 1');

  current = await call({ id: '3', op: 'read' });
  check(current.ok === true, 'read 成功');
  check(current.data.revision === 1, 'read 返回修订号 1');
  check(current.data.ciphertext === 'CIPHER-1', 'read 返回 CIPHER-1');

  current = await call({ id: '4', op: 'write', baseRevision: 0, ciphertext: 'STALE' });
  check(current.ok === false, '过期 baseRevision 被拒绝');
  check(current.error === 'conflict', '过期写入返回 conflict');
  check(current.data.revision === 1, 'conflict 返回当前修订号');
  check(current.data.ciphertext === 'CIPHER-1', 'conflict 返回当前密文');

  current = await call({ id: '5', op: 'write', baseRevision: 1, ciphertext: 'CIPHER-2' });
  check(current.ok === true, '用当前修订号重试成功');
  check(current.data.revision === 2, '第二次写入后修订号为 2');

  current = await call({ id: '6', op: 'read' });
  check(current.data.ciphertext === 'CIPHER-2', 'read 返回 CIPHER-2');

  current = await call({ id: '7', op: 'ping' });
  check(current.ok === true && current.data.pong === true, 'ping 成功');

  check(existsSync(join(root, 'vault.db')), 'vault.db 存在');
  check(existsSync(join(root, 'vault.db.bak')), 'vault.db.bak 存在');
  const backups = existsSync(join(root, 'backups'))
    ? readdirSync(join(root, 'backups')).filter((f) => /^vault-.*\.db$/.test(f))
    : [];
  check(backups.length >= 1, '每日备份存在');

  const disk = readFileSync(join(root, 'vault.db'), 'utf8');
  check(!disk.includes('CIPHER-1'), '旧密文不在当前文件中');
  check(disk.includes('CIPHER-2'), '当前密文在当前文件中');

  // 重启后持久化
  startHost();
  await sleep(150);
  current = await call({ id: '8', op: 'hello' });
  check(current.ok === true, '重启后 hello 成功');
  check(current.data.revision === 2, '修订号跨重启保持');
  current = await call({ id: '9', op: 'read' });
  check(current.data.ciphertext === 'CIPHER-2', '密文跨重启保持');

  // 未知 op 与缺失参数
  current = await call({ id: '10', op: 'nope' });
  check(current.ok === false && current.error === 'unknown_op', '未知 op 返回 unknown_op');
  current = await call({ id: '11', op: 'write', baseRevision: 2 });
  check(current.ok === false, '缺少 ciphertext 时报错且不写盘');
  current = await call({ id: '12', op: 'read' });
  check(current.data.revision === 2 && current.data.ciphertext === 'CIPHER-2', '失败请求没有改变保险库');

  // diag：给扩展「设置/诊断」页用
  current = await call({ id: '13', op: 'diag' });
  check(current.ok === true, 'diag 成功');
  check(typeof current.data.version === 'string' && current.data.version.length > 0, 'diag 带 host 版本');
  check(current.data.vaultPath === join(resolvedRoot, 'vault.db'), 'diag 返回 vaultPath');
  check(current.data.revision === 2, 'diag 的 revision 与当前一致');
  check(current.data.writable === true, 'diag 报告目录可写');
  check(current.data.backupCount >= 1 && Array.isArray(current.data.backups), 'diag 返回备份列表');
  current = await call({ id: '14', op: 'read' });
  check(current.data.revision === 2, 'diag 不改变修订号（纯只读）');

  // ---- 用例：主文件损坏 → 自动回退 .bak，且能自愈继续写 ----
  // 此时 .bak 里是上一版（CIPHER-1）
  writeFileSync(join(root, 'vault.db'), '{ 这不是合法 JSON', 'utf8');
  current = await call({ id: '20', op: 'read' });
  check(current.ok === true, '主文件损坏后 read 仍成功');
  check(current.data.recoveredFromBackup === true, 'read 标记 recoveredFromBackup=true');
  check(current.data.ciphertext === 'CIPHER-1', '回退到 .bak 里的上一版密文');

  current = await call({ id: '21', op: 'write', baseRevision: current.data.revision, ciphertext: 'RECOVERED' });
  check(current.ok === true, '损坏后仍能写入（按 .bak 的 revision 自愈）', current.error);
  const bakAfter = readFileSync(join(root, 'vault.db.bak'), 'utf8');
  check(bakAfter.includes('CIPHER-1') && !bakAfter.includes('这不是合法'), '.bak 没被坏文件顶掉');
  current = await call({ id: '22', op: 'read' });
  check(current.data.ciphertext === 'RECOVERED' && current.data.recoveredFromBackup === false, '自愈后主文件恢复正常');

  // ---- 用例：写盘中途 kill host → 不产生半截文件（试三次不同时机） ----
  const bigCipher = 'X'.repeat(6 * 1024 * 1024); // 拉长写窗口，让 kill 更可能落在写盘过程中
  let killClean = 0;
  for (const delay of [10, 25, 45]) {
    const preRev = (await call({ id: '30', op: 'read' })).data.revision;
    child.stdin.write(frame({ id: '31', op: 'write', baseRevision: preRev, ciphertext: bigCipher }));
    await sleep(delay);
    try { child.kill(); } catch { }
    await sleep(300);

    startHost();
    await sleep(250);
    current = await call({ id: '32', op: 'read' });
    const okRead = current.ok === true;
    const revOk = current.data.revision === preRev || current.data.revision === preRev + 1;
    let parsed = null;
    try { parsed = JSON.parse(readFileSync(join(root, 'vault.db'), 'utf8')); } catch { }
    const fileOk = !!parsed && parsed.format === 'localvault-spike/v1' && typeof parsed.revision === 'number';
    const healed = current.data.recoveredFromBackup === true;
    const after = await call({ id: '33', op: 'write', baseRevision: current.data.revision, ciphertext: 'AFTER-KILL' });
    if (okRead && revOk && (fileOk || healed) && after.ok === true) killClean += 1;
    else {
      console.log(`    [kill@${delay}ms] read=${okRead} rev=${current?.data?.revision}/${preRev} file=${fileOk} healed=${healed} write=${after.ok}`);
    }
  }
  check(killClean === 3, `kill 中途写入 3 次都安全：可读、revision 无半截、可继续写（通过 ${killClean}/3）`);

  // ---- 用例：目录只读 → 明确报 readonly，且不覆盖旧数据 ----
  const roDir = join(root, 'ro-case');
  mkdirSync(roDir, { recursive: true });
  startHost(roDir);
  await sleep(200);
  current = await call({ id: '40', op: 'write', baseRevision: 0, ciphertext: 'RO-1' });
  check(current.ok === true, '只读测试：先正常写入一条');

  const user = process.env.USERNAME;
  let aclApplied = false;
  try {
    execFileSync('icacls', [roDir, '/deny', `${user}:(W)`], { stdio: 'ignore' });
    aclApplied = true;
  } catch (e) {
    check(false, '只读测试：无法设置目录 ACL（跳过）');
  }
  if (aclApplied) {
    current = await call({ id: '41', op: 'write', baseRevision: 1, ciphertext: 'RO-2' });
    check(current.ok === false, '只读目录下写入被拒绝');
    check(current.error === 'readonly', '错误码是 readonly（不是 internal）', current.error);
    current = await call({ id: '42', op: 'read' });
    check(current.data.ciphertext === 'RO-1', '旧数据没有被覆盖');
    try { execFileSync('icacls', [roDir, '/remove:d', user], { stdio: 'ignore' }); } catch { }
    await sleep(100);
    current = await call({ id: '43', op: 'write', baseRevision: 1, ciphertext: 'RO-3' });
    check(current.ok === true, '恢复权限后可以继续写入');
  }
  stopHost();
  startHost();
  await sleep(150);
} catch (e) {
  failures.push('异常：' + e.message);
  console.error(e.stack || e.message);
} finally {
  stopHost();
}

console.log('');
if (failures.length) {
  console.log(failures.length + ' 项失败，' + passed + ' 项通过');
  process.exit(1);
}
console.log('host 协议测试全部通过（' + passed + ' 项）');
console.log('files: ' + readdirSync(root, { recursive: true }).join(', '));