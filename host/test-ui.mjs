/**
 * 本地管理后台端到端测试（回环 HTTP 服务 + 浏览器侧主密码解锁）。
 *
 * 模拟真实用户场景：只双击打开后台（不通过扩展、不发 native messaging 指令），
 * 用主密码解锁 → 读条目 → 审计日志。host 进程只靠 stdin 保持存活。
 *
 * 关键验证：
 *  - HTTP 服务能在非管理员下绑 127.0.0.1 并写出 ui.port
 *  - Host 头校验（DNS rebinding 防护）
 *  - /argon2.js 可访问（内嵌自包含 wasm）
 *  - 后台页面用的解锁算法（Argon2id → KEK → authVerify → wrapper → DEK）
 *    造出的库能被 host 的 v2 数据层正确解开
 *  - status / read / list / get-secret / audit-tail 全走 HTTP 可用
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'app', 'package.json'));
const { argon2id } = require('hash-wasm');
const exe = join(here, 'vault-host.exe');
if (!existsSync(exe)) { console.error('FAIL: host 未构建'); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), 'lv-ui-'));
const dbPath = join(root, 'vault.db');
let passed = 0;
const failures = [];
const ok = (c, m, d) => {
  if (c) { passed++; console.log('PASS: ' + m); }
  else { failures.push(m); console.log('FAIL: ' + m + (d ? ' -- ' + d : '')); }
};

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
const sealJson = (key, aad, obj) => sealBytes(key, aad, Buffer.from(JSON.stringify(obj), 'utf8'));
async function openBytes(key, blob, aad) {
  return new Uint8Array(await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.nonce), additionalData: Buffer.from(aad, 'utf8'), tagLength: 128 },
    key, unb64(blob.ct)));
}

/** 造一份「主密码真实可解」的三层嵌套 vault.db，与扩展格式完全一致。 */
async function writeVault() {
  const password = '后台解锁测试-主密码-2026';
  const dek = webcrypto.getRandomValues(new Uint8Array(32));
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const kdf = { alg: 'argon2id', memoryKiB: 32768, iterations: 3, parallelism: 1, salt: b64(salt) };

  const kek = new Uint8Array(await argon2id({
    password, salt, parallelism: 1, iterations: 3, memorySize: 32768,
    hashLength: 32, outputType: 'binary',
  }));
  const kekKey = await importKey(kek);
  const dekKey = await importKey(dek);

  const auth = await sealBytes(kekKey, 'localvault-auth/v1', Buffer.from('localvault-auth-ok', 'utf8'));
  const wrap = await sealBytes(kekKey, 'localvault-wrap/master', dek);

  const entries = [];
  for (let i = 0; i < 2; i++) {
    const id = 'ui-e' + i;
    entries.push({
      id,
      head: await sealJson(dekKey, `localvault/v2/head/${id}`, {
        title: '测试站点 ' + i, username: `user${i}@test.local`,
        urls: [`https://site${i}.test`],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
      }),
      secret: await sealJson(dekKey, `localvault/v2/secret/${id}`, {
        password: `Pw-${i}-secret!`, passwordHistory: [], notes: '备注 ' + i,
      }),
    });
  }
  const payloadV2 = {
    format: 'localvault/v2', entries,
    meta: { createdAt: '2026-01-01T00:00:00Z', generatorVersion: '0.3.2' },
  };
  const payload = await sealJson(dekKey, 'localvault-payload/v1', payloadV2);
  payload.aad = 'localvault-payload/v1'; // 真实 envelope 里 payload 段自带 aad

  const ext = {
    format: 'localvault/v1', kdf,
    authVerify: { nonce: auth.nonce, ct: auth.ct },
    wrappers: [{ id: 'master', nonce: wrap.nonce, ct: wrap.ct }],
    payload,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(dbPath, JSON.stringify({
    format: 'localvault-spike/v1', revision: 1,
    updatedAt: new Date().toISOString(), ciphertext: JSON.stringify(ext),
  }), 'utf8');
  return { password, ext, dek };
}

/** 模拟后台页面 unlockWithPassword()：只吃 envelope + 主密码，产出 DEK。 */
async function deriveDekLikeUi(password, ext) {
  const salt = unb64(ext.kdf.salt);
  const kek = new Uint8Array(await argon2id({
    password, salt,
    parallelism: ext.kdf.parallelism || 1,
    iterations: ext.kdf.iterations || 3,
    memorySize: ext.kdf.memoryKiB || 65536,
    hashLength: 32, outputType: 'binary',
  }));
  const kekKey = await importKey(kek);
  await openBytes(kekKey, ext.authVerify, 'localvault-auth/v1');
  const w = ext.wrappers.find((x) => x.id === 'master');
  return openBytes(kekKey, w, 'localvault-wrap/' + w.id);
}

// 后台 API 要令牌：host 启动时写在数据目录 ui.token
const uiToken = () => readFileSync(join(root, 'ui.token'), 'utf8').trim();
const api = async (port, op, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LV-Token': uiToken() },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) return { ok: false, error: 'unauthorized' };
  return res.json();
};
const waitPort = async () => {
  for (let i = 0; i < 60; i++) {
    const p = join(root, 'ui.port');
    if (existsSync(p)) return parseInt(readFileSync(p, 'utf8').trim(), 10);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('UI 服务未启动：ui.port 未生成（HttpListener 可能被 URL ACL 拦下）');
};
const rawGet = (port, path, hostHeader) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port, path, method: 'GET',
    headers: hostHeader ? { Host: hostHeader } : {},
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  req.end();
});
// GET 且带响应头：用于校验 CSP / nosniff 这类「只在浏览器里才生效」的设置
const rawGetH = (port, path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on('error', reject);
  req.end();
});
// POST 且可自定义请求头：模拟「恶意网页的跨源简单请求」
const rawPost = (port, path, headers, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(body ?? '{}');
  const req = http.request({
    host: '127.0.0.1', port, path, method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': data.length, ...(headers || {}) },
  }, (res) => {
    let out = '';
    res.on('data', (c) => { out += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: out }));
  });
  req.on('error', reject);
  req.end(data);
});

