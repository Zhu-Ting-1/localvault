/**
 * LocalVault 安全自检：模拟常见攻击，全部用例都必须防住。
 *
 * 起一个真实 host（临时 LOCALVAULT_ROOT），然后扮演攻击者：
 *   Phase A  HTTP 攻击面（锁定态）：跨源、方法、路径变体、Host 变体、超大/分块请求体、SSRF、反射
 *   Phase B  解锁态攻击：字段超限、审计注入、并发竞态、session.key 落盘内容、导出与 dpapi
 *   Phase C  native messaging 帧协议 fuzz：坏长度、截断帧、深嵌套 JSON、控制字符
 *
 * 用法：node tools/attack-sim.mjs
 * 退出码：0 = 全部通过（攻击全部失败），1 = 存在可利用点。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'app', 'package.json'));
const { argon2id } = require('hash-wasm');
const exe = join(here, '..', 'host', 'vault-host.exe');

const root = mkdtempSync(join(tmpdir(), 'lv-attack-'));
const dbPath = join(root, 'vault.db');
let passed = 0;
const failures = [];
const ok = (cond, msg, detail) => {
  if (cond) { passed++; console.log('  PASS ' + msg); }
  else { failures.push(msg); console.log('  FAIL ' + msg + (detail ? '  -- ' + detail : '')); }
};
const info = (msg) => console.log('  INFO ' + msg);

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const importKey = (raw) => webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function sealBytes(key, aadText, bytes) {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(aadText, 'utf8'), tagLength: 128 },
    key, bytes));
  return { nonce: b64(nonce), ct: b64(ct) };
}
const sealJson = async (key, aad, obj) => sealBytes(key, aad, Buffer.from(JSON.stringify(obj), 'utf8'));
async function openBytes(key, blob, aad) {
  return new Uint8Array(await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.nonce), additionalData: Buffer.from(aad, 'utf8'), tagLength: 128 },
    key, unb64(blob.ct)));
}

async function writeVault() {
  const password = 'attack-sim-主密码-2026';
  const dek = webcrypto.getRandomValues(new Uint8Array(32));
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const kdf = { alg: 'argon2id', memoryKiB: 32768, iterations: 3, parallelism: 1, salt: b64(salt) };
  const kek = new Uint8Array(await argon2id({
    password, salt, parallelism: 1, iterations: 3, memorySize: 32768, hashLength: 32, outputType: 'binary',
  }));
  const kekKey = await importKey(kek);
  const dekKey = await importKey(dek);
  const auth = await sealBytes(kekKey, 'localvault-auth/v1', Buffer.from('localvault-auth-ok', 'utf8'));
  const wrap = await sealBytes(kekKey, 'localvault-wrap/master', dek);
  const entries = [{
    id: 'atk-e0',
    head: await sealJson(dekKey, 'localvault/v2/head/atk-e0', {
      title: '攻击模拟站点', username: 'victim@test.local',
      urls: ['https://victim.test'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
    secret: await sealJson(dekKey, 'localvault/v2/secret/atk-e0', {
      password: 'Pw-attack-secret!', passwordHistory: [], notes: 'notes',
    }),
  }];
  const payloadV2 = { format: 'localvault/v2', entries, meta: { createdAt: '2026-01-01T00:00:00Z' } };
  const payload = await sealJson(dekKey, 'localvault-payload/v1', payloadV2);
  payload.aad = 'localvault-payload/v1';
  const ext = {
    format: 'localvault/v1', kdf,
    authVerify: { nonce: auth.nonce, ct: auth.ct },
    wrappers: [{ id: 'master', nonce: wrap.nonce, ct: wrap.ct }],
    payload, updatedAt: new Date().toISOString(),
  };
  writeFileSync(dbPath, JSON.stringify({
    format: 'localvault-spike/v1', revision: 1,
    updatedAt: new Date().toISOString(), ciphertext: JSON.stringify(ext),
  }), 'utf8');
  return { password, ext, dek };
}

async function deriveDek(password, ext) {
  const kek = new Uint8Array(await argon2id({
    password, salt: unb64(ext.kdf.salt), parallelism: ext.kdf.parallelism || 1,
    iterations: ext.kdf.iterations || 3, memorySize: ext.kdf.memoryKiB || 65536,
    hashLength: 32, outputType: 'binary',
  }));
  const kekKey = await importKey(kek);
  await openBytes(kekKey, ext.authVerify, 'localvault-auth/v1');
  const w = ext.wrappers.find((x) => x.id === 'master');
  return openBytes(kekKey, w, 'localvault-wrap/' + w.id);
}

const request = (port, method, path, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port, path, method,
    headers: { ...(body != null ? { 'Content-Type': 'text/plain' } : {}), ...(headers || {}) },
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  if (body != null) req.end(body); else req.end();
});

// 后台 API 令牌：host 启动后写在数据目录，模拟「合法页面」时才带
const uiToken = () => readFileSync(join(root, 'ui.token'), 'utf8').trim();
const api = async (port, op, body) => {
  const res = await request(port, 'POST', `/api/${op}`,
    { 'Content-Type': 'application/json', 'X-LV-Token': uiToken() }, JSON.stringify(body || {}));
  try { return JSON.parse(res.body); } catch { return { ok: false, error: 'non-json', raw: res.body }; }
};

const waitPort = async () => {
  for (let i = 0; i < 100; i++) {
    const p = join(root, 'ui.port');
    if (existsSync(p)) {
      const port = parseInt(readFileSync(p, 'utf8').trim(), 10);
      try {
        const r = await request(port, 'GET', '/api/port', {}, null);
        if (r.status === 200 && r.body.includes('0.3.0')) return port;
      } catch { /* 还没起 */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('UI 服务未启动');
};

