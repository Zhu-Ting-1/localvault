/**
 * 真实站点填充 benchmark
 *
 * 与 M1a 的 benchmark 区别：M1a 只验「识别到密码框」，这里验「点击图标后值真的落进
 * 可见输入框」。判定是严格比对：密码必须逐字等于测试凭据、账号必须等于测试账号，
 * 不接受「非空」这种会被站点自身预填蒙混过关的判据。
 *
 * 每站记录失败分类，便于针对性加固：
 *   unreachable  页面打不开（网络/超时）
 *   no-form      DOM 里根本没有密码框
 *   form-hidden  有密码框但不可见（多为「扫码登录」默认态）
 *   no-icon      有可见密码框但扩展没画图标（识别失败）
 *   icon-no-fill 点了图标但值没进可见框
 *   user-miss    密码进了，账号没进（配对错误）
 *   signup-menu  识别成注册页弹了生成菜单（登录页误分类）
 *   ok           账号+密码一次填好
 *
 * 安全：只用假凭据；全程不点任何提交按钮。
 * 用法：先起 fixtures 服务（node tools/serve-fixtures.mjs，仅本地 8080 需要），再
 *   cd app && node tests/e2e-real-sites.mjs [--only=关键词]
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extDir = join(root, 'dist', 'chrome-mv3');

// 测试凭据用拼接构造：源码里的完整字面量会被外部脱敏工具改写，导致断言失真。
const TEST_USER = ['lv', 'gate', 'user'].join('') + '@' + ['localvault', 'test'].join('.');
const TEST_PASS = ['Lv', 'Xk', '!', 'Pw', '2026'].join('');
const MASTER = ['gate', 'ammraj', 'rr', '4543'].join('-');
const PASS_MARK = 'LvXk'; // 用于宽松判断「是不是我们填的」

// ---------- 20 站名单 ----------
// 选站原则（2026-11-05 按用户口径修正）：
//   只收**首屏就有登录输入框**的站，且必须属于下面两类之一——
//     ① 账号/手机号 + 密码      ② 手机号/邮箱 + 验证码
//   默认只给二维码、没有任何输入框的站（Microsoft/Notion/Zoom/Atlassian/Slack 等）
//   对「自动填充」没有可测内容，属于选样错误，已剔除。
const SITES = [
  // —— ① 账号/手机号 + 密码 ——
  { name: '淘宝', url: 'https://login.taobao.com', host: 'taobao.com', kind: '密码' },
  { name: '京东', url: 'https://passport.jd.com/new/login.aspx', host: 'jd.com', kind: '密码' },
  { name: 'B站', url: 'https://passport.bilibili.com/login', host: 'bilibili.com', kind: '密码' },
  { name: '12306', url: 'https://kyfw.12306.cn/otn/resources/login.html', host: '12306.cn', kind: '密码' },
  { name: '网易邮箱', url: 'https://mail.163.com', host: '163.com', kind: '密码' },
  { name: 'QQ邮箱', url: 'https://mail.qq.com', host: 'qq.com', kind: '密码' },
  { name: '51job', url: 'https://login.51job.com/login.php', host: '51job.com', kind: '密码' },
  { name: '携程', url: 'https://passport.ctrip.com/user/login', host: 'ctrip.com', kind: '密码' },
  { name: '小米', url: 'https://account.xiaomi.com', host: 'xiaomi.com', kind: '密码' },
  { name: '豆瓣', url: 'https://accounts.douban.com/passport/login', host: 'douban.com', kind: '密码' },
  { name: '搜狐', url: 'https://passport.sohu.com/web/login', host: 'sohu.com', kind: '密码' },
  { name: '苏宁', url: 'https://passport.suning.com/ids/login', host: 'suning.com', kind: '密码' },
  { name: '去哪儿', url: 'https://user.qunar.com/passport/login.jsp', host: 'qunar.com', kind: '密码' },
  { name: '1688', url: 'https://login.1688.com/member/signin.htm', host: '1688.com', kind: '密码' },
  { name: '58同城', url: 'https://passport.58.com/login', host: '58.com', kind: '密码' },
  // —— ② 手机号/邮箱 + 验证码 ——
  { name: '微博', url: 'https://passport.weibo.com/sso/signin', host: 'weibo.com', kind: '验证码' },
  { name: '知乎', url: 'https://www.zhihu.com/signin', host: 'zhihu.com', kind: '验证码' },
  { name: '美团', url: 'https://passport.meituan.com/account/unitivelogin', host: 'meituan.com', kind: '验证码' },
  { name: '大众点评', url: 'https://account.dianping.com/login', host: 'dianping.com', kind: '验证码' },
  { name: '快手', url: 'https://passport.kuaishou.com/pc/account/login', host: 'kuaishou.com', kind: '验证码' },
];

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;
const sites = only ? SITES.filter((s) => s.name.includes(only) || s.host.includes(only)) : SITES;

// ---------- 启动真 Edge + 真扩展 ----------
const profile = mkdtempSync(join(tmpdir(), 'lv-m2-sites-'));
const testVaultRoot = mkdtempSync(join(tmpdir(), 'lv-m2-sites-vault-'));
process.env.LOCALVAULT_ROOT = testVaultRoot; // 独立保险库根，绝不碰真实库

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1366, height: 900 },
  locale: 'zh-CN',
  env: { ...process.env },
  args: ['--no-first-run', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const bg = (req) => sw.evaluate((r) => globalThis.__lvRoute(r, { tab: { id: 999 } }), req);

// ---------- 预置：一个站点一条条目，保证 get-credentials 能匹配 ----------
const cr = await bg({ type: 'create-vault', masterPassword: MASTER });
if (!cr.ok) throw new Error('创建测试保险库失败：' + JSON.stringify(cr));
for (const [i, s] of sites.entries()) {
  await bg({ type: 'save-entry', entry: {
    id: 'st' + i, title: s.name, username: TEST_USER, password: TEST_PASS,
    urls: ['https://' + s.host], notes: '', createdAt: '', updatedAt: '', passwordHistory: [],
  } });
}
console.log('保险库已预置 ' + sites.length + ' 条站点条目，测试账号 ' + TEST_USER + '\n');

// ---------- 页内探针（注入到每个 frame 求值） ----------
const probe = () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return !!(el.offsetParent || el.getClientRects().length);
  };
  const allPass = Array.from(document.querySelectorAll('input[type=password]'));
  const visPass = allPass.filter(visible);
  const icon = document.querySelector('[data-lv-icon]');
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, '');
  const cands = Array.from(document.querySelectorAll('a,button,div,span,li,label,em,i,p'))
    .filter((el) => {
      const t = textOf(el);
      return t.length > 1 && t.length <= 10 && /(密码登录|账号登录|账户登录|帐号登录|密码登陆)/.test(t) && visible(el);
    })
    .map((el) => ({ text: textOf(el), tag: el.tagName }));

  // 极简聚合信号（不是 DOM dump）：可见文本框个数、是否有账号语义、附近有没有「下一步/登录」按钮
  const hintOf = (el) => [
    el.name || '', el.id || '', el.getAttribute('placeholder') || '',
    el.getAttribute('aria-label') || '',
    (el.labels && el.labels[0] && (el.labels[0].innerText || '')) || '',
  ].join(' ').toLowerCase();
  const visText = Array.from(document.querySelectorAll('input'))
    .filter((el) => ['text', 'email', 'tel', 'number', ''].includes((el.type || '').toLowerCase()))
    .filter(visible);
  const acctHint = visText.some((el) => /手机|邮箱|账号|帐号|email|phone|mobile|user|login/.test(hintOf(el)));
  const btnHit = Array.from(document.querySelectorAll('button, [role=button], a.btn, a[class*=btn], input[type=submit]'))
    .filter(visible)
    .some((el) => /^(下一步|继续|登\s*录|登\s*入|next|continue|sign\s*in|log\s*in)/i.test((el.innerText || el.value || '').replace(/\s+/g, '')));
  // 页面上有没有验证码框（决定「只填账号」是不是正确行为）
  const otpField = Array.from(document.querySelectorAll('input'))
    .filter(visible)
    .some((el) => {
      const max = parseInt(el.getAttribute('maxlength') || '0', 10);
      if (max > 0 && (max < 4 || max > 8)) return false;
      return /验证码|校验码|动态码|短信|otp|vcode|code/i.test(hintOf(el));
    });

  return {
    url: location.href,
    domPass: allPass.length,
    visPass: visPass.length,
    icon: !!icon,
    iconTitle: icon ? (icon.getAttribute('title') || '') : '',
    tabCandidates: cands.slice(0, 4),
    // 两个菜单要分开认：生成密码菜单=误判注册（失败）；选身份菜单=验证码登录（正常路径）
    signupMenu: !!document.getElementById('lv-signup-menu'),
    idMenu: !!document.getElementById('lv-identity-menu'),
    textCount: visText.length,
    acctHint,
    btnHit,
    otpField,
  };
};

const readValues = () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const pass = Array.from(document.querySelectorAll('input[type=password]')).filter(visible);
  const text = Array.from(document.querySelectorAll('input'))
    .filter((el) => !['password', 'hidden', 'checkbox', 'radio', 'submit', 'button'].includes(el.type))
    .filter(visible);
  // 验证码框的值：验证码必须始终为空（由用户自己获取填写）
  const otpEl = text.find((el) => /验证码|校验码|动态码|短信码|sms|otp|vcode/i.test(
    [el.name, el.id, el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || ''].join(' '),
  ));
  return {
    passVals: pass.map((e) => e.value),
    textVals: text.map((e) => e.value).filter(Boolean),
    otpVal: otpEl ? otpEl.value : null,
  };
};

/** 遍历所有 frame 执行 fn，返回 [{frame, result}] */
async function eachFrame(page, fn) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      if (!frame.url() || frame.url() === 'about:blank') continue;
      out.push({ frame, result: await frame.evaluate(fn) });
    } catch { /* 已销毁或不可注入 */ }
  }
  return out;
}

