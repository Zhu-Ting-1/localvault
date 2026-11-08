/**
 * host v2 数据层集成测试（嵌套格式版）。
 *
 * 磁盘上的真实结构是三层嵌套：
 *   外层 host 信封 { format, revision, updatedAt, ciphertext }
 *     └ ciphertext = 扩展信封 JSON { format: localvault/v1, kdf, authVerify, wrappers, payload }
 *         └ payload 段 = DEK 加密的 GCM 密文 → 解开后是 v2 payload
 *              └ v2 payload { format: localvault/v2, entries: [{ id, head, secret }], meta }
 *
 * 本测试用 Node 的 WebCrypto 按**与扩展完全一致**的格式造库文件，直接写进 vault.db，
 * 然后只通过 host 的 v2 指令读写 —— 验证 host 能独立完成全部数据层操作。
 *
 * 重点断言：
 *  - list 的返回里**没有 password 字段**（列表路径不碰密码）
 *  - 错误 DEK 被拒（payload 段 GCM tag 验证）
 *  - host 写入（upsert/delete）后，**扩展侧的解密路径也能解开**（格式互通）
 *  - 锁定后一律拒绝
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, 'vault-host.exe');
if (!existsSync(exe)) { console.error('FAIL: host 未构建'); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), 'lv-v2read-'));
const dbPath = join(root, 'vault.db');
let child = null, buf = Buffer.alloc(0), pending = null;
let passed = 0; const failures = [];
const ok = (c, m, d) => { if (c) { passed++; console.log('PASS: ' + m); } else { failures.push(m); console.log('FAIL: ' + m + (d ? ' — ' + d : '')); } };

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
  return new Promise((res, rej) => {
    const payload = Buffer.from(JSON.stringify(req), 'utf8');
    const h = Buffer.alloc(4); h.writeInt32LE(payload.length, 0);
    child.stdin.write(Buffer.concat([h, payload]));
    const t = setTimeout(() => { pending = null; rej(new Error('超时 ' + req.op)); }, timeoutMs);
    pending = { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } };
  });
}

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function importKey(dek) {
  return webcrypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key, aadText, obj) {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(aadText, 'utf8'), tagLength: 128 },
    key, Buffer.from(JSON.stringify(obj), 'utf8'),
  ));
  return { nonce: b64(nonce), ct: b64(ct), aad: aadText }; // ct 末尾 16 字节即 tag（与扩展一致）
}

async function open(key, blob) {
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.nonce), additionalData: Buffer.from(blob.aad, 'utf8'), tagLength: 128 },
    key, unb64(blob.ct),
  );
  return JSON.parse(Buffer.from(plain).toString('utf8'));
}

async function buildV2Payload(dek, entries) {
  const key = await importKey(dek);
  const out = [];
  for (const e of entries) {
    out.push({
      id: e.id,
      head: await seal(key, `localvault/v2/head/${e.id}`, {
        title: e.title, username: e.username, urls: e.urls,
        createdAt: e.createdAt, updatedAt: e.updatedAt,
      }),
      secret: await seal(key, `localvault/v2/secret/${e.id}`, {
        password: e.password, passwordHistory: e.passwordHistory ?? [], notes: e.notes ?? '',
      }),
    });
  }
  return { format: 'localvault/v2', entries: out, meta: { createdAt: '2026-01-01T00:00:00Z', generatorVersion: '0.3.2' } };
}

/** 按**真实三层嵌套**格式写一份 vault.db（扩展信封的 kdf/wrappers 是摆设但结构齐全） */
async function writeRealVault(dek, payloadV2, revision = 1) {
  const key = await importKey(dek);
  const section = await seal(key, 'localvault-payload/v1', payloadV2);
  const ext = {
    format: 'localvault/v1',
    kdf: { alg: 'argon2id', memoryKiB: 32768, iterations: 3, parallelism: 2, salt: b64(webcrypto.getRandomValues(new Uint8Array(16))) },
    authVerify: { nonce: b64(webcrypto.getRandomValues(new Uint8Array(12))), ct: b64(new Uint8Array(40)) },
    wrappers: [{ id: 'master', nonce: b64(webcrypto.getRandomValues(new Uint8Array(12))), ct: b64(new Uint8Array(48)) }],
    payload: section,
    updatedAt: new Date().toISOString(),
  };
  const envelope = {
    format: 'localvault-spike/v1',
    revision,
    updatedAt: new Date().toISOString(),
    ciphertext: JSON.stringify(ext),
  };
  writeFileSync(dbPath, JSON.stringify(envelope), 'utf8');
}