let child = null;
try {
  const { password, ext, dek } = await writeVault();
  child = spawn(exe, [], {
    env: { ...process.env, LOCALVAULT_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {}); // native messaging 通道不用，UI 走 HTTP（dpapi 测试除外，见下）

  // native messaging 帧协议（4 字节 LE 长度 + JSON）：dpapi 指令只走这条通道，不走 HTTP 白名单
  let nativeBuf = Buffer.alloc(0);
  const nativeWaiters = [];
  child.stdout.removeAllListeners('data');
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

  const port = await waitPort();
  ok(port > 0, '后台服务启动并写出 ui.port（端口 ' + port + '）');

  let r = await rawGet(port, '/');
  ok(r.status === 200 && r.body.includes('LocalVault 管理后台'), 'GET / 返回管理页');
  ok(r.body.includes('/argon2.js'), '管理页引用内嵌 Argon2 模块');
  ok(r.body.includes('/favicon.svg'), '管理页引用同款 favicon');

  r = await rawGet(port, '/favicon.svg');
  ok(r.status === 200 && r.body.includes('<svg') && r.body.includes('#2f95ff'),
    'GET /favicon.svg 返回「保险库转盘」图标（' + r.body.length + ' 字节）');

  r = await rawGet(port, '/argon2.js');
  ok(r.status === 200 && r.body.includes('argon2id'), 'GET /argon2.js 返回自包含 Argon2（' + r.body.length + ' 字节）');

  // 内嵌 JS 语法体检：避免「编译过了但浏览器里一打开就白屏」
  const inline = [...(await rawGet(port, '/')).body.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
  ok(inline.length === 1, '管理页恰好一段内联脚本');
  try { new vm.Script(inline[0] || ''); ok(true, '内联 JS 语法合法'); }
  catch (e) { ok(false, '内联 JS 语法合法', e.message); }

  // CSP 回归：后台页要加载外部 /argon2.js，script-src 必须含 'self'；
  // Argon2 是 wasm，必须含 'wasm-unsafe-eval'；frame-ancestors 只能在响应头里生效。
  const pageRes = await rawGetH(port, '/');
  const csp = String(pageRes.headers['content-security-policy'] || '');
  ok(csp.includes("script-src 'self'"), 'CSP 允许同源脚本（否则 /argon2.js 被挡）', csp);
  ok(csp.includes("'wasm-unsafe-eval'"), 'CSP 允许 wasm（Argon2）', csp);
  ok(csp.includes("frame-ancestors 'none'"), 'CSP 禁止被 iframe 嵌入（响应头）', csp);
  ok(!pageRes.body.includes('http-equiv'), '页面不再内嵌 meta CSP（避免与响应头取交集把自己挡了）');

  r = await rawGet(port, '/', 'evil.example.com');
  ok(r.status === 403, '非本机 Host 头被拒（DNS rebinding 防护）');

  // —— 跨源网页防护 ——
  r = await rawPost(port, '/api/status', { Origin: 'https://evil.com' });
  ok(r.status === 403, '跨源 Origin 的 POST 被 403 拒绝');
  r = await rawPost(port, '/api/status', { 'Sec-Fetch-Site': 'cross-site' });
  ok(r.status === 403, 'Sec-Fetch-Site: cross-site 被 403 拒绝');
  r = await rawPost(port, '/api/status', { Origin: 'http://127.0.0.1:' + port });
  ok(r.status === 401, '本站 Origin 但没令牌 → 401（同源不等于有凭据）');
  r = await rawPost(port, '/api/status',
    { Origin: 'http://127.0.0.1:' + port, 'X-LV-Token': uiToken() });
  ok(r.status === 200, '本站 Origin + 正确令牌正常放行');

  // —— 令牌门禁 ——
  r = await rawPost(port, '/api/list', {});
  ok(r.status === 401, '无令牌 /api/list → 401（一条 curl 拖库的路被堵死）');
  r = await rawPost(port, '/api/list', { 'X-LV-Token': 'deadbeef' });
  ok(r.status === 401, '错令牌 → 401');
  r = await rawPost(port, '/api/list', { 'X-LV-Token': uiToken().slice(0, 32) });
  ok(r.status === 401, '令牌前缀不算数（长度不同直接拒）');
  const tkFile = readFileSync(join(root, 'ui.token'), 'utf8').trim();
  ok(/^[0-9a-f]{64}$/.test(tkFile), '令牌是 32 字节随机十六进制');
  const resumeHttp = await api(port, 'unlock-resume');
  ok(resumeHttp.ok === false && resumeHttp.error === 'op-not-allowed',
    'unlock-resume 不允许走 HTTP（免密恢复只给扩展）');
  const tpmHttp = await api(port, 'unlock-tpm');
  ok(tpmHttp.ok === false && tpmHttp.error === 'op-not-allowed',
    'unlock-tpm 不允许走 HTTP（免密解锁只给扩展）');

  // —— v1 迁移/诊断指令退出后台白名单 ——
  const rdDenied = await api(port, 'read');
  ok(rdDenied.ok === false && rdDenied.error === 'op-not-allowed', 'read 不再允许后台调用');
  const dgDenied = await api(port, 'diag');
  ok(dgDenied.ok === false && dgDenied.error === 'op-not-allowed', 'diag 不再允许后台调用');
  const tdLocked = await api(port, 'tpm-disable');
  ok(tdLocked.ok === false && tdLocked.error === 'locked', '锁定态不能解除 TPM 保护');
  const exLocked = await api(port, 'export-encrypted');
  ok(exLocked.ok === false && exLocked.error === 'locked', '导出加密备份需要解锁态');

  let st = await api(port, 'status');
  ok(st.ok === true && st.data?.state === 'locked', '初始状态 locked');
  ok(st.data?.uiPort === port && !!st.data?.vaultPath, 'status 带端口与保险库路径');
  ok(typeof st.data?.buildAt === 'string' && st.data.buildAt.length >= 5, 'status 带界面构建时间 buildAt');
  ok(st.data?.payloadFormat == null, '锁定态不泄漏数据格式（payloadFormat 为 null）');

  const rd = await api(port, 'export-encrypted');
  ok(rd.ok === false && rd.error === 'locked', '锁定态不能导出加密备份（export-encrypted）');

  // 主密码解锁（与后台页面同构）
  const derived = await deriveDekLikeUi(password, ext);
  ok(Buffer.from(derived).equals(Buffer.from(dek)), '浏览器侧 Argon2id + GCM 解出的 DEK 正确');

  const ul = await api(port, 'unlock', { dek: b64(derived) });
  ok(ul.ok === true && ul.data?.entries === 2, '后台用主密码解锁成功', JSON.stringify(ul).slice(0, 140));

  st = await api(port, 'status');
  ok(st.data?.state === 'unlocked', '解锁态在后台可见（与扩展共享）');
  // 真实数据格式只在解锁态可见：信封 format 恒为 localvault/v1，v2 看 payloadFormat
  ok(st.data?.payloadFormat === 'localvault/v2', '解锁态可见真实数据格式 payloadFormat=v2',
    'status=' + JSON.stringify(st.data));
  ok(typeof st.data?.revision === 'number' && st.data.revision > 0, 'status 返回 revision');

  const list = await api(port, 'list');
  ok(list.ok === true && list.data?.entries?.length === 2, '后台列出 2 条条目');
  ok(!JSON.stringify(list.data).includes('Pw-0-secret!'), '列表不含明文密码');

  const sec = await api(port, 'get-secret', { id: 'ui-e0' });
  ok(sec.ok === true && sec.data?.password === 'Pw-0-secret!', '后台查看密码正确');

  // 站点中文名：内置映射 + 只改 head 不碰密码
  const site = await api(port, 'fetch-site-info', { url: 'https://github.com/login' });
  ok(site.ok === true && site.data?.name?.includes('GitHub'), '内置站点中文名映射生效');

  const setName = await api(port, 'set-site-name', {
    id: 'ui-e0', name: 'GitHub 代码托管', description: '全球最大的代码托管平台',
  });
  ok(setName.ok === true, 'set-site-name 写入中文名与解释');
  const list2 = await api(port, 'list');
  ok(list2.data?.entries?.[0]?.title === 'GitHub 代码托管'
    && list2.data?.entries?.[0]?.description === '全球最大的代码托管平台', '列表返回中文名与解释');
  const sec2 = await api(port, 'get-secret', { id: 'ui-e0' });
  ok(sec2.data?.password === 'Pw-0-secret!', '改站点名不会动密码');

  const wrong = await api(port, 'unlock', { dek: b64(new Uint8Array(32).fill(9)) });
  ok(wrong.ok === false, '错误 DEK 被 host 拒绝');

  // 加密备份：export-encrypted 替代 read，需解锁态
  const exp = await api(port, 'export-encrypted');
  ok(exp.ok === true && typeof exp.data?.ciphertext === 'string' && exp.data.ciphertext.startsWith('{'),
    'export-encrypted 返回加密信封（替代 read）');

  // DPAPI 包裹服务：「记住解锁」用的包裹/解包 roundtrip。
  // dpapi-protect/unprotect 刻意不在 HTTP 白名单里（仅扩展经 native messaging 可调）
  const secretMsg = b64(new TextEncoder().encode('dpapi-roundtrip-test'));
  const wrapped = await sendNative({ op: 'dpapi-protect', data: secretMsg });
  ok(wrapped.ok === true && typeof wrapped.data?.data === 'string'
    && wrapped.data.data !== secretMsg, 'dpapi-protect 返回包裹数据（native 通道）');
  const unwrapped = await sendNative({ op: 'dpapi-unprotect', data: wrapped.data?.data });
  ok(unwrapped.ok === true && unwrapped.data?.data === secretMsg, 'dpapi-unprotect 解回原文（native 通道）');
  const dpHttp = await api(port, 'dpapi-protect', { data: secretMsg });
  ok(dpHttp.ok === false && dpHttp.error === 'op-not-allowed', 'dpapi 指令不接受 HTTP 调用');

  // 填充事件：用户点过多少次「填充」
  const fill = await api(port, 'fill', {
    entryId: 'ui-e1', site: 'https://github.com/login', method: 'click',
    app: 'Chrome 扩展', tab: '登录 GitHub',
  });
  ok(fill.ok === true && fill.data?.recorded === true, 'fill 事件被记录（点击填充）');

  const stats = await api(port, 'audit-stats');
  ok(stats.ok === true && stats.data?.fills >= 1, '统计包含「填充次数」');
  ok(stats.data?.reads >= 1, '统计包含「密码读取次数」');
  ok(!!stats.data?.bySource?.ui, '统计按来源分组（哪个客户端读的）');

  const audit = await api(port, 'audit-tail');
  ok(audit.ok === true && audit.data?.text?.includes('read-secret'), '审计日志记录读取密码事件');
  ok(audit.data?.text?.includes('ui:get-secret'), '审计日志标记后台来源');
  ok(Array.isArray(audit.data?.rows) && audit.data.rows.length > 0, '审计日志返回结构化行');
  ok(audit.data.rows.some((r) => r.source === 'ui' && r.action === 'read-secret'), '审计行带来源列');
  ok(audit.data.rows.some((r) => r.action === 'fill' && r.detail.includes('github.com')), '审计行含填充站点明细');

  // ---- 审计筛选：日期 / 动作 / 来源 / 关键词 / 折叠轮询 ----
  const future = new Date(Date.now() + 86400000).toISOString();
  const empty = await api(port, 'audit-tail', { since: future, lines: 200 });
  ok(empty.ok === true && empty.data?.matched === 0 && empty.data?.rows?.length === 0,
    '按起始时间筛选：未来时间无匹配');

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const today = await api(port, 'audit-tail', { since: dayStart, lines: 200 });
  ok(today.ok === true && today.data.matched >= 1 && today.data.matched <= today.data.total,
    '按起始时间筛选：今天有记录且不超过总行数');

  const onlyRead = await api(port, 'audit-tail', { action: 'read-secret', lines: 200 });
  ok(onlyRead.ok === true && onlyRead.data.rows.length >= 1
    && onlyRead.data.rows.every((r) => r.action === 'read-secret'), '按动作前缀筛选只返回该动作');

  // 注意参数名是 src：HTTP 层会把 body.source 强制改写成 ui（审计来源标记）
  const onlyUi = await api(port, 'audit-tail', { src: 'ui', lines: 200 });
  ok(onlyUi.ok === true && onlyUi.data.rows.length >= 1
    && onlyUi.data.rows.every((r) => r.source === 'ui'), '按来源筛选只返回该来源');
  const onlyHost = await api(port, 'audit-tail', { src: 'host', lines: 200 });
  ok(onlyHost.ok === true && onlyHost.data.rows.every((r) => r.source === 'host'),
    '来源筛选对其他来源同样生效（不会被强制改成 ui）');

  const kw = await api(port, 'audit-tail', { q: 'github', lines: 200 });
  ok(kw.ok === true && kw.data.rows.length >= 1
    && kw.data.rows.every((r) => ((r.action || '') + ' ' + (r.detail || '')).toLowerCase().includes('github')),
    '关键词筛选命中明细');

  const noRoutine = await api(port, 'audit-tail', { hideRoutine: '1', lines: 200 });
  ok(noRoutine.ok === true && noRoutine.data.rows.length >= 1
    && noRoutine.data.rows.every((r) => r.action !== 'ui:status' && r.action !== 'ui:list'),
    'hideRoutine 折叠后台轮询流水');
  ok(noRoutine.data.matched < noRoutine.data.total, '折叠后匹配数少于日志总行数');

  const failOnly = await api(port, 'audit-tail', { fail: '1', lines: 200 });
  ok(failOnly.ok === true && failOnly.data.rows.length >= 1
    && failOnly.data.rows.every((r) => (r.detail || '').includes('ok=0')),
    '只看失败：只返回 ok=0 的行');

  const rawAll = await api(port, 'audit-raw');
  ok(rawAll.ok === true && typeof rawAll.data?.text === 'string'
    && rawAll.data.text.includes('read-secret'), 'audit-raw 返回完整日志（不受筛选影响）');

  await api(port, 'lock');
  st = await api(port, 'status');
  ok(st.data?.state === 'locked', '锁定后后台回到 locked');
} catch (e) {
  failures.push('异常：' + e.message);
  console.log('FAIL: 异常 -- ' + e.stack);
} finally {
  if (child) child.kill();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
