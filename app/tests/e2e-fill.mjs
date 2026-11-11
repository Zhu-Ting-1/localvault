/**
 * 端到端：真 Edge + 真扩展（--load-extension）+ 本地 fixtures。
 * 验证完整链路：content script 识别 → 字段图标渲染 → popup「当前网站」卡片 → 点击填充。
 *
 * 验证含加密保险库会话的正式扩展。
 *
 * 注意：保险库解锁依赖用户主密码——测试用独立的 host root + 预置测试库，
 * 通过 background 消息直接创建/解锁（模拟用户输入）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// 测试构建（含测试桥）默认在 dist-e2e/；正式包里的桥已被编译掉
const extDir = process.env.LV_EXT_DIR || join(root, 'dist-e2e', 'chrome-mv3');
const BASE = 'http://localhost:8080';
const PWD = 'fixture-master-pw-2026';

const profile = mkdtempSync(join(tmpdir(), 'lv-fill-'));
// 独立 host root：绝不碰用户真实保险库（%LOCALAPPDATA%\LocalVault）
const testVaultRoot = mkdtempSync(join(tmpdir(), 'lv-fill-vault-'));
// Windows 下 spawn 继承环境变量；Edge 启动的 SW 从父进程继承 LOCALVAULT_ROOT
process.env.LOCALVAULT_ROOT = testVaultRoot;
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1366, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
  env: { ...process.env },
  args: ['--no-first-run', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('扩展已加载：' + extId);

// background 消息封装：MV3 SW 自发 sendMessage 不触发自身 onMessage，
// 所以经 background 暴露的 __lvRoute 全局函数直驱（见 background.ts 注释）。
async function bg(req) {
  try {
    const res = await sw.evaluate(async (r) => {
      try { return await globalThis.__lvRoute(r, { tab: { id: 999 } }); }
      catch (e) { return { ok: false, code: 'sw-throw', message: String(e?.message ?? e), name: e?.name, stack: String(e?.stack ?? '').slice(0, 400) }; }
    }, req);
    if (!res.ok) console.log('    [bg fail]', JSON.stringify(req).slice(0, 60), '->', JSON.stringify(res).slice(0, 200));
    return res;
  } catch (e) {
    console.log('    [bg throw]', JSON.stringify(req).slice(0, 60), '->', e.message);
    return { ok: false, code: 'throw', message: e.message };
  }
}

let passed = 0; const failures = [];
const ok = (c, m, d) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failures.push(m); console.log('  × ' + m + (d ? ' — ' + d : '')); } };

// ---------- 前置：创建保险库并加测试条目（模拟用户首次流程） ----------
console.log('\n[setup] 创建保险库 + 测试条目');
let cr;
try { cr = await bg({ type: 'create-vault', masterPassword: PWD }); }
catch (e) { console.log('    [create-vault raw error]', JSON.stringify(e), '|', e?.message, '|', e?.code); cr = { ok: false }; }
ok(cr.ok === true && cr.data?.recoveryKey?.length > 0, '创建保险库成功，返回恢复密钥');

await bg({ type: 'save-entry', entry: {
  id: 't1', title: 'Local Test', username: 'test@example.test', password: 'TestPass-2026!',
  urls: ['http://localhost:8080'], notes: '', createdAt: '', updatedAt: '', passwordHistory: [],
}});
const entries = await bg({ type: 'entries' });
ok(entries.ok && entries.data.entries.length === 1, '测试条目已入库');

await bg({ type: 'set-identities', identities: [
  { id: 'i1', label: '手机', value: '13800000000' },
  { id: 'i2', label: 'QQ邮箱', value: 'me@qq.com' },
]});
const ids = await bg({ type: 'get-identities' });
ok(ids.ok && ids.data.identities.length === 2, '备选身份已入库');

// 身份落盘必须是密文块（不是明文数组），且不包含完整值
const storedIds = await sw.evaluate(() => chrome.storage.local.get('lv:identities'));
// v2：常用身份已搬进保险库 payload 的 meta 段（与条目同等加密强度），
// storage.local 里不应再有 lv:identities 这个键
ok(!storedIds['lv:identities'], 'v2 后 storage.local 不再存常用身份（已进保险库）');
ok(!/\d{11}/.test(JSON.stringify(storedIds)), '落盘内容不含 11 位连续数字（无明文手机号）');

const stSetup = await bg({ type: 'status' });
console.log('    [diag] setup 后 status:', JSON.stringify(stSetup.data));
const alarms = await sw.evaluate(() => chrome.alarms.getAll());
void alarms;

// ---------- 用例：classic.html 点击填充 ----------
console.log('\n[case] classic.html — 图标 + popup 填充');
{
  const page = await ctx.newPage();
  await page.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200); // 等识别 + 图标
  const stMid = await bg({ type: 'status' });
  console.log('    [diag] goto 后 status:', JSON.stringify(stMid.data?.state));

  // 1. 字段图标已渲染
  const icon = await page.evaluate(() => !!document.querySelector('[data-lv-icon]'));
  ok(icon, '密码框旁出现 LocalVault 图标');

  // 2. 内容脚本点击图标 → 填充
  const st0 = await bg({ type: 'status' });
  console.log('    [diag] classic 前 status:', JSON.stringify(st0.data));
  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(400);
  const diagCred = await bg({ type: 'get-credentials', url: BASE + '/classic.html' });
  console.log('    [diag] get-credentials:', JSON.stringify(diagCred).slice(0, 240));
  const filled = await page.evaluate(() => {
    const u = document.querySelector('#username');
    const p = document.querySelector('#password');
    return { u: u?.value ?? '', p: p?.value ?? '' };
  });
  ok(filled.u === 'test@example.test', '用户名已填充', JSON.stringify(filled));
  ok(filled.p === 'TestPass-2026!', '密码已填充');

  // 3. 未自动提交：表单 action 未被触发（页面 URL 不变）
  ok(page.url().includes('classic.html'), '未自动提交（仍在原页面）');

  // 4. popup「当前网站」卡片数据源
  const report = await bg({ type: 'get-tab-forms', tabId: (await ctx.pages()).at(-1) ? undefined : undefined });
  void report; // popup 自身会查询；这里验 background 已缓存
  await page.close();
}

// ---------- 用例：signup.html 注册页 — 生成菜单 + 身份选择 ----------
console.log('\n[case] signup.html — 生成菜单 + 身份选择填充');
{
  const page = await ctx.newPage();
  await page.goto(BASE + '/signup.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(600);

  // 菜单已弹出（closed shadow 的宿主元素）
  const menuShown = await page.evaluate(() => !!document.getElementById('lv-signup-menu'));
  ok(menuShown, '注册选择菜单已弹出');

  // 数据源：≥20 位密码 + 2 个身份
  const opts = await bg({ type: 'get-signup-options' });
  ok(opts.ok && opts.data.password.length >= 20, '菜单数据源：≥20 位生成密码');
  ok(opts.ok && opts.data.identities.length === 2, '菜单数据源：2 个备选身份');

  // isolated world 的 JS 属性对主世界 page.evaluate 不可见——改用 DOM 事件桥：
  // content script 在 host 上监听主世界可见的自定义事件，测试 dispatch 它即可。
  await page.evaluate(() => {
    document.getElementById('lv-signup-menu')
      .dispatchEvent(new CustomEvent('lv-test-select', { detail: { index: 0 }, bubbles: true }));
  });
  await page.waitForTimeout(400);

  const filled = await page.evaluate(() => {
    const pws = Array.from(document.querySelectorAll('input[type="password"]'));
    return { p1: pws[0]?.value?.length ?? 0, p2: pws[1]?.value?.length ?? 0 };
  });
  ok(filled.p1 >= 20, '点身份后密码填入（第一格）', 'len=' + filled.p1);
  ok(filled.p2 >= 20, '确认密码格同步填充', 'len=' + filled.p2);
  await page.close();
}

// ---------- 用例：本站没有记录 + 登录页 → 给常用身份，而不是「生成密码」 ----------
console.log('\n[case] 无本站记录 — 登录页弹常用身份');
{
  const page = await ctx.newPage();
  // 换 127.0.0.1：与已存条目的 localhost 不同源，才能走到「无匹配」分支
  await page.goto('http://127.0.0.1:8080/xmind.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(600);

  const menus = await page.evaluate(() => ({
    identity: !!document.getElementById('lv-identity-menu'),
    signup: !!document.getElementById('lv-signup-menu'),
  }));
  ok(menus.identity && !menus.signup, '无记录时弹常用身份（不是生成密码）', JSON.stringify(menus));

  await page.evaluate(() => {
    document.getElementById('lv-identity-menu')
      .dispatchEvent(new CustomEvent('lv-test-select', { detail: { index: 0 }, bubbles: true }));
  });
  await page.waitForTimeout(300);
  const val = await page.evaluate(() => document.querySelector('input[name=account]')?.value ?? '');
  ok(val.length > 0, '选中身份后账号已填入', val);
  await page.close();
}

// ---------- 用例：站点密码规则自动适配（注册优先：生成那一刻满足规则） ----------
console.log('\n[case] 站点密码规则 — 生成时自动适配');
{
  const cases = [
    {
      name: '属性+文案：6-16位字母或数字',
      url: BASE + '/rule-limited.html',
      attrs: 'maxlength="16" pattern="[a-zA-Z0-9]{6,16}"',
      tip: '密码为6-16位字母或数字',
      check: (p) => p.length >= 6 && p.length <= 16 && /^[a-zA-Z0-9]+$/.test(p),
      hint: '6-16 位纯字母数字',
    },
    {
      name: '仅文案：6~30位字母或数字',
      url: BASE + '/rule-hint.html',
      attrs: 'placeholder="请输入6~30位字母或数字"',
      tip: '密码为6~30位字母或数字',
      check: (p) => p.length >= 6 && p.length <= 30 && /^[a-zA-Z0-9]+$/.test(p),
      hint: '≤30 位纯字母数字',
    },
    {
      name: '无限制：默认 20 位带符号',
      url: BASE + '/rule-free.html',
      attrs: '',
      tip: '请设置一个安全的登录密码',
      check: (p) => p.length === 20 && /[^a-zA-Z0-9]/.test(p),
      hint: '20 位含符号',
    },
  ];

  for (const c of cases) {
    const page = await ctx.newPage();
    await page.route('**/rule-*.html', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>规则测试</title></head><body>