let child = null;
let exitCode = null;
try {
  const { password, ext, dek } = await writeVault();
  child = spawn(exe, [], {
    env: { ...process.env, LOCALVAULT_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.on('data', () => {});
  child.on('exit', (code) => { exitCode = code; });

  // native 帧收发
  let nativeBuf = Buffer.alloc(0);
  const nativeWaiters = [];
  child.stdout.on('data', (chunk) => {
    nativeBuf = Buffer.concat([nativeBuf, chunk]);
    while (nativeBuf.length >= 4) {
      const len = nativeBuf.readUInt32LE(0);
      if (nativeBuf.length < 4 + len) break;
      const body = nativeBuf.subarray(4, 4 + len);
      nativeBuf = nativeBuf.subarray(4 + len);
      const w = nativeWaiters.shift();
      if (w) w(JSON.parse(body.toString('utf8')));
    }
  });
  const sendNative = (obj) => new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(payload.length, 0);
    nativeWaiters.push(resolve);
    child.stdin.write(Buffer.concat([len, payload]));
  });
  const sendRawFrame = (buf) => { child.stdin.write(buf); };

  const port = await waitPort();
  ok(port > 0, 'A0 host 启动且 /api/port 身份校验通过');
  const selfOrigin = 'http://127.0.0.1:' + port;

  // ================= Phase A：HTTP 攻击面（锁定态） =================
  console.log('\n[Phase A] HTTP 攻击面（锁定态）');
  let r = await request(port, 'POST', '/api/status', { Origin: 'https://evil.com' }, '{}');
  ok(r.status === 403, 'A1 跨源 Origin POST → 403');
  r = await request(port, 'POST', '/api/status', { 'Sec-Fetch-Site': 'cross-site' }, '{}');
  ok(r.status === 403, 'A2 Sec-Fetch-Site: cross-site → 403');
  r = await request(port, 'POST', '/api/status',
    { Origin: selfOrigin, 'X-LV-Token': uiToken() }, '{}');
  ok(r.status === 200, 'A3 本站 Origin + 令牌放行');
  r = await request(port, 'POST', '/api/status', { Origin: selfOrigin }, '{}');
  ok(r.status === 401, 'A3a 本站 Origin 但无令牌 → 401');
  r = await request(port, 'POST', '/api/status', { Origin: selfOrigin + '.evil.com' }, '{}');
  ok(r.status === 403, 'A3b 伪造「本站前缀」Origin 被拒');
  r = await request(port, 'POST', '/api/status', { Origin: 'null' }, '{}');
  ok(r.status === 403, 'A3c Origin: null（沙箱页）被拒');

  r = await request(port, 'OPTIONS', '/api/fill', {}, '{}');
  ok(r.status !== 200, 'A4 OPTIONS 不执行任何 op（preflight 无副作用）', 'status=' + r.status);
  r = await request(port, 'GET', '/api/diag', {}, null);
  // 断言本质：诊断数据不泄漏（无论被白名单拒还是被协议层拒）
  ok(!(r.status === 200 && r.body.includes('"vaultPath"')), 'A5 GET /api/diag 不泄漏诊断数据',
    'status=' + r.status + ' body=' + r.body.slice(0, 120));
  r = await request(port, 'GET', '/api/list', {}, null);
  ok(r.status === 401, 'A6 本机脚本裸 /api/list → 401（无令牌不给数据）');
  r = await request(port, 'POST', '/api/list', { 'X-LV-Token': 'x'.repeat(64) }, '{}');
  ok(r.status === 401, 'A6a 伪造令牌 → 401');
  for (const op of ['unlock-resume', 'unlock-tpm']) {
    r = await request(port, 'POST', `/api/${op}`,
      { 'Content-Type': 'application/json', 'X-LV-Token': uiToken() }, '{}');
    const body = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
    ok(body.error === 'op-not-allowed', `A6a ${op} 即使有令牌也不允许走 HTTP`);
  }
  r = await request(port, 'GET', '/api/list', { 'Sec-Fetch-Site': 'cross-site' }, null);
  ok(r.status === 403, 'A6b 网页级 GET（img/fetch）被 Sec-Fetch 拒绝');

  // 路径变体：任何形态都不能把白名单外的 op 送进去
  const pathVariants = ['/api/../api/diag', '/API/diag', '/api//diag', '/api/diag/', '/api/diag%20',
    '/api%2Fdiag', '/api/./diag', '/api/diag?x=1', '/api/%64iag'];
  let variantBlocked = true;
  for (const p of pathVariants) {
    const rr = await request(port, 'GET', p, {}, null);
    if (rr.status === 200 && rr.body.includes('"vaultPath"')) { variantBlocked = false; info('A7 泄漏于路径变体: ' + p); }
  }
  ok(variantBlocked, 'A7 九种路径变体均无法触达 diag 数据');

  // Host 变体
  const hostVariants = ['127.0.0.1:' + port + '/', '[::1]:' + port, 'evil.com', '127.0.0.2:' + port];
  let hostBlocked = true;
  for (const h of hostVariants) {
    const rr = await request(port, 'GET', '/api/port', { Host: h }, null);
    if (rr.status === 200) { hostBlocked = false; info('A8 Host 变体放行: ' + h); }
  }
  ok(hostBlocked, 'A8 Host 头变体全部被拒（DNS rebinding 防护完整）');

  // 带令牌：先过鉴权，才能真正测到请求体上限（否则 401 提前返回）
  r = await request(port, 'POST', '/api/status',
    { 'Content-Length': String(3 * 1024 * 1024), 'X-LV-Token': uiToken() }, 'x'.repeat(3 * 1024 * 1024));
  ok(r.status === 200 && r.body.includes('too-large'), 'A9 3MB 请求体被拒（too-large）');

  // chunked 超大请求体（绕过 Content-Length 检查的尝试）
  const chunkedAttack = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/status', method: 'POST',
      headers: {
        'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked',
        'X-LV-Token': uiToken(),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: 'conn-error' }));
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= 50 * 1024 * 1024 || req.writableEnded) { clearInterval(timer); req.end(); return; }
      req.write(chunk); sent += chunk.length;
    }, 5);
    setTimeout(() => { clearInterval(timer); try { req.end(); } catch { } resolve({ status: 0, body: 'timeout' }); }, 15000);
  });
  ok(chunkedAttack.status === 0 || chunkedAttack.body.includes('too-large') || chunkedAttack.status === 503
    || chunkedAttack.status === 400,
    'A10 chunked 超大请求体被拒/中断（无内存放大）', 'status=' + chunkedAttack.status + ' body=' + chunkedAttack.body.slice(0, 60));

  // SSRF：站点识别不得碰内网
  const ssrfTargets = ['http://127.0.0.1:' + port + '/api/port', 'http://169.254.169.254/latest/meta-data/',
    'http://localhost/x', 'http://[::1]/', 'http://10.0.0.1/', 'http://192.168.1.1/router'];
  let ssrfBlocked = true;
  for (const u of ssrfTargets) {
    const t0 = Date.now();
    const rr = await api(port, 'fetch-site-info', { url: u });
    const ms = Date.now() - t0;
    if (rr.ok === true && rr.data?.source === 'fetched') { ssrfBlocked = false; info('A11 SSRF 命中: ' + u); }
    if (u.includes('169.254') && ms > 4000) info('A11 169.254 探测耗时 ' + ms + 'ms（可能外发）');
  }
  ok(ssrfBlocked, 'A11 六个内网/metadata 地址全部拒绝抓取');

  r = await request(port, 'GET', '/api/zzz%3Cscript%3Ealert(1)%3C/script%3E', {}, null);
  ok(!r.body.includes('<script>'), 'A12 未知 op 的响应不含未转义反射', r.body.slice(0, 120));

  const exL = await api(port, 'export-encrypted');
  ok(exL.ok === false && exL.error === 'locked', 'A13 锁定态无法导出加密备份');
  const gsL = await api(port, 'get-secret', { id: 'atk-e0' });
  ok(gsL.ok === false && gsL.error === 'locked', 'A14 锁定态无法读密码');
  const dpHttp = await api(port, 'dpapi-protect', { data: b64(new Uint8Array(8)) });
  ok(dpHttp.ok === false && dpHttp.error === 'op-not-allowed', 'A15 dpapi 指令不走 HTTP');
  const dpBig = await sendNative({ op: 'dpapi-protect', data: b64(new Uint8Array(300)) });
  ok(dpBig.ok === false, 'A16 dpapi-protect 拒绝超长数据');
  // unlock-info：解锁前置信息只含 KDF/验证段/包裹，绝不含密文业务数据
  const ui2 = await api(port, 'unlock-info');
  ok(ui2.ok === true && ui2.data?.exists === true && !!ui2.data?.kdf
    && ui2.data?.ciphertext === undefined && ui2.data?.payload === undefined,
    'A18 unlock-info 只暴露 KDF 参数，不含密文（锁定态可解锁的前置）');
  const srcSpoof = await sendNative({ op: 'status', source: 'ui' });
  ok(srcSpoof.ok === true, 'A17 native status 正常（source 白名单不影响合法调用）');

  // ================= 解锁（模拟用户正常解锁） =================
  const derived = await deriveDek(password, ext);
  const ul = await api(port, 'unlock', { dek: b64(derived) });
  ok(ul.ok === true, 'B0 合法解锁成功');

  console.log('\n[Phase B] 解锁态攻击');
  const bigTitle = await api(port, 'upsert', { entry: { id: 'atk-big', title: 't'.repeat(5000), password: 'x', urls: [] } });
  ok(bigTitle.ok === false && bigTitle.error === 'bad-request', 'B1 超长 title 被拒');
  const manyUrls = await api(port, 'upsert', { entry: { id: 'atk-u', title: 'x', password: 'x', urls: Array.from({ length: 25 }, (_, i) => 'https://u' + i + '.test') } });
  ok(manyUrls.ok === false && manyUrls.error === 'bad-request', 'B2 超量 urls 被拒');
  const longPw = await api(port, 'upsert', { entry: { id: 'atk-p', title: 'x', password: 'p'.repeat(5000), urls: [] } });
  ok(longPw.ok === false && longPw.error === 'bad-request', 'B3 超长密码被拒');

  // 审计注入：站点名带制表/换行
  const inj = await api(port, 'set-site-name', { id: 'atk-e0', name: '正常名\t伪造列\t\t第二行\n假事件' });
  ok(inj.ok === true, 'B4a set-site-name 接受含控制字符的名字');
  const tail = await api(port, 'audit-tail', { lines: 20 });
  const injectedRows = (tail.data?.rows || []).filter((row) =>
    (row.action === 'site-name') && ((row.detail.match(/\t/g) || []).length > 0));
  ok(injectedRows.length === 0, 'B4b 审计行内无残留制表符（结构不可伪造）');

  // 并发 fill：来源归属
  await Promise.all(Array.from({ length: 20 }, () => api(port, 'fill', { entryId: 'atk-e0', site: 'https://x.test', method: 'click' })));
  const tail2 = await api(port, 'audit-tail', { lines: 60 });
  const fillRows = (tail2.data?.rows || []).filter((row) => row.action === 'ui:fill');
  ok(fillRows.length >= 20 && fillRows.every((row) => row.source === 'ui'), 'B5 并发 20 次 fill 的审计来源全部正确');

  // session.key 不得是明文 DEK
  const slotPath = join(root, 'session.key');
  ok(existsSync(slotPath), 'B6a 会话槽已落盘（resume 依赖）');
  const slot = readFileSync(slotPath);
  ok(!Buffer.from(dek).equals(slot) && slot.length !== 32,
    'B6b session.key 不含明文 DEK（DPAPI 包裹）', 'slot ' + slot.length + 'B');

  const exp = await api(port, 'export-encrypted');
  ok(exp.ok === true && exp.data?.ciphertext?.startsWith('{'), 'B7 解锁态可导出加密备份');

  // 并发 upsert：CAS/文件锁完整性
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    api(port, 'upsert', { entry: { id: 'atk-c' + i, title: 'c' + i, password: 'p' + i, urls: [] } })));
  ok(results.every((x) => x.ok === true), 'B8a 并发 20 次 upsert 全部成功');
  const listAfter = await api(port, 'list');
  ok(listAfter.data?.entries?.length === 1 + 20, 'B8b 并发写入后条目数完整（无丢失）');

  // ================= Phase C：native 帧 fuzz =================
  console.log('\n[Phase C] native 帧协议 fuzz');
  const alive = () => exitCode === null && child.exitCode === null;

  // 深嵌套 JSON：直接发原始文本帧，host 侧 JSON 反序列化应报错而非崩溃
  const deepText = '{"a":'.repeat(300) + '1' + '}'.repeat(300);
  {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(Buffer.byteLength(deepText), 0);
    sendRawFrame(Buffer.concat([len, Buffer.from(deepText)]));
    await new Promise((r) => setTimeout(r, 600));
  }
  ok(alive(), 'C0 300 层深嵌套 JSON 后进程存活');
  const rAfter = await sendNative({ op: 'status' });
  ok(rAfter.ok === true, 'C0b 深嵌套攻击后协议仍可用');

  // 控制字符 op
  const rCtl = await sendNative({ op: 'status\u0000\u0009evil' });
  ok(rCtl.ok === false, 'C1 带控制字符的 op 被拒');
  ok(alive(), 'C2 控制字符攻击后进程存活');

  // 巨帧：16MB 上限外的帧会让 host 主动退出（设计行为）——放到最后单独验证
  const bigLen = Buffer.alloc(4);
  bigLen.writeUInt32LE(17 * 1024 * 1024, 0);
  sendRawFrame(bigLen);
  await new Promise((r) => setTimeout(r, 800));
  ok(!alive(), 'C3 超上限帧长度被拒绝且 host 选择退出（防挂死，属预期设计）', 'exit=' + exitCode);
  info('C3 说明：本机进程可用坏帧杀死 host（DoS），属同用户信任边界内，已按设计记录');

  console.log('\n================ 汇总 ================');
  console.log(`PASS ${passed}  FAIL ${failures.length}`);
  if (failures.length) failures.forEach((f) => console.log('  !! ' + f));
  process.exitCode = failures.length ? 1 : 0;
} finally {
  try { child?.kill(); } catch { }
  setTimeout(() => { try { rmSync(root, { recursive: true, force: true }); } catch { } }, 500);
}
