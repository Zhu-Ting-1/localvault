/**
 * 审计日志页视觉预览：造一份带多天数据的临时保险库 → 起 host → 用本机 Edge 截图。
 * 仅用于本地开发看效果，不参与自动回归。
 *   node tools/preview-audit.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, '..');
const require = createRequire(join(project, 'app', 'package.json'));
const { argon2id } = require('hash-wasm');
const { chromium } = require('playwright-core');

const exe = join(project, 'host', 'vault-host.exe');
if (!existsSync(exe)) { console.error('host 未构建'); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), 'lv-preview-'));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const importKey = (raw) => webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function sealBytes(key, aadText, bytes) {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(aadText, 'utf8'), tagLength: 128 }, key, bytes));
  return { nonce: b64(nonce), ct: b64(ct) };
}
const sealJson = (key, aad, obj) => sealBytes(key, aad, Buffer.from(JSON.stringify(obj), 'utf8'));

const password = '预览用主密码';
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

const sites = [
  // 故意留成域名：验证「名字还是域名」的兜底显示 + 自动识别
  ['ai.example.com', 'ai.example.com', 'https://ai.example.com/login'],
  ['www.wikipedia.org', 'www.wikipedia.org', 'https://www.wikipedia.org/signin'],
  ['github.com', '', 'https://github.com/login'],
  ['mail.qq.com', 'QQ 邮箱', 'https://mail.qq.com/'],
];
const entries = [];
for (let i = 0; i < sites.length; i++) {
  const id = 'pv-' + i;
  entries.push({
    id,
    head: await sealJson(dekKey, `localvault/v2/head/${id}`, {
      title: sites[i][1], username: 'user' + i + '@example.com', urls: [sites[i][2]],
      description: sites[i][1], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    }),
    secret: await sealJson(dekKey, `localvault/v2/secret/${id}`, {
      password: 'Pw-' + i + '-preview!', passwordHistory: [], notes: '',
    }),
  });
}
const payloadV2 = { format: 'localvault/v2', entries, meta: { createdAt: '2026-10-01T00:00:00Z', generatorVersion: '0.3.0' } };
const payload = await sealJson(dekKey, 'localvault-payload/v1', payloadV2);
payload.aad = 'localvault-payload/v1';
const ext = {
  format: 'localvault/v1', kdf,
  authVerify: { nonce: auth.nonce, ct: auth.ct },
  wrappers: [{ id: 'master', nonce: wrap.nonce, ct: wrap.ct }],
  payload, updatedAt: new Date().toISOString(),
};
writeFileSync(join(root, 'vault.db'), JSON.stringify({
  format: 'localvault-spike/v1', revision: 3, updatedAt: new Date().toISOString(), ciphertext: JSON.stringify(ext),
}), 'utf8');

// 造 12 天的审计样本（UTC），覆盖不同来源/动作/失败行
const lines = [];
const mk = (dayOffset, hh, mm, ss, src, act, detail) => {
  const d = new Date(Date.now() - dayOffset * 86400000);
  const iso = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, ss)).toISOString();
  lines.push([iso, src, act, detail].join('\t'));
};
const actions = [
  ['ext', 'unlock', 'method=dek'],
  ['ext', 'read-secret', 'entry=pv-2 via=fill'],
  ['ext', 'fill', 'entry=pv-2 site=https://github.com/login method=click app=Edge tab=Sign in to GitHub'],
  ['ui', 'unlock', 'method=dek'],
  ['ui', 'ui:get-secret', 'ok=1 entry=pv-0'],
  ['ui', 'ui:status', 'ok=1'],
  ['ui', 'ui:list', 'ok=1'],
  ['host', 'auto-clear-dek', 'idle=600s'],
  ['ext', 'upsert', 'entry=pv-3 action=create'],
  ['ui', 'ui:upsert', 'ok=1 entry=pv-1'],
  ['ui', 'ui:delete', 'ok=0 entry=missing err=not-found'],
  ['ext', 'site-name', 'entry=pv-1 name=海云数据'],
  ['ui', 'ui:set-export-mode', 'ok=1'],
  ['host', 'tpm-enable', 'method=windows-hello'],
];
for (let day = 11; day >= 0; day--) {
  for (let k = 0; k < 8; k++) {
    const a = actions[(day * 3 + k) % actions.length];
    mk(day, 2 + k * 2, (k * 7) % 60, (k * 13) % 60, a[0], a[1], a[2] + ' day=' + day);
  }
}
writeFileSync(join(root, 'audit.log'), lines.join('\n') + '\n', 'utf8');

const child = spawn(exe, [], { env: { ...process.env, LOCALVAULT_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stderr.on('data', () => {});
let port = 0;
for (let i = 0; i < 80; i++) {
  const f = join(root, 'ui.port');
  if (existsSync(f)) { port = parseInt(readFileSync(f, 'utf8').trim(), 10); break; }
  await new Promise((r) => setTimeout(r, 100));
}
if (!port) { console.error('UI 未启动'); child.kill(); process.exit(1); }

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 1000 }, deviceScaleFactor: 2 });
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
// 后台 API 要令牌：从数据目录读出来拼到地址上（正式启动器也是这么做的）
const tokenFile = join(root, 'ui.token');
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
await page.goto(`http://127.0.0.1:${port}/?t=${encodeURIComponent(token)}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.hashwasm, null, { timeout: 15000 }).catch(() => console.log('hashwasm 未就绪'));
await page.fill('#pw', password);
await page.click('#unlockbtn');
try {
  await page.waitForSelector('#main', { state: 'visible', timeout: 20000 });
} catch (e) {
  console.log('解锁失败，页面提示：', await page.textContent('#lockmsg').catch(() => '(无)'));
  await page.screenshot({ path: join(project, 'screenshots', 'debug.png'), fullPage: true });
  throw e;
}
// 先看条目页：复制按钮 + 自动识别前后
await page.waitForSelector('#list .entry', { timeout: 15000 });
await page.waitForTimeout(300);
await page.screenshot({ path: join(project, 'screenshots', 'entries-before.png'), fullPage: true });
const copyCount = await page.locator('#list .entry button', { hasText: '复制' }).count();
console.log('复制按钮数量:', copyCount);
// 真点一次「复制」，确认剪贴板是「账号一行、密码一行」
try {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#list .entry button', { hasText: '复制' }).first().click();
  await page.waitForTimeout(500);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  console.log('剪贴板内容:', JSON.stringify(clip));
} catch (e) { console.log('剪贴板验证失败:', e.message); }
await page.waitForTimeout(7000);   // 等自动识别抓完 <title> 并写回
await page.screenshot({ path: join(project, 'screenshots', 'entries.png'), fullPage: true });
console.log('识别后列表：', (await page.locator('#list .site').allTextContents()).join(' | '));

await page.click("button[data-tab='audit']");
await page.waitForSelector('#auditrows table', { timeout: 15000 });
await page.waitForTimeout(400);
const out = join(project, 'screenshots', 'console.png');
await page.screenshot({ path: out, fullPage: true });

// 再截一张「近 7 天」筛选后的样子
await page.click("button[data-preset='7']");
await page.waitForTimeout(600);
const out2 = join(project, 'screenshots', 'console-7d.png');
await page.screenshot({ path: out2, fullPage: true });

console.log('saved', out);
console.log('saved', out2);
await browser.close();
child.kill();