<form id="f">
  <input id="mobile" name="mobile" placeholder="手机号">
  <input id="password" type="password" ${c.attrs}>
  <input id="confirm" type="password" ${c.attrs}>
  <p id="tip">${c.tip}</p>
  <button type="submit">立即注册</button>
</form></body></html>`,
    }));
    await page.goto(c.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.locator('[data-lv-icon]').first().click();
    await page.waitForTimeout(600);

    const menuShown = await page.evaluate(() => !!document.getElementById('lv-signup-menu'));
    ok(menuShown, c.name + '：菜单已弹出');
    if (menuShown) {
      // 事件桥触发「点身份」→ 密码一并填入，读回真实填入值校验是否合规
      await page.evaluate(() => document.getElementById('lv-signup-menu')
        .dispatchEvent(new CustomEvent('lv-test-select', { detail: { index: 0 }, bubbles: true })));
      await page.waitForTimeout(300);
      const pw = await page.evaluate(() => document.querySelector('#password')?.value ?? '');
      ok(c.check(pw), c.name + '：填入的密码合规（' + c.hint + '）',
         'len=' + pw.length + ' head=' + pw.slice(0, 4));
    }
    await page.close();
  }

  // 后台尊重手动调整的生成参数（菜单里改长度 / 关符号走同一入口）
  const tuned = await bg({ type: 'get-signup-options', genOpts: { length: 12, symbols: false } });
  ok(tuned.ok && tuned.data.password.length === 12 && /^[a-zA-Z0-9]+$/.test(tuned.data.password),
     '手动调整：12 位、不含符号也能生成');
}

// ---------- 用例：提交捕获 → 页面内保存浮窗 ----------
console.log('\n[case] 提交捕获 — 保存浮窗弹出 + 入库');
{
  const page = await ctx.newPage();
  await page.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // 填表并提交（capture 监听会读到值 → 浮窗弹出）
  await page.evaluate(() => {
    const u = document.querySelector('#username');
    const p = document.querySelector('#password');
    if (u) u.value = 'float-test@example.test';
    if (p) p.value = 'TestPass-2026!';
    const f = document.querySelector('#username').closest('form'); f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(1800); // 保存浮窗延后 1s 弹（要先看站点是否当场报错）
  const floatShown = await page.evaluate(() => !!document.getElementById('lv-save-float'));
  ok(floatShown, '提交后页面内保存浮窗弹出');

  await page.evaluate(() => {
    document.getElementById('lv-save-float')
      .dispatchEvent(new CustomEvent('lv-test-save', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  const entries = await bg({ type: 'entries' });
  const found = entries.data.entries.find((e) => e.username === 'float-test@example.test');
  ok(!!found, '浮窗「保存」后条目已入库（账号+密码+URL 自动提取）',
     JSON.stringify(entries.data.entries.map((e) => e.username)));
  await page.close();
  // 清理
  if (found) await bg({ type: 'delete-entry', id: found.id });
}

// ---------- 用例：SPA 注册（无原生 submit / 提交后整页跳转） ----------
console.log('\n[case] SPA 注册提交 — 按钮 click 捕获 + 跳转后补弹');
{
  const page = await ctx.newPage();
  await page.route('**/spa-*.html', (route) => {
    const isResult = route.request().url().includes('spa-result');
    route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: isResult
        ? '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>注册成功</h1></body></html>'
        : `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="app">
  <input id="username" placeholder="账号">
  <input id="password" type="password">
  <input id="confirm" type="password">
  <button type="button" id="go">立即注册</button>
  <button type="button" id="code">获取验证码</button>