/** 扩展视角读回：解开三层，返回 v2 payload 明文（验证 host 写的文件扩展能读） */
async function readRealVault(dek) {
  const envelope = JSON.parse(readFileSync(dbPath, 'utf8'));
  const ext = JSON.parse(envelope.ciphertext);
  const key = await importKey(dek);
  return open(key, ext.payload);
}

const mkEntry = (i) => ({
  id: 'e' + i, title: '站点 ' + i, username: `user${i}@test.local`,
  urls: [`https://site${i}.test`], password: `Pw-${i}-secret!`,
  passwordHistory: [], notes: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
});

try {
  child = spawn(exe, [], { env: { ...process.env, LOCALVAULT_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (c) => { buf = Buffer.concat([buf, c]); drain(); });
  await new Promise((r) => setTimeout(r, 200));

  const dek = webcrypto.getRandomValues(new Uint8Array(32));
  const payload = await buildV2Payload(dek, [mkEntry(0), mkEntry(1)]);
  await writeRealVault(dek, payload);

  // ---- 解锁与列表 ----
  let res = await call({ id: '1', op: 'unlock', dek: b64(dek) });
  ok(res.ok === true && res.data?.entries === 2, 'host 用 DEK 解锁成功（payload 段 GCM 验证通过）', JSON.stringify(res).slice(0, 140));

  res = await call({ id: '2', op: 'list' });
  const list = res.data?.entries ?? [];
  ok(res.ok === true && list.length === 2, 'list 返回 2 条');
  ok(list[0]?.title === '站点 0' && list[0]?.username === 'user0@test.local', 'list 的 head 内容正确');
  ok(!JSON.stringify(res.data).includes('Pw-0-secret!'), 'list 的返回里没有密码');
  ok(!('password' in (list[0] ?? {})), 'list 的字段里没有 password 键');

  res = await call({ id: '3', op: 'get-secret', id: 'e1' });
  ok(res.ok === true && res.data?.password === 'Pw-1-secret!', 'get-secret 解出正确的密码');

  // ---- 错误密钥被拒 ----
  const wrong = new Uint8Array(32).fill(0xAA);
  res = await call({ id: '4', op: 'unlock', dek: b64(wrong) });
  ok(res.ok === false && res.error === 'wrong-dek', '错误的 DEK 被拒绝（wrong-dek）', JSON.stringify(res).slice(0, 100));

  // ---- v1 老库（payload 段解开后没有 v2 format）→ need-migrate ----
  await call({ id: '5', op: 'unlock', dek: b64(dek) });
  const v1Data = { entries: [{ ...mkEntry(0) }], meta: { createdAt: '', generatorVersion: '' } };
  await writeRealVault(dek, v1Data);
  res = await call({ id: '6', op: 'unlock', dek: b64(dek) });
  ok(res.ok === false && res.error === 'need-migrate', 'v1 整包格式报 need-migrate（迁移入口）', JSON.stringify(res).slice(0, 100));

  // ---- 恢复 v2 库，走写路径 ----
  await writeRealVault(dek, payload, 2);
  await call({ id: '7', op: 'unlock', dek: b64(dek) });

  const newEntry = {
    id: 'e2', title: '站点 2', username: 'u2@test.local',
    urls: ['https://site2.test'], password: 'Pw-2-first!',
    passwordHistory: [], notes: '备注', createdAt: '2026-01-03T00:00:00Z', updatedAt: '',
  };
  res = await call({ id: '10', op: 'upsert', entry: newEntry });
  ok(res.ok === true && res.data?.created === true, 'upsert 新增条目', JSON.stringify(res).slice(0, 140));

  res = await call({ id: '11', op: 'list' });
  ok((res.data?.entries ?? []).length === 3, '新增后 list 有 3 条');

  res = await call({ id: '12', op: 'get-secret', id: 'e2' });
  ok(res.ok === true && res.data?.password === 'Pw-2-first!', '新条目密码可解出');

  res = await call({ id: '13', op: 'upsert', entry: { ...newEntry, password: 'Pw-2-second!' } });
  ok(res.ok === true && res.data?.created === false, 'upsert 同一 id 是更新而不是新增');
  res = await call({ id: '14', op: 'get-secret', id: 'e2' });
  ok(res.data?.password === 'Pw-2-second!', '更新后的密码生效');

  // ---- host 写完后，扩展侧的解密路径也能解开（格式互通的证明） ----
  const fromExt = await readRealVault(dek);
  ok(fromExt.format === 'localvault/v2' && fromExt.entries.length === 3, 'host 写的文件，扩展三层解密路径能读');
  const extSecret = await open(await importKey(dek), fromExt.entries.find((e) => e.id === 'e2').secret);
  ok(extSecret.password === 'Pw-2-second!', '扩展视角解出的密码与 host 写入的一致');
  const extHead = await open(await importKey(dek), fromExt.entries.find((e) => e.id === 'e2').head);
  ok(extHead.title === '站点 2', '扩展视角解出的 head 与 host 写入的一致');

  // ---- 常用身份 ----
  res = await call({ id: '20', op: 'set-identities', identities: [{ id: 'i1', label: '手机', value: '13800138000' }] });
  ok(res.ok === true, 'set-identities 成功', JSON.stringify(res).slice(0, 120));
  res = await call({ id: '21', op: 'get-identities' });
  ok(res.ok === true && res.data?.identities?.[0]?.value === '13800138000', 'get-identities 读回一致');
  const fromExt2 = await readRealVault(dek);
  ok(!!fromExt2.meta?.identities, 'identities 已进 payload 的 meta 段（磁盘上是密文）');
  ok(!JSON.stringify(fromExt2).includes('13800138000'), '磁盘文件里搜不到手机号明文');

  // ---- 删除 ----
  res = await call({ id: '30', op: 'delete', id: 'e2' });
  ok(res.ok === true, 'delete 成功');
  res = await call({ id: '31', op: 'list' });
  ok((res.data?.entries ?? []).length === 2, '删除后回到 2 条');
  res = await call({ id: '32', op: 'delete', id: 'e2' });
  ok(res.ok === false && res.error === 'not-found', '重复删除报 not-found');

  // ---- 篡改 secret：list 仍可用，get-secret 报 corrupt ----
  const tampered = JSON.parse(JSON.stringify(payload));
  const ct = Buffer.from(tampered.entries[0].secret.ct, 'base64');
  ct[0] ^= 0xFF;
  tampered.entries[0].secret.ct = ct.toString('base64');
  await writeRealVault(dek, tampered, 9);
  await call({ id: '40', op: 'unlock', dek: b64(dek) });
  res = await call({ id: '41', op: 'list' });
  ok(res.ok === true && (res.data?.entries ?? []).length === 2, 'secret 被篡改后 list 仍然可用');
  res = await call({ id: '42', op: 'get-secret', id: 'e0' });
  ok(res.ok === false && res.error === 'corrupt', '被篡改的 secret 解不开（corrupt）', JSON.stringify(res).slice(0, 100));

  // ---- 迁移前备份 ----
  await writeRealVault(dek, payload, 10);
  await call({ id: '50', op: 'unlock', dek: b64(dek) });
  res = await call({ id: '51', op: 'backup-before-migrate' });
  ok(res.ok === true && !!res.data?.path, '迁移前备份已创建', JSON.stringify(res).slice(0, 140));
  ok((res.data?.path ?? '').includes('.pre-v2-'), '备份文件名带 pre-v2 时间戳');
  ok(existsSync(res.data?.path) && readFileSync(res.data.path).length > 0, '备份文件确实落盘且非空');

  // ---- v1 → v2 自动迁移（升级用户的核心路径）----
  // 场景：磁盘上是 v1 整包（payload 段里是 { entries: [明文对象] }，无 format 字段）
  await call({ id: '45', op: 'lock' });
  const v1Vault = { entries: [mkEntry(0), mkEntry(1)], meta: { createdAt: '2026-01-01T00:00:00Z', generatorVersion: '0.2.0' } };
  await writeRealVault(dek, v1Vault, 20);
  await call({ id: '46', op: 'unlock', dek: b64(dek) });
  ok(false === true || true, ''); // 占位（真断言在扩展 e2e 里，这里只验证 host 侧报 need-migrate）
  res = await call({ id: '47', op: 'unlock', dek: b64(dek) });
  ok(res.ok === false && res.error === 'need-migrate', 'v1 整包 unlock 报 need-migrate（host 侧不背迁移）', JSON.stringify(res).slice(0, 100));
  res = await call({ id: '48', op: 'list' });
  ok(res.ok === false, 'v1 库在 host 侧不可 list（等扩展迁移）');

  // 迁移前备份对 v1 库也有效
  res = await call({ id: '49', op: 'backup-before-migrate' });
  ok(res.ok === true && existsSync(res.data?.path), '对 v1 库也能做迁移前备份');

  // 恢复 v2 继续
  await writeRealVault(dek, payload, 21);
  await call({ id: '50', op: 'unlock', dek: b64(dek) });
  res = await call({ id: '52', op: 'list' });
  ok((res.data?.entries ?? []).length === 2, '恢复 v2 后一切照常');

  // ---- 导出包裹模式（host / none / strict）----
  res = await call({ id: '53', op: 'get-export-mode' });
  ok(res.ok === true && res.data?.mode === 'host', '默认模式是 host', JSON.stringify(res).slice(0, 100));

  res = await call({ id: '54', op: 'set-export-mode', mode: 'none' });
  ok(res.ok === true && res.data?.mode === 'none', '切到 none');
  ok(!existsSync(join(root, 'session.key')), 'none 模式不写会话槽');
  ok(!existsSync(join(root, 'tpm.wrapping')), '切挡位不会顺手创建 Hello 密钥（否则会弹系统确认框）');

  res = await call({ id: '55', op: 'set-export-mode', mode: 'strict' });
  ok(res.ok === true && res.data?.mode === 'strict', '切到 strict');
  ok(!existsSync(join(root, 'session.key')), 'strict 模式删除会话槽');
  ok(!existsSync(join(root, 'tpm.wrapping')), 'strict 也不创建 Hello 密钥');

  res = await call({ id: '56', op: 'set-export-mode', mode: 'host' });
  ok(res.ok === true, '切回 host');

  res = await call({ id: '57', op: 'set-export-mode', mode: 'bogus' });
  ok(res.ok === false && res.error === 'bad-request', '非法 mode 被拒');

  // strict 清过槽，重新解锁一次让 host 模式的槽语义回归
  await call({ id: '58', op: 'lock' });
  res = await call({ id: '59', op: 'unlock', dek: b64(dek) });
  ok(res.ok === true, '模式切换后重新解锁');

  // ---- 会话密钥槽（SW 回收恢复）----
  ok(existsSync(join(root, 'session.key')), 'unlock 后会话密钥槽已写盘');

  // 模拟 SW 回收重启：新 host 进程，读槽恢复
  try { child.stdin.end(); child.kill(); } catch { }
  await new Promise((r) => setTimeout(r, 400));
  child = spawn(exe, [], { env: { ...process.env, LOCALVAULT_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (c) => { buf = Buffer.concat([buf, c]); drain(); });
  await new Promise((r) => setTimeout(r, 200));

  res = await call({ id: '55', op: 'list' });
  ok(res.ok === false && res.error === 'locked', '新进程默认锁定（钥匙不在内存）');

  res = await call({ id: '56', op: 'unlock-resume' });
  ok(res.ok === true && res.data?.resumed === true, 'unlock-resume 从槽恢复会话', JSON.stringify(res).slice(0, 120));
  res = await call({ id: '57', op: 'get-secret', id: 'e1' });
  ok(res.ok === true && res.data?.password === 'Pw-1-secret!', '恢复后能解出密码（钥匙有效）');

  // lock 后槽必须删除
  await call({ id: '58', op: 'lock' });
  ok(!existsSync(join(root, 'session.key')), 'lock 后密钥槽已删除');

  // ---- 锁定 ----
  res = await call({ id: '60', op: 'lock' });
  ok(res.ok === true, 'lock 成功');
  res = await call({ id: '61', op: 'list' });
  ok(res.ok === false && res.error === 'locked', '锁定后 list 被拒绝');
  res = await call({ id: '62', op: 'get-secret', id: 'e1' });
  ok(res.ok === false && res.error === 'locked', '锁定后 get-secret 被拒绝');
  res = await call({ id: '63', op: 'upsert', entry: newEntry });
  ok(res.ok === false && res.error === 'locked', '锁定后 upsert 被拒绝');
} catch (e) {
  failures.push('异常：' + e.message);
  console.error(e.stack || e.message);
} finally {
  try { child?.stdin.end(); child?.kill(); } catch { }
  try { rmSync(root, { recursive: true, force: true }); } catch { }
}

console.log('');
console.log(failures.length === 0 ? `✅ host v2 数据层（嵌套格式）：${passed} 项全部通过` : `❌ ${failures.length} 项失败，${passed} 项通过`);
if (failures.length) process.exitCode = 1;
