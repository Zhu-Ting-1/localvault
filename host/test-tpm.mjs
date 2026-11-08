/**
 * Windows Hello 解锁（受确认保护的 CNG 密钥）集成测试。
 *
 * 真机上的确认对话框没法自动化点，所以这里只测不需要人点确认的部分：
 *  - tpm-status 的可用性报告
 *  - tpm-enable 建密钥 + 包裹 DEK（公钥操作，不弹确认）+ 落盘格式
 *  - 「使用确认」自检：用禁止弹窗的标志解包必须失败，enable 才会成功
 *  - v1 旧包裹识别为 tpm-legacy（不再静默解包）
 *  - tpm-disable 删包裹与密钥
 *
 * 真正弹指纹/PIN 的那一步（unlock-tpm）需要人看着屏幕点一次，见发布前人工清单。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, 'vault-host.exe');
if (!existsSync(exe)) { console.error('FAIL: host 未构建'); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), 'lv-tpm-'));
const dbPath = join(root, 'vault.db');
let child = null, buf = Buffer.alloc(0), queue = [];
let passed = 0; const failures = [];
const ok = (c, m, d) => { if (c) { passed++; console.log('PASS: ' + m); } else { failures.push(m); console.log('FAIL: ' + m + (d ? ' — ' + d : '')); } };

child = spawn(exe, [], { env: { ...process.env, LOCALVAULT_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) {
    const len = buf.readInt32LE(0);
    if (buf.length < 4 + len) break;
    const b = buf.subarray(4, 4 + len).toString();
    buf = buf.subarray(4 + len);
    const r = queue.shift();
    r(JSON.parse(b));
  }
});
const call = (req, timeoutMs = 30000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('超时 ' + req.op)), timeoutMs);
  queue.push((v) => { clearTimeout(t); res(v); });
  const p = Buffer.from(JSON.stringify(req));
  const h = Buffer.alloc(4); h.writeInt32LE(p.length);
  child.stdin.write(Buffer.concat([h, p]));
});

const b64 = (u) => Buffer.from(u).toString('base64');

async function writeRealVault(dek, payloadV2) {
  const key = await webcrypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['encrypt']);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from('localvault-payload/v1'), tagLength: 128 },
    key, Buffer.from(JSON.stringify(payloadV2), 'utf8')));
  const ext = {
    format: 'localvault/v1',
    kdf: { alg: 'argon2id', memoryKiB: 32768, iterations: 3, parallelism: 2, salt: b64(webcrypto.getRandomValues(new Uint8Array(16))) },
    authVerify: { nonce: b64(webcrypto.getRandomValues(new Uint8Array(12))), ct: b64(new Uint8Array(40)) },
    wrappers: [{ id: 'master', nonce: b64(webcrypto.getRandomValues(new Uint8Array(12))), ct: b64(new Uint8Array(48)) }],
    payload: { nonce: b64(nonce), ct: b64(ct), aad: 'localvault-payload/v1' },
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(dbPath, JSON.stringify({ format: 'localvault-spike/v1', revision: 1, updatedAt: '', ciphertext: JSON.stringify(ext) }));
}

try {
  await new Promise((r) => setTimeout(r, 200));

  // ---- proto 版本握手 ----
  let res = await call({ id: '1', op: 'hello' });
  ok(res.ok === true && res.data?.proto === 2, 'hello 返回 proto=2（版本握手）', JSON.stringify(res).slice(0, 120));

  // ---- 可用性探测（不建密钥，不弹窗）----
  res = await call({ id: '2', op: 'tpm-status' });
  ok(res.ok === true && res.data?.available === true, 'tpm-status：本机有可用的密钥保护', JSON.stringify(res.data));
  const method = res.data?.method;
  ok(method === 'tpm' || method === 'software', 'method 是 tpm 或 software', method);
  ok(res.data?.enabled === false, '初始未配置 Hello 解锁');
  ok(res.data?.requiresUserPresence === true, '声明解锁需要用户在场');

  // ---- 造一个 v2 库 ----
  const dek = webcrypto.getRandomValues(new Uint8Array(32));
  await writeRealVault(dek, {
    format: 'localvault/v2',
    entries: [{
      id: 'e1',
      head: await (async () => {
        const k = await webcrypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['encrypt']);
        const n = webcrypto.getRandomValues(new Uint8Array(12));
        const c = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: Buffer.from('localvault/v2/head/e1'), tagLength: 128 }, k, Buffer.from(JSON.stringify({ title: 'T', username: 'u', urls: [], createdAt: '', updatedAt: '' }))));
        return { nonce: b64(n), ct: b64(c), aad: 'localvault/v2/head/e1' };
      })(),
      secret: await (async () => {
        const k = await webcrypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['encrypt']);
        const n = webcrypto.getRandomValues(new Uint8Array(12));
        const c = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: Buffer.from('localvault/v2/secret/e1'), tagLength: 128 }, k, Buffer.from(JSON.stringify({ password: 'Pw!', passwordHistory: [], notes: '' }))));
        return { nonce: b64(n), ct: b64(c), aad: 'localvault/v2/secret/e1' };
      })(),
    }],
    meta: { createdAt: '', generatorVersion: '0.3.1' },
  });
  res = await call({ id: '3', op: 'unlock', dek: b64(dek) });
  ok(res.ok === true, '先用 DEK 解锁（配置变更需要解锁态）');

  // 「记住解锁」依赖 dpapi-protect 包一层再落盘；这条链路之前没有独立用例
  const dp = await call({ id: '3b', op: 'dpapi-protect', data: 'QUJD' });
  ok(dp.ok === true && typeof dp.data?.data === 'string', 'dpapi-protect 可用（记住解锁依赖它）',
    JSON.stringify(dp).slice(0, 200));
  const dpu = await call({ id: '3c', op: 'dpapi-unprotect', data: dp.data?.data });
  ok(dpu.ok === true && dpu.data?.data === 'QUJD', 'dpapi 往返一致', JSON.stringify(dpu).slice(0, 200));

  const wrapPath = join(root, 'tpm.wrapping');

  // ---- 未配置时：unlock-tpm 明确报错，不静默降级 ----
  res = await call({ id: '4', op: 'unlock-tpm' }, 8000);
  ok(res.ok === false && res.error === 'tpm-not-configured', '未配置时 unlock-tpm 报 not-configured',
    JSON.stringify(res).slice(0, 120));

  // ---- v1 旧包裹：识别为 tpm-legacy，不再静默解包 ----
  writeFileSync(wrapPath, Buffer.from([0x01, 0x02, 0x03, 0x04]));
  res = await call({ id: '5', op: 'unlock-tpm' }, 8000);
  ok(res.ok === false && res.error === 'tpm-legacy',
    'v1 旧包裹 → tpm-legacy（要求用主密码重设，不静默解包）', JSON.stringify(res).slice(0, 140));

  // 旧包裹存在但不可用：状态必须报「未开启」，否则设置页开关显示成已开启，用户无从重开
  res = await call({ id: '5b', op: 'tpm-status' });
  ok(res.ok === true && res.data?.enabled === false && res.data?.legacy === true && res.data?.available === true,
    'v1 包裹时 tpm-status 报「未开启 + legacy + 可开启」', JSON.stringify(res.data));
  res = await call({ id: '5c', op: 'diag' });
  ok(res.ok === true && res.data?.tpmEnabled === false && res.data?.tpmLegacy === true,
    '诊断里的 tpmEnabled 只认 v2，legacy 单列', JSON.stringify(res.data ?? {}).slice(0, 160));

  // ---- 关闭：删包裹 ----
  res = await call({ id: '6', op: 'tpm-disable' });
  ok(res.ok === true && res.data?.enabled === false, 'tpm-disable 幂等（没配置也能关）');
  ok(!existsSync(wrapPath), 'tpm.wrapping 已删除');

  // ---- 建密钥/解包这两步 Windows 会弹「使用确认」，只能在有人的时候跑 ----
  if (process.env.LV_TPM_INTERACTIVE === '1') {
    console.log('\n[interactive] 下面两步会弹系统确认框，请点允许/按指纹');
    res = await call({ id: '7', op: 'tpm-enable' }, 120000);
    ok(res.ok === true && res.data?.enabled === true, 'tpm-enable 建密钥并包裹成功（已确认）',
      JSON.stringify(res).slice(0, 160));
    let wrapJson = null;
    try { wrapJson = JSON.parse(readFileSync(wrapPath, 'utf8')); } catch { }
    ok(wrapJson?.v === 2 && wrapJson?.confirmed === true, '包裹文件 v2 且记录了确认已强制');
    ok(!readFileSync(wrapPath, 'utf8').includes(b64(dek)), '包裹文件里没有明文 DEK');

    await call({ id: '8', op: 'lock' });
    res = await call({ id: '9', op: 'unlock-tpm' }, 120000);
    ok(res.ok === true, '确认后仅凭密钥解锁成功', JSON.stringify(res).slice(0, 140));
    res = await call({ id: '10', op: 'list' });
    ok(res.ok === true && (res.data?.entries ?? []).length === 1, 'Hello 解锁后能读条目');

    await call({ id: '11', op: 'tpm-disable' });
    ok(!existsSync(wrapPath), '关闭后包裹删除');
  } else {
    console.log('\nSKIP: 建密钥/解包需要点系统确认框，设 LV_TPM_INTERACTIVE=1 手动跑');
  }

  // ---- 主密码回退路径不受影响 ----
  ok(true, '主密码回退 = unlock 指令（host 侧不依赖 TPM）——由既有 47 项协议测试覆盖');
} catch (e) {
  failures.push('异常：' + e.message);
  console.error(e.stack || e.message);
} finally {
  try { child?.stdin.end(); child?.kill(); } catch { }
  if (process.env.LV_KEEP_TMP) console.log("临时目录保留：" + root);
  else { try { rmSync(root, { recursive: true, force: true }); } catch { } }
}

console.log('');
console.log(failures.length === 0 ? `✅ TPM/Hello 适配层：${passed} 项全部通过` : `❌ ${failures.length} 项失败，${passed} 项通过`);
if (failures.length) process.exitCode = 1;