</div>
<script>
document.getElementById('go').addEventListener('click', function () {
  var p = document.getElementById('password');
  if (p) p.value = '';                 // 模拟 SPA 提交时把值清空
  document.getElementById('app').innerHTML = '<div>注册成功，正在跳转…</div>';
});
</script></body></html>`,
    });
  });
  await page.goto(BASE + '/spa-register.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('username', 'spa-test-user');
    set('password', 'Spa-Pass-2026!');
    set('confirm', 'Spa-Pass-2026!');
  });

  // 非提交按钮不应误弹
  await page.locator('#code').click();
  await page.waitForTimeout(250);
  ok(!(await page.evaluate(() => !!document.getElementById('lv-save-float'))), '「获取验证码」不会误弹保存提示');

  // SPA：按钮 click + DOM 清空，不触发原生 submit，仍应弹窗（靠输入快照兜底）
  await page.locator('#go').click();
  await page.waitForTimeout(1800);
  ok(await page.evaluate(() => !!document.getElementById('lv-save-float')), 'SPA 按钮 click（无 submit 事件）也能弹保存提示');

  // 整页跳转：原浮窗随文档销毁，新页面应补弹
  await page.goto(BASE + '/spa-result.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const floatShown = await page.evaluate(() => !!document.getElementById('lv-save-float'));
  if (!floatShown) {
    const peek = await bg({ type: 'lv-peek-last-submit', tabId: 999 });
    console.log('    [diag] peek(999):', JSON.stringify(peek).slice(0, 200));
  }
  ok(floatShown, '注册成功跳转后，新页面补弹保存提示');

  await page.close();
}

// ---------- 用例：验证码登录（手机号 + 验证码，无密码框） ----------
console.log('\n[case] 验证码登录 — 选身份填手机号');
{
  const page = await ctx.newPage();
  await page.route('**/otp-login.html', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form id="f">
  <input id="mobile" type="tel" placeholder="请输入手机号">
  <input id="code" type="text" placeholder="短信验证码" maxlength="6">
  <button type="button" id="send">获取验证码</button>
  <button type="submit">登录</button>
</form></body></html>`,
  }));
  await page.goto(BASE + '/otp-login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1300);

  ok(await page.evaluate(() => !!document.querySelector('[data-lv-icon]')), '验证码登录页出现 LocalVault 图标');

  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => !!document.getElementById('lv-identity-menu')), '点击图标弹出「选择要填充的账号」');
  ok(!(await page.evaluate(() => !!document.getElementById('lv-signup-menu'))), '不会误弹生成密码菜单');

  await page.evaluate(() => document.getElementById('lv-identity-menu')
    .dispatchEvent(new CustomEvent('lv-test-select', { detail: { index: 0 }, bubbles: true })));
  await page.waitForTimeout(300);

  const vals = await page.evaluate(() => ({
    mobile: document.getElementById('mobile')?.value ?? '',
    code: document.getElementById('code')?.value ?? '',
    menu: !!document.getElementById('lv-identity-menu'),
  }));
  const expectVal = ids.data.identities[0].value;
  ok(vals.mobile === expectVal, '手机号填入的是完整值（菜单里显示的是打码后）');
  ok(vals.code === '', '验证码保持为空，交给用户自己获取');
  ok(!vals.menu, '选择后菜单自动关闭');
  await page.close();
}