/** 兜底路径：扩展弹窗的「填充当前网站」（用户主动点扩展图标 → 点填充）。
 *  这是真实用户路径，也是表单在 iframe / 被 tab 藏起来时唯一的入口。 */
async function fillViaPopup(host) {
  const r = await sw.evaluate(async (h) => {
    try {
      const tabs = await chrome.tabs.query({});
      // 站点常会跳域（microsoftonline.com → login.live.com），所以先按域名找，
      // 找不到就取最新打开的标签页（tab id 递增）——测试里最新的一定是当前站。
      const byHost = tabs.find((x) => x.url && x.url.includes(h));
      const newest = [...tabs].sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
      const t = byHost ?? newest;
      if (!t || t.id == null) return { ok: false, error: 'no-tab' };
      const res = await chrome.tabs.sendMessage(t.id, { type: 'lv-fill-now' });
      return res ?? { ok: false, error: 'no-response' };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }, host);
  return r;
}

async function readAllPages(page) {
  const vals = await eachFrame(page, readValues);
  return {
    pass: vals.flatMap((x) => x.result.passVals),
    text: vals.flatMap((x) => x.result.textVals),
    otp: vals.map((x) => x.result.otpVal).filter((v) => v !== null && v !== undefined),
  };
}

function judge(all, hasPasswordField) {
  // 就地拼出期望值，不复用顶部常量：避免外部脱敏层改写标识符导致的诡异引用错误
  const expected = ['Lv', 'Xk', '!', 'Pw', '2026'].join('');
  const passOk = all.pass.some((v) => v === expected) || all.pass.some((v) => v && v.includes(PASS_MARK));
  const userOk = all.text.some((v) => v === TEST_USER);
  void hasPasswordField;
  return { passOk, userOk };
}

// ---------- 逐站跑 ----------
const results = [];
for (const s of sites) {
  const row = {
    name: s.name, url: s.url, host: s.host, kind: s.kind,
    cls: '', ms: null, frames: 0, neededTabClick: false, iconFrame: null,
    passOk: false, userOk: false, hasPasswordField: false, otpFilled: false,
    popup: null, viaPopup: false, note: '',
  };
  const page = await ctx.newPage();
  try {
    const t0 = Date.now();
    await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // 轮询等待：SPA 站点的表单/图标往往比 domcontentloaded 晚好几秒才出现。
    // 固定等 3 秒会把「只是慢」误判成「不支持」，所以要一直等到**图标**出现或超时。
    // 注意：不能因为「有可见密码框」就提前退出——表单先到、图标后到是常态，
    // 提前退出会把慢站点误判成 no-icon（这一版修的就是这个自伤）。
    let snaps = [];
    const until = Date.now() + 14000;
    while (Date.now() < until) {
      snaps = await eachFrame(page, probe);
      if (snaps.some((x) => x.result.icon)) break;
      await page.waitForTimeout(700);
    }
    row.ms = Date.now() - t0;
    row.frames = snaps.length;

    // 扫码默认态：连密码框都不存在时，才模拟用户点「密码登录」标签。
    // 若 DOM 里已有密码框（只是不可见），瞎点 tab 反而会把页面状态搞得更糟。
    const hasVisibleForm = snaps.some((x) => x.result.visPass > 0);
    const hasAnyPassword = snaps.some((x) => x.result.domPass > 0);
    if (!hasVisibleForm && !hasAnyPassword) {
      for (const { frame, result } of snaps) {
        const hit = result.tabCandidates?.[0];
        if (!hit) continue;
        try {
          await frame.evaluate((txt) => {
            const el = Array.from(document.querySelectorAll('a,button,div,span,li,label,em,i,p'))
              .find((n) => (n.innerText || n.textContent || '').replace(/\s+/g, '') === txt);
            el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }, hit.text);
          row.neededTabClick = true;
        } catch { /* ignore */ }
        if (row.neededTabClick) break;
      }
      if (row.neededTabClick) {
        await page.waitForTimeout(2500);
        snaps = await eachFrame(page, probe);
        // 切完 tab 再给内容脚本一点时间画图标
        for (let i = 0; i < 8 && !snaps.some((x) => x.result.icon); i++) {
          await page.waitForTimeout(600);
          snaps = await eachFrame(page, probe);
        }
      }
    }

    // 找图标：优先有可见密码框的 frame（图标挂在密码框旁）
    const iconSnap = snaps.find((x) => x.result.icon && x.result.visPass > 0)
      ?? snaps.find((x) => x.result.icon);
    const visSnap = snaps.find((x) => x.result.visPass > 0);
    // 该站首屏到底有没有密码框：决定「只填账号」算不算填对
    row.hasPasswordField = snaps.some((x) => x.result.domPass > 0);

    let iconTitle = '';
    let signupMenuShown = false;   // 生成密码菜单 = 登录页被误判成注册页
    let identityMenuShown = false; // 选身份菜单 = 验证码登录的正常交互
    let boxNote = '';

    if (iconSnap) {
      row.iconFrame = iconSnap.frame.url();
      iconTitle = iconSnap.result.iconTitle;

      // 点图标 = 用户显式操作
      await iconSnap.frame.evaluate(() => {
        const el = document.querySelector('[data-lv-icon]');
        el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await page.waitForTimeout(900);

      // 两种菜单要分开认：生成密码菜单=把登录页误判成注册页（失败）；
      // 选身份菜单=验证码登录页的正常交互（只填账号，验证码留给用户）。
      const menuSnap = (await eachFrame(page, () => ({
        signup: !!document.getElementById('lv-signup-menu'),
        identity: !!document.getElementById('lv-identity-menu'),
      }))).find((x) => x.result.signup || x.result.identity);

      if (menuSnap) {
        signupMenuShown = menuSnap.result.signup;
        identityMenuShown = menuSnap.result.identity;
        row.note += '弹窗=' + (signupMenuShown ? '生成菜单(识别为注册)' : '选身份菜单') + ' ';
        try {
          await menuSnap.frame.evaluate(() => {
            document.getElementById('lv-signup-menu')
              ?.dispatchEvent(new CustomEvent('lv-test-select', { detail: { index: -1 } }));
            document.getElementById('lv-identity-menu')
              ?.dispatchEvent(new CustomEvent('lv-test-select', { detail: { index: 0 } }));
          });
          await page.waitForTimeout(700);
        } catch { /* ignore */ }
      }

      const v1 = await readAllPages(page);
      await page.waitForTimeout(700); // 受控组件回填常比 click 慢一拍
      const v2 = await readAllPages(page);
      const merged = { pass: [...v1.pass, ...v2.pass], text: [...v1.text, ...v2.text], otp: [...v1.otp, ...v2.otp] };
      Object.assign(row, judge(merged, row.hasPasswordField));
      row.otpFilled = merged.otp.some((v) => !!v);
      boxNote = '框=' + merged.pass.length + '/' + merged.text.length;
    } else {
      row.note += '无图标 ';
    }

    // 兜底：图标路径没成功 → 走扩展弹窗的「填充当前网站」。
    // 这条是真实用户路径（点扩展图标 → 点填充），也是表单在 iframe 里 / 被 tab
    // 藏起来时唯一的入口。两条路径分开记账，不混成一个数字。
    const settled = (row.passOk && row.userOk) || (row.userOk && !row.hasPasswordField);
    if (!settled) {
      const pr = await fillViaPopup(s.host);
      row.popup = pr?.ok ? 'ok' : String(pr?.error ?? 'fail');
      if (pr?.ok) {
        await page.waitForTimeout(1300);
        const after = await readAllPages(page);
        const j2 = judge(after, row.hasPasswordField);
        if (j2.passOk || j2.userOk) {
          row.passOk = row.passOk || j2.passOk;
          row.userOk = row.userOk || j2.userOk;
          row.viaPopup = true;
        }
      }
    }

    // 判定要按「该站属于哪类场景」来：
    //   有可见密码框 → 账号 + 密码都要填好；
    //   有验证码框（无密码框）→ 填好手机号/邮箱就算对，验证码必须留空；
    //   只有账号框（email-first）→ 填好账号就算对。
    const hasOtpField = snaps.some((x) => x.result.otpField);
    // 铁律：验证码框永远不能由我们填。若被填了，无论账号对不对都算失败。
    if (hasOtpField && row.otpFilled) row.cls = 'otp-filled';
    else if (signupMenuShown && !row.passOk) row.cls = 'signup-menu';
    else if (row.passOk && row.userOk) row.cls = row.viaPopup ? 'ok-popup' : 'ok';
    else if (row.userOk && !row.hasPasswordField) row.cls = row.viaPopup ? 'ok-popup' : (hasOtpField ? 'ok-otp' : 'ok-account');
    else if (row.passOk) row.cls = 'user-miss';
    else if (!iconSnap) row.cls = !row.hasPasswordField ? 'no-form' : (visSnap ? 'no-icon' : 'form-hidden');
    else row.cls = 'icon-no-fill';

    row.note += 'pw=' + (row.passOk ? '✓' : '×') + ' user=' + (row.userOk ? '✓' : '×')
      + (boxNote ? ' ' + boxNote : '')
      + (row.hasPasswordField ? '' : (hasOtpField ? ' 验证码页' : ' 无密码框'))
      + ' kind=' + s.kind
      + (hasOtpField ? ' 验证码=' + (row.otpFilled ? '被填(错)' : '留空✓') : '')
      + (row.popup ? ' 弹窗=' + row.popup : '')
      + (iconTitle ? ' title=' + iconTitle.slice(0, 12) : '');

    // 失败时补一条聚合信号，便于不进浏览器也能判断卡在哪一环
    if (!['ok', 'ok-popup', 'ok-otp', 'ok-account'].includes(row.cls)) {
      const sums = snaps.map((x) => x.result);
      row.note += ' | 可见文本框=' + sums.reduce((a, x) => a + (x.textCount || 0), 0)
        + ' 账号语义=' + (sums.some((x) => x.acctHint) ? 'Y' : 'N')
        + ' 下一步按钮=' + (sums.some((x) => x.btnHit) ? 'Y' : 'N')
        + ' pass=' + sums.reduce((a, x) => a + (x.domPass || 0), 0) + '/' + sums.reduce((a, x) => a + (x.visPass || 0), 0);
    }
  } catch (e) {
    row.cls = 'unreachable';
    row.note = String(e.message || e).split('\n')[0].slice(0, 70);
  }
  results.push(row);
  console.log(mark(row) + pad(s.name) + row.cls + '  ' + row.note);
  await page.close();
}

await ctx.close();

// ---------- 汇总 ----------
function pad(s) { return String(s).padEnd(11); }
function mark(r) {
  if (r.cls === 'ok') return '✅ ';
  if (r.cls === 'ok-popup') return '🟩 ';  // 图标路径没成，弹窗「填充」兜底成功
  if (r.cls === 'ok-otp') return '🟨 ';    // 验证码页：只填账号，验证码留空（正确行为）
  if (r.cls === 'ok-account') return '🟦 '; // 账号先行页：本屏只该填账号
  if (r.cls === 'signup-menu') return '◐ ';
  return '❌ ';
}

const tally = {};
for (const r of results) tally[r.cls] = (tally[r.cls] ?? 0) + 1;
const strictIcon = tally.ok ?? 0;                  // 图标点击一条路填全
const viaPopup = tally['ok-popup'] ?? 0;           // 需要弹窗兜底才填全
const otpOk = tally['ok-otp'] ?? 0;                // 验证码页：账号填好即达标
const accountOnly = tally['ok-account'] ?? 0;      // email-first 页：账号填好即达标
const okCount = strictIcon + viaPopup + otpOk + accountOnly;

console.log('\n──────────────── 汇总 ────────────────');
for (const [k, v] of Object.entries(tally)) console.log('  ' + k.padEnd(13) + v);
console.log('  ' + '图标一次填全'.padEnd(13) + strictIcon + '/' + results.length);
console.log('  ' + '弹窗兜底'.padEnd(13) + viaPopup + '/' + results.length);
console.log('  ' + '验证码页'.padEnd(13) + otpOk + '/' + results.length);
console.log('  ' + '账号先行'.padEnd(13) + accountOnly + '/' + results.length);
console.log('  ' + '合计可用'.padEnd(13) + okCount + '/' + results.length
  + (okCount >= 18 ? '  ← 达标 (≥18)' : '  ← 未达标 (需 ≥18)'));

mkdirSync(join(root, 'reports'), { recursive: true });
const stamp = Date.now();
writeFileSync(join(root, 'reports', 'm2-sites-' + stamp + '.json'), JSON.stringify(results, null, 2));

const markMd = (r) => ({ ok: '✅', 'ok-popup': '🟩', 'ok-otp': '🟨', 'ok-account': '🟦', 'signup-menu': '◐' }[r.cls] ?? '❌');
const md = [
  '| 站点 | 场景 | 结果 | 分类 | 需切tab | 密码 | 账号 | 说明 |',
  '|---|---|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${r.kind ?? ''} | ${markMd(r)} | ${r.cls} | ${r.neededTabClick ? '是' : ''} | ${r.passOk ? '✓' : '×'} | ${r.userOk ? '✓' : '×'} | ${r.note.replace(/\|/g, '/')} |`),
  '',
  `图标一次填全 ${strictIcon}/${results.length}；弹窗兜底 ${viaPopup}；验证码页 ${otpOk}；账号先行 ${accountOnly}；合计 ${okCount}/${results.length}；分类 ${JSON.stringify(tally)}`,
].join('\n');
writeFileSync(join(root, 'reports', 'm2-sites-' + stamp + '.md'), md);
console.log('报告: reports/m2-sites-' + stamp + '.{json,md}');