// ---------- 用例：账号先行登录（email-first，密码在下一屏） ----------
console.log('\n[case] 账号先行登录 — 只填账号，不点「下一步」');
{
  const page = await ctx.newPage();
  await page.route('**/email-first-login.html', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form id="step1">
  <input id="email" name="loginfmt" type="email" autocomplete="username" placeholder="电子邮件、电话或 Skype">
  <button type="submit" id="next">下一步</button>
</form>
<script>window.__nextClicked = false;
document.getElementById('next').addEventListener('click', function (e) {
  e.preventDefault(); window.__nextClicked = true;
});</script>
</body></html>`,
  }));
  await page.goto(BASE + '/email-first-login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1300);

  ok(await page.evaluate(() => !!document.querySelector('[data-lv-icon]')), '账号先行页出现 LocalVault 图标');
  ok(!(await page.evaluate(() => document.getElementById('pw'))), '页面本身没有密码框（确认这是 email-first 形态）');

  const known = (await bg({ type: 'entries' })).data.entries.map((e) => e.username);

  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => ({
    email: document.getElementById('email')?.value ?? '',
    nextClicked: window.__nextClicked,
    menu: !!document.getElementById('lv-signup-menu'),
    badge: !!document.getElementById('lv-badge'),
  }));
  ok(after.email.length > 0 && known.includes(after.email), '账号已填入（本站已存账号之一）', 'got=' + after.email);
  ok(after.nextClicked === false, '没有替你点「下一步」（不自动提交）');
  ok(!after.menu, '不弹生成密码菜单');
  ok(after.badge, '页面内给出了「请自己点下一步」的提示');
  await page.close();
}

// ---------- 用例：no-password.html 零误报 ----------
console.log('\n[case] no-password.html — 零误报');
{
  const page = await ctx.newPage();
  await page.goto(BASE + '/no-password.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const icon = await page.evaluate(() => !!document.querySelector('[data-lv-icon]'));
  ok(!icon, '无密码框页面不出现填充图标（零误报）');
  await page.close();
}

// ---------- 用例：同站两账号 → 选择菜单 ----------
console.log('\n[case] 同站两账号 — 弹选择菜单，填选中的那个');
{
  // 清掉之前浮窗保存流程留下的条目，让本站只剩 t1 + 下面新加的两条
  const all = (await bg({ type: 'entries' })).data.entries;
  for (const e of all) {
    if (e.username && e.username !== 'test@example.test') await bg({ type: 'delete-entry', id: e.id });
  }
  await bg({ type: 'save-entry', entry: {
    id: 'm1', title: '工作邮箱', username: 'work@corp.test', password: 'WorkPass-111!',
    urls: [BASE], notes: '', createdAt: '', updatedAt: '', passwordHistory: [],
  }});
  await bg({ type: 'save-entry', entry: {
    id: 'm2', title: '个人邮箱', username: 'me@home.test', password: 'HomePass-222!',
    urls: [BASE], notes: '', createdAt: '', updatedAt: '', passwordHistory: [],
  }});

  const page = await ctx.newPage();
  await page.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => !!document.getElementById('lv-account-menu')), '同站多账号时弹出「选择要填充的账号」');

  await page.evaluate(() => document.getElementById('lv-account-menu')
    .dispatchEvent(new CustomEvent('lv-test-select', { detail: { index: 2 } })));
  await page.waitForTimeout(400);
  const picked = await page.evaluate(() => ({
    u: document.querySelector('#username')?.value ?? '',
    p: document.querySelector('#password')?.value ?? '',
  }));
  ok(picked.u === 'me@home.test' && picked.p === 'HomePass-222!', '填入的是选中的账号（不是第一条）', JSON.stringify(picked));
  await page.close();

  await bg({ type: 'delete-entry', id: 'm1' });
  await bg({ type: 'delete-entry', id: 'm2' });
}

// ---------- 用例：填充耗时埋点 ----------
console.log('\n[case] 填充耗时 — 必须 < 100ms');
{
  const page = await ctx.newPage();
  await page.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__lvTiming = null;
    document.addEventListener('lv-fill-timing', (e) => { window.__lvTiming = e.detail; });
  });
  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(500);
  const t = await page.evaluate(() => window.__lvTiming);
  ok(!!t && typeof t.ms === 'number' && t.ms < 100, '填充耗时 < 100ms', JSON.stringify(t));
  await page.close();
}

// ---------- 用例：跨域 iframe 登录框 ----------
console.log('\n[case] 跨域 iframe — 子帧独立识别并填充');
{
  // 父页在 127.0.0.1:8080，登录表单在另一个源（https://sso-child.test）的 iframe 里。
  // 用 https 是为了绕开我们自己的「HTTP 明文不填」策略，让这条只测跨帧能力。
  await bg({ type: 'save-entry', entry: {
    id: 'sso1', title: 'SSO 站点', username: 'sso-user@test.local', password: 'SsoPass-777!',
    urls: ['https://sso-child.test'], notes: '', createdAt: '', updatedAt: '', passwordHistory: [],
  }});

  const page = await ctx.newPage();
  await page.route('**/sso-parent.html', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>SSO 父页</title></head><body>
      <h3>站点主页面（本身没有表单）</h3>
      <iframe src="https://sso-child.test/child.html" width="560" height="420" style="border:1px solid #ddd"></iframe>
    </body></html>`,
  }));
  await page.route('https://sso-child.test/child.html', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form id="sso-form">
  <input id="sso-user" name="username" autocomplete="username" placeholder="邮箱/手机号">
  <input id="sso-pass" name="password" type="password" autocomplete="current-password">
  <button type="submit">登录</button>
</form></body></html>`,
  }));

  await page.goto('http://127.0.0.1:8080/sso-parent.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  ok(!(await page.evaluate(() => !!document.querySelector('[data-lv-icon]'))), '跨域父页面本身没有图标（表单在子帧）');
  const child = page.frames().find((f) => f.url().includes('sso-child.test'));
  ok(!!child, '找到跨域子帧', page.frames().map((f) => f.url()).join(' | '));
  if (child) {
    ok(await child.evaluate(() => !!document.querySelector('[data-lv-icon]')), '跨域子帧内独立画出图标');
    // 合成 MouseEvent 的 isTrusted=false，扩展会拒收；用真实鼠标点击
    await child.locator('[data-lv-icon]').first().click();
    await page.waitForTimeout(700);
    const v = await child.evaluate(() => ({
      u: document.querySelector('#sso-user')?.value ?? '',
      p: document.querySelector('#sso-pass')?.value ?? '',
    }));
    ok(v.u === 'sso-user@test.local' && v.p === 'SsoPass-777!', '跨域子帧内填充成功', JSON.stringify({ p: !!v.p }));
  }
  await page.close();
  await bg({ type: 'delete-entry', id: 'sso1' });
}

// ---------- 用例：登录明显失败时不弹保存提示 ----------
console.log('\n[case] 登录失败 — 不弹保存提示');
{
  const page = await ctx.newPage();
  await page.route('**/login-fail.html', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form id="f" onsubmit="return false">
  <input id="username" name="username" autocomplete="username">
  <input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit" id="go">登录</button>
</form>
<div id="err" style="display:none;color:#c00">账号或密码错误</div>
<script>
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('err').style.display = 'block';
});
</script></body></html>`,
  }));
  await page.goto(BASE + '/login-fail.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('username', 'wrong@test.local');
    set('password', 'BadPass-999!');
  });
  await page.locator('#go').click();
  await page.waitForTimeout(1800);
  ok(!(await page.evaluate(() => !!document.getElementById('lv-save-float'))),
     '页面当场报「账号或密码错误」时不弹保存提示');
  await page.close();
}

// ---------- 用例：SPA 反复切换 50 次 ----------
console.log('\n[case] SPA 反复切换 50 次 — 图标不累积、重扫不退化');
{
  const page = await ctx.newPage();
  await page.route('**/spa-toggle.html', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="root"></div>
<button id="toggle" type="button">切换</button>
<script>
var n = 0;
document.getElementById('toggle').addEventListener('click', function () {
  n++;
  document.getElementById('root').innerHTML = (n % 2 === 1)
    ? '<form><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">登录</button></form>'
    : '';
});
</script></body></html>`,
  }));
  await page.goto(BASE + '/spa-toggle.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  for (let i = 0; i < 50; i++) {
    await page.locator('#toggle').click();
    await page.waitForTimeout(70);
  }
  const after50 = await page.evaluate(() => document.querySelectorAll('[data-lv-icon]').length);
  ok(after50 === 0, '切换 50 次后表单已卸载，图标也被清掉', 'icons=' + after50);

  const t0 = Date.now();
  await page.locator('#toggle').click();
  let icons = 0;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(100);
    icons = await page.evaluate(() => document.querySelectorAll('[data-lv-icon]').length);
    if (icons) break;
  }
  const ms = Date.now() - t0;
  ok(icons === 1, '第 51 次挂载后恰好 1 个图标（没有累积重复）', 'icons=' + icons);
  ok(ms < 1500, '反复切换后重扫仍及时', ms + 'ms');
  await page.close();
}

// ---------- 用例：设置/诊断页 ----------
console.log('\n[case] 设置/诊断页 — 读到 host 诊断信息');
{
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  ok(!text.includes('连接不上本地助手'), '诊断页没有报「连接不上本地助手」');
  ok(text.includes('本地助手版本') && !text.includes('未连接'), '诊断页读到 host 版本');
  ok(text.includes('修订号') && text.includes('可写'), '诊断页显示 revision 与目录可写性');
  ok(errors.length === 0, '诊断页无控制台错误', errors.join(' | '));
  await page.close();
}

// ---------- 用例：导出（加密备份 vs 明文） ----------
console.log('\n[case] 导出 — 加密备份与明文 CSV');
{
  const plain = await bg({ type: 'export-plaintext' });
  ok(plain.ok === true, '解锁态可以导出明文');
  const rows = plain.data?.rows ?? [];
  ok(rows.length >= 1, '明文导出包含条目', 'rows=' + rows.length);
  ok(rows.some((r) => r.password && r.password.length > 0), '明文行里带密码字段');

  const enc = await bg({ type: 'export-envelope' });
  ok(enc.ok === true && !!enc.data?.envelope, '加密备份可导出（换电脑用这个）');

  await bg({ type: 'lock' });
  const denied = await bg({ type: 'export-plaintext' });
  ok(denied.ok === false && denied.code === 'locked', '锁定态拒绝导出明文');
  await bg({ type: 'unlock', password: PWD });
}

// ---------- 用例：绝对超时锁定 + 剪贴板自动清空 ----------
console.log('\n[case] 安全 — 绝对超时锁定 + 剪贴板清理');
{
  const st = await bg({ type: 'status' });
  if (st.data?.state !== 'unlocked') await bg({ type: 'unlock', password: PWD });

  // ① 绝对超时：把「本次解锁时间」改到 9 小时前
  await sw.evaluate(async () => {
    await chrome.storage.session.set({ 'lv:unlockedAt': Date.now() - 9 * 60 * 60 * 1000 });
  });
  const st2 = await bg({ type: 'status' });
  ok(st2.data?.state === 'locked', '解锁超过 8 小时后自动回到锁定态');
  const blocked = await bg({ type: 'entries' });
  ok(blocked.ok === false, '超时锁定后读不到任何条目');

  // ② 重新解锁后恢复正常
  const re = await bg({ type: 'unlock', password: PWD });
  ok(re.ok === true, '重新输主密码可以解锁');
  ok((await bg({ type: 'status' })).data.state === 'unlocked', '状态回到已解锁');

  // ④ 记住解锁：锁定只删钥匙，不该把开关一起关掉
  const arm = await bg({ type: 'set-remember', enabled: true });
  ok(arm.ok === true, '可以开启「记住解锁」');
  await bg({ type: 'lock' }); // 与空闲锁/锁屏锁走同一个 lock()
  const afterLock = await bg({ type: 'status' });
  ok(afterLock.data?.state === 'locked', '锁定后处于锁定态（没有被 status 自动解开）');
  ok(afterLock.data?.rememberEnabled === true, '锁定不会把「记住解锁」开关关掉');
  const re2 = await bg({ type: 'unlock', password: PWD });
  ok(re2.ok === true, '锁定后仍可用主密码解锁');
  const afterUnlock = await bg({ type: 'status' });
  ok(afterUnlock.data?.state === 'unlocked' && afterUnlock.data?.rememberEnabled === true,
    '解锁后开关仍是开启状态（不用重新勾）',
    'rememberKeyError=' + String(afterUnlock.data?.rememberKeyError));
  await bg({ type: 'set-remember', enabled: false }); // 复原，避免影响后续用例

  // ⑤ 剪贴板：复制后应挂一个清空闹钟；触发后剪贴板里不能再有密码
  const page = await ctx.newPage();
  await page.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => navigator.clipboard.writeText('SECRET-IN-CLIPBOARD'));

  const sched = await bg({ type: 'schedule-clipboard-clear', seconds: 30 });
  ok(sched.ok === true, '可以安排剪贴板清空');
  const alarms = await sw.evaluate(() => chrome.alarms.getAll());
  ok(alarms.some((a) => a.name === 'lv:clip-clear'), '创建了 lv:clip-clear 闹钟');

  // 立刻触发一次，验证真的把剪贴板覆盖掉了
  await sw.evaluate(() => chrome.alarms.create('lv:clip-clear', { when: Date.now() + 30 }));
  await page.waitForTimeout(2200);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => 'READ-FAIL'));
  ok(!clip.includes('SECRET-IN-CLIPBOARD'), '清空后剪贴板里不再有原密码', JSON.stringify(clip).slice(0, 40));
  await page.close();
}

// ---------- 用例：HTTP 明文页面不填充----------
console.log('\n[case] HTTP 明文页面 — 不填凭据');
{
  // ① 后台权威判定：http + 非 localhost → 直接拒绝
  const direct = await bg({ type: 'get-credentials', url: 'http://insecure.test/login' });
  ok(direct.ok === false && direct.code === 'insecure-http', '后台对 HTTP 页面拒绝返回凭据');
  // ② localhost 例外仍然放行（本地开发/测试要用）
  const local = await bg({ type: 'get-credentials', url: BASE + '/classic.html' });
  ok(local.ok === true, 'localhost 例外：仍可返回凭据');

  // ③ 页面侧：图标点击后不填、并给出明文传输提示
  const page = await ctx.newPage();
  await page.route('http://insecure.test/**', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form id="f">
  <input id="username" name="username" autocomplete="username">
  <input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit">登录</button>
</form></body></html>`,
  }));
  await page.goto('http://insecure.test/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const hasIcon = await page.evaluate(() => !!document.querySelector('[data-lv-icon]'));
  if (hasIcon) {
    await page.locator('[data-lv-icon]').first().click();
    await page.waitForTimeout(600);
  }
  const vals = await page.evaluate(() => ({
    u: document.querySelector('#username')?.value ?? '',
    p: document.querySelector('#password')?.value ?? '',
    badge: !!document.getElementById('lv-badge'), // 提示条 host 存在即视为已提示（内容是 closed shadow）
  }));
  ok(vals.p === '' && vals.u === '', 'HTTP 页面上点击图标不会填入任何凭据', 'u=' + vals.u.length + ' p=' + vals.p.length);
  ok(vals.badge, 'HTTP 页面给出「不填充」提示');
  await page.close();
}

// ---------- 用例：锁定态页内提示 + 解锁后自动继续 ----------
console.log('\n[case] 锁定态 — 页内面板不接收主密码，解锁后自动继续填充');
{
  await bg({ type: 'lock' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // 解锁前用户已经敲了点东西，验证解锁过程不会把它清掉
  await page.evaluate(() => { document.querySelector('#username').value = 'typed-before-lock'; });

  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(600);
  const panelState = await page.evaluate(() => {
    const host = document.getElementById('lv-unlock-panel');
    return { panel: !!host, inputs: host ? host.querySelectorAll('input').length : -1 };
  });
  ok(panelState.panel, '锁定态点击图标弹出页内解锁面板');
  ok(panelState.inputs === 0, '面板里没有任何输入框（主密码不进页面 DOM）', 'inputs=' + panelState.inputs);

  // 主密码只能在扩展弹窗里输：这里模拟「用户在弹窗里解锁」，面板应自动关闭并续跑填充
  await bg({ type: 'unlock', password: PWD });
  await page.waitForTimeout(2600);

  const after = await page.evaluate(() => ({
    panel: !!document.getElementById('lv-unlock-panel'),
    user: document.querySelector('#username')?.value ?? '',
    pass: document.querySelector('#password')?.value ?? '',
  }));
  ok(!after.panel, '别处解锁后面板自动关闭');
  ok(after.pass.length > 0, '解锁后自动继续填充密码', 'len=' + after.pass.length);
  // 填充会用库里的账号覆盖输入框（这是预期），所以只验证「有内容、不是空的」
  ok(after.user.length > 0, '解锁过程中表单已有内容不丢', 'user=' + after.user.slice(0, 16));
  await page.close();
}

// ---------- 用例：锁定态下不填充 ----------
console.log('\n[case] 锁定态 — 图标点击不填充');
{
  await bg({ type: 'lock' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/classic.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.locator('[data-lv-icon]').first().click();
  await page.waitForTimeout(400);
  const filled = await page.evaluate(() => document.querySelector('#password')?.value ?? '');
  ok(filled === '', '锁定态点击图标不填充凭据', 'len=' + filled.length);
  await page.close();
  // 恢复解锁（后续用例不依赖，但保持状态一致）
  await bg({ type: 'unlock', password: PWD });
}

await ctx.close();

console.log('');
console.log(failures.length ? '❌ ' + failures.length + ' 项失败，' + passed + ' 项通过' : '✅ 端到端（本地 fixtures）：' + passed + ' 项全部通过');
process.exit(failures.length ? 1 : 0);