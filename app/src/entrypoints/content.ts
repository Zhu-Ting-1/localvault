/**
 * 内容脚本：识别表单 + 字段旁图标 + 点击填充 + 提交捕获。
 *
 * 「点击才填」：绝不自动填充、绝不自动提交；填充后用户仍需自己点登录按钮。
 * 提交捕获只为「提示保存」，密码仅在用户确认保存时经 background 加密入库。
 */
import { type DetectedForm } from '../lib/detector';
import { detectDocument } from '../lib/detector.js';
import { showSaveFloat } from '../lib/save-float';
import { askUnlock } from '../lib/unlock-panel';
import { detectPasswordRule, collectRuleContext, applyRuleToGenOpts } from '../lib/rules';

const ICON_ID = 'lv-field-icon';

type Credentials = { username: string; password: string } | null;

// ---------- 消息 ----------

type BgEnvelope<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/** 解包信封版本：拿到完整响应（含 ok/code/message），调用方需要区分失败原因时用 */
function askBackgroundRaw<T extends { ok: boolean; code?: string; message?: string; data?: unknown }>(
  msg: Record<string, unknown>,
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const p = chrome.runtime.sendMessage(msg) as unknown as Promise<T>;
      p.then(resolve).catch(() => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

function askBackground<T>(msg: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const p = chrome.runtime.sendMessage(msg) as unknown as Promise<BgEnvelope<T>>;
      p.then((res) => resolve(res && res.ok ? (res.data as T) : null))
        .catch(() => resolve(null));
    } catch {
      resolve(null); // 扩展重载后旧脚本失效
    }
  });
}

// ---------- 填充（兼容 React/Vue 受控组件） ----------

/** 明文 HTTP 页面不填凭据。localhost 例外，本地开发要用。 */
function isInsecurePage(): boolean {
  if (location.protocol !== 'http:') return false;
  const h = location.hostname.toLowerCase();
  return !(h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost'));
}

function setValue(el: HTMLInputElement, value: string): boolean {
  try {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

// ---------- 字段旁图标 ----------

let lastForms: DetectedForm[] = [];

function iconFor(form: DetectedForm): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = ICON_ID;
  btn.dataset.lvIcon = '1';
  const isSignup = form.type === 'signup';
  const isOtp = form.type === 'otp';
  const isAccount = form.type === 'username-only';
  const personIcon = isOtp || isAccount; // 都是「填账号」语义
  btn.setAttribute('aria-label',
    isSignup ? 'LocalVault 生成密码'
    : isOtp ? 'LocalVault 选择常用身份'
    : isAccount ? 'LocalVault 填入账号'
    : 'LocalVault 填充');
  btn.title = isSignup
    ? 'LocalVault：点击生成并填充新密码（提交注册后会提示保存）'
    : isOtp
      ? 'LocalVault：点击选择手机号/邮箱填入（验证码请用自己的按钮获取）'
      : isAccount
        ? 'LocalVault：点击填入账号（本站密码在下一屏，下一步请自己点）'
        : 'LocalVault：点击填充（不会自动提交）';
  btn.style.cssText = [
    'all:initial',
    'position:absolute',
    'width:22px', 'height:22px',
    'border-radius:6px',
    'cursor:pointer',
    'z-index:2147483646',
    'display:grid', 'place-items:center',
    'background:' + (isSignup ? '#34c759' : '#2f95ff'), // 注册=绿（生成），其余=亮蓝
    'box-shadow:0 2px 8px ' + (isSignup ? 'rgba(52,199,89,.28)' : 'rgba(47,149,255,.28)') +
      ',inset 0 1px 0 rgba(255,255,255,.35)',
  ].join(';');
  btn.innerHTML = personIcon
    ? '<svg viewBox="0 0 24 24" style="width:14px;height:14px;color:#fff">' +
      '<rect x="3.5" y="4" width="17" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<circle cx="12" cy="9.8" r="2.3" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M7.9 16.4c.9-1.5 2.3-2.3 4.1-2.3s3.2.8 4.1 2.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" style="width:14px;height:14px;color:#fff">' +
      '<path d="M12 2 4.5 5.2v5.6c0 4.4 3.1 8.4 7.5 9.6 4.4-1.2 7.5-5.2 7.5-9.6V5.2L12 2Z" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M8.8 12.1 11 14.3l4.2-4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // 「点击才填」的完整动作。抽成函数是为了**解锁后能整段重跑**：
  // 用户在页内解锁成功 → 重新走一遍本函数 → 表单里已经有的内容不会被清掉。
  const run = async (): Promise<void> => {
    const fillT0 = performance.now();
    // 明文 HTTP 不填（localhost 例外）：凭据填进 http 页面后一旦提交就是裸奔传输。
    if (isInsecurePage()) {
      showBadge('此页面是 HTTP 明文传输，为安全起见不填充；可在扩展弹窗里复制', '#ff9500');
      return;
    }

    // 验证码登录（无密码框）：只选身份填账号，不生成密码、不碰验证码
    if (form.type === 'otp') {
      const res = await askBackgroundRaw<{
        ok: boolean; code?: string; message?: string;
        data?: { identities?: Array<{ id: string; label: string; value: string }> };
      }>({ type: 'get-identities', url: location.href });
      if (!res || !res.ok) {
        const code = res?.code ?? 'no-response';
        if (code === 'locked') {
          if (!retriedAfterUnlock && await tryUnlock()) return run();
          showBadge('保险库仍处于锁定状态，点图标可再次解锁', '#ff9500');
          return;
        }
        showBadge(
          code === 'no-vault' ? '尚未创建保险库，点扩展图标开始'
          : code === 'insecure-http' ? '此页面是 HTTP 明文传输，为安全起见不填充'
          : 'LocalVault：' + (res?.message ?? '连接失败'),
          '#ff9500',
        );
        return;
      }
      const { showIdentityMenu } = await import('../lib/identity-menu');
      const accountEls = form.username?._el ? [form.username._el] : [];
      showIdentityMenu(res.data?.identities ?? [], { accountEls }, () => { /* 已填充 */ });
      return;
    }

    // 账号先行（email-first）：本屏只有账号框，密码在下一屏。
    // 只填账号，**不点「下一步」**——提交动作永远由用户自己做。
    if (form.type === 'username-only') {
      const res = await askBackgroundRaw<{
        ok: boolean; code?: string; message?: string;
        data?: { username?: string; password?: string; matches?: AccountMatch[] } | null;
      }>({ type: 'get-credentials', url: location.href });
      if (!res || !res.ok) {
        const code = res?.code ?? 'no-response';
        if (code === 'locked') {
          if (!retriedAfterUnlock && await tryUnlock()) return run();
          showBadge('保险库仍处于锁定状态，点图标可再次解锁', '#ff9500');
          return;
        }
        showBadge(
          code === 'no-vault' ? '尚未创建保险库，点扩展图标开始'
          : code === 'insecure-http' ? '此页面是 HTTP 明文传输，为安全起见不填充'
          : 'LocalVault：' + (res?.message ?? '连接失败'),
          '#ff9500',
        );
        return;
      }
      if (!res.data?.username) {
        showBadge('本站没有保存的账号——可在扩展弹窗里新增', '#ff9500');
        return;
      }
      const el = form.username?._el;
      if (!el) {
        showBadge('找不到账号输入框，请刷新页面再试', '#ff9500');
        return;
      }
      // 本站多个账号：让用户选，不要闷头填第一个
      if ((res.data?.matches?.length ?? 0) > 1) {
        const { showAccountMenu } = await import('../lib/account-menu');
        showAccountMenu(res.data!.matches!, { usernameEl: el, passwordEls: [] }, () => {
          showBadge('已填入账号，请点站点自己的「下一步」继续（不会替你提交）', '#2f95ff');
        });
        return;
      }
      setValue(el, res.data.username);
      el.focus();
      emitFillTiming('account-only', fillT0);
      showBadge('已填入账号，请点站点自己的「下一步」继续（不会替你提交）', '#2f95ff');
      return;
    }

    // 站点密码规则：只在此刻针对当前密码框检测。「注册优先」——规则只需在生成时满足，
    // 登录是把已存密码原样填回，站点不会再校验规则，故登录路径无需适配。
    const pwEl: HTMLInputElement | null =
      form.password?._el ?? form.passwords.find((p) => p.fillable && p._el)?._el ?? null;
    const rule = detectPasswordRule(pwEl, { scopeText: pwEl ? collectRuleContext(pwEl) : '' });
    const genOpts = applyRuleToGenOpts(rule);

    // 统一先取数据，锁定/无匹配都有明确反馈（绝不静默失败）
    const bgRes = await askBackgroundRaw<{ ok: boolean; code?: string; message?: string; data?: { password?: string; identities?: Array<{ id: string; label: string; value: string }>; username?: string } }>({
      type: form.type === 'signup' ? 'get-signup-options' : 'get-or-generate',
      url: location.href,
      formType: topFormType(),
      genOpts,
    });

    if (!bgRes || !bgRes.ok) {
      // 锁定 → 页内解锁后重跑；其余错误给明确提示
      const code = bgRes?.code ?? 'no-response';
      if (code === 'locked') {
        if (!retriedAfterUnlock && await tryUnlock()) return run();
        showBadge('保险库仍处于锁定状态，点图标可再次解锁', '#ff9500');
        return;
      }
      showBadge(
        code === 'no-vault' ? '尚未创建保险库，点扩展图标开始'
        : code === 'insecure-http' ? '此页面是 HTTP 明文传输，为安全起见不填充'
        : 'LocalVault：' + (bgRes?.message ?? '连接失败'),
        '#ff9500',
      );
      return;
    }

    const payload = bgRes.data;

    // 单密码框 + 本站已有保存账号 → 当登录处理，直接回填。
    // 为什么需要这条：不少登录页把密码框标成 autocomplete=new-password，或 URL 里带
    // register 字样，识别器会判成注册；对用户来说「本站有我的账号，点一下就该登进去」，
    // 弹「生成新密码」是错的出路。真正的注册页有两个密码框，不受影响。
    if (form.type === 'signup' && payload?.password) {
      const fillablePw = form.passwords.filter((p) => p.fillable && p._el);
      if (fillablePw.length === 1) {
        const existing = await askBackground<{ username?: string; password?: string } | null>(
          { type: 'get-credentials', url: location.href },
        );
        if (existing?.password) {
          if (form.username?._el && existing.username) setValue(form.username._el, existing.username);
          setValue(fillablePw[0]!._el!, existing.password);
          fillablePw[0]!._el!.focus();
          emitFillTiming('signup-override', fillT0);
          showBadge('已填入本站已存账号（要注册新账号请用弹窗里的生成器）', '#2f95ff');
          return;
        }
      }
    }

    // 注册表单：弹「生成密码 + 备选身份」菜单，点选身份一并填入
    if (form.type === 'signup' && payload?.password) {
      const { showSignupMenu } = await import('../lib/signup-menu');
      const usernameEls: HTMLInputElement[] = [];
      if (form.username?._el) usernameEls.push(form.username._el);
      // 注册表单常有「确认密码」第二格：同一容器内的所有可填充密码框都填
      const passwordEls = form.passwords
        .filter((p) => p.fillable && p._el)
        .map((p) => p._el!);
      showSignupMenu(
        { password: payload.password, identities: payload.identities ?? [], rule, genOpts },
        { usernameEls, passwordEls: passwordEls.length ? passwordEls : (form.password?._el ? [form.password._el] : []) },
        () => { /* 填充完成（浮窗消失即反馈） */ },
      );
      return;
    }

    // 登录/改密表单：有匹配直接填充；无匹配弹「生成密码」菜单（覆盖误分类场景，
    // 用户永远有生成出路，而不是一句「本站没有保存的账号」）
    const cred = payload as { username?: string; password?: string; generated?: boolean; matches?: AccountMatch[]; identities?: Array<{ id: string; label: string; value: string }> } | null;
    if (!cred?.password) {
      showBadge('本站没有保存的账号——可在扩展弹窗里新增，或点图标生成新密码', '#ff9500');
      return;
    }
    if (cred.generated) {
      // 误分类/新站注册：直接弹生成菜单（与 signup 同款交互）
      const { showSignupMenu } = await import('../lib/signup-menu');
      const usernameEls: HTMLInputElement[] = [];
      if (form.username?._el) usernameEls.push(form.username._el);
      const passwordEls = form.passwords
        .filter((p) => p.fillable && p._el)
        .map((p) => p._el!);
      showSignupMenu(
        { password: cred.password, identities: cred.identities ?? [], rule, genOpts },
        { usernameEls, passwordEls: passwordEls.length ? passwordEls : (form.password?._el ? [form.password._el] : []) },
        () => { /* 填充完成 */ },
      );
      return;
    }
    // 同站多账号：先让用户选一个，不要闷头填第一条。
    // v2：matches 里没有密码（列表路径不碰 secret），选定后按 id 现取一条再填。
    if ((cred.matches?.length ?? 0) > 1) {
      const { showAccountMenu } = await import('../lib/account-menu');
      const passwordEls = form.passwords.filter((p) => p.fillable && p._el).map((p) => p._el!);
      showAccountMenu(cred.matches!, {
        usernameEl: form.username?._el ?? null,
        passwordEls: passwordEls.length ? passwordEls : (form.password?._el ? [form.password._el] : []),
      }, async (row) => {
        const s = await askBackgroundRaw<{ ok: boolean; data?: { password?: string } }>({
          type: 'get-entry-secret', id: row.id,
        });
        return { ...row, password: s?.data?.password ?? '' };
      });
      return;
    }

    if (form.username && form.username._el && cred.username) setValue(form.username._el, cred.username);
    if (form.password && form.password._el) {
      setValue(form.password._el, cred.password);
      form.password._el.focus();
    }
    emitFillTiming('icon', fillT0);
  };

  // 解锁成功后只重跑一次，避免「解锁 → 又 locked → 再弹面板」的死循环
  let retriedAfterUnlock = false;
  const tryUnlock = async (): Promise<boolean> => {
    retriedAfterUnlock = true;
    return askUnlock();
  };

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // 页面脚本可以合成 click 让扩展去填当前站凭据（等于绕过「必须真人点」）
    if (!ev.isTrusted) return;
    void run();
  });
  return btn;
}

/** 页面内轻提示（2.5s 自动消失，不打扰） */let badgeTimer: number | undefined;
function showBadge(text: string, color: string): void {
  document.getElementById('lv-badge')?.remove();
  if (badgeTimer) clearTimeout(badgeTimer);
  const host = document.createElement('div');
  host.id = 'lv-badge';
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      .b { background: rgba(26,38,54,.86); color: #fff; border: 1px solid rgba(255,255,255,.16);
           border-radius: 11px; padding: 10px 14px; backdrop-filter: blur(14px) saturate(1.3);
           -webkit-backdrop-filter: blur(14px) saturate(1.3);
           font: 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
           box-shadow: 0 10px 26px rgba(20,40,70,.22), 0 1px 0 rgba(255,255,255,.12) inset;
           max-width: 300px; animation: lvb .15s ease-out; }
      @keyframes lvb { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; transform: none; } }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: ${color}; }
    </style>
    <div class="b"><span class="dot"></span>${text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)}</div>`;
  document.documentElement.appendChild(host);
  badgeTimer = window.setTimeout(() => host.remove(), 2600);
}

function topFormType(): string {
  return lastForms[0]?.type ?? 'login';
}

/** 同站多账号的一条记录（background 的 get-credentials / get-or-generate 的 matches） */
type AccountMatch = { id: string; title: string; username: string; password: string };

/** 审计用的站点标识：只留 origin + 路径，丢掉查询串与片段
 *  （带 token 的链接 / ?code=… 不能进日志）。 */
function auditSite(): string {
  try {
    const u = new URL(location.href);
    return (u.origin + u.pathname).slice(0, 200);
  } catch {
    return '';
  }
}

/** 填充耗时埋点（目标 < 100ms）。只派发 DOM 事件，不联网、不落盘、不含任何凭据。 */
function emitFillTiming(kind: string, t0: number): void {
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  try {
    document.dispatchEvent(new CustomEvent('lv-fill-timing', { detail: { kind, ms } }));
  } catch { /* 忽略 */ }
  // 审计：用户确实点了填充按钮（图标 / popup / 账号先行 / 注册覆盖都会走到这里）。
  // 只上报站点与标题等元数据，密码永远不出现在消息或日志里；失败不阻塞填充。
  try {
    void Promise.resolve(chrome.runtime.sendMessage({
      type: 'report-fill',
      site: auditSite(),
      tab: (document.title || '').slice(0, 120),
      method: kind,
    })).catch(() => {});
  } catch { /* 忽略 */ }
}

function positionIcon(btn: HTMLElement, input: HTMLInputElement): void {
  const r = input.getBoundingClientRect();
  if (r.width === 0) return;
  btn.style.left = Math.round(r.right + window.scrollX - 24) + 'px';
  btn.style.top = Math.round(r.top + window.scrollY + (r.height - 22) / 2) + 'px';
  (btn.style as CSSStyleDeclaration & { position: string }).position = 'absolute';
}

function renderIcons(): void {
  document.querySelectorAll(`[data-lv-icon]`).forEach((n) => n.remove());
  const top = lastForms[0];
  if (!top) return;
  // 验证码登录没有密码框：图标挂在手机号/邮箱框上，点开是「选择常用身份」
  const anchorEl = top.type === 'otp'
    ? (top.username?._el ?? null)
    : (top.password?._el ?? top.username?._el ?? null);
  if (!anchorEl) return;
  const btn = iconFor(top);
  document.documentElement.appendChild(btn);
  positionIcon(btn, anchorEl);
  const reposition = () => positionIcon(btn, anchorEl);
  window.addEventListener('scroll', reposition, { passive: true, once: true });
  window.addEventListener('resize', reposition, { passive: true, once: true });
}

// ---------- 提交捕获（保存提示的数据源） ----------

let lastSubmit: { username: string; password: string; url: string } | null = null;
/** 最近一次输入过的账号/密码（仅内存、不落盘）：提交时 DOM 常已被清空或换节点 */
let typedSnapshot: { username: string; password: string } | null = null;
let lastFloatAt = 0;

function visibleUsername(): string {
  const fromForm = lastForms[0]?.username?._el?.value;
  if (fromForm) return fromForm;
  const inputs = Array.from(document.querySelectorAll('input'));
  const found = inputs.find((i) => i.type !== 'password' && i.type !== 'hidden' && i.value && i.getClientRects().length);
  return found?.value ?? '';
}

/** 读当前可用的账号密码：优先 DOM 现值，DOM 被清空时用输入快照兜底 */
function currentCandidate(): { username: string; password: string; url: string; title: string } | null {
  const domPassword = lastForms[0]?.password?._el?.value ?? '';
  const password = domPassword || typedSnapshot?.password || '';
  if (!password) return null;
  const username = visibleUsername() || typedSnapshot?.username || '';
  return { username, password, url: location.origin, title: (document.title || '').slice(0, 120) };
}

// 明显的失败文案：命中就**不问要不要保存**——记错密码的尝试不该被塞进保险库。
// 只认短元素（≤40 字）里的文案，避免把帮助文档里整段说明当成错误提示。
const FAIL_HINTS = /(密码错误|密码不正确|账号或密码|帐号或密码|用户名或密码|验证码错误|验证码不正确|登录失败|登入失败|用户名不存在|账号不存在|帐号不存在|incorrect|invalid password|wrong password|authentication failed)/i;

function looksLikeLoginFailed(): boolean {
  const els = Array.from(document.querySelectorAll('div,span,p,li,em,strong,label,small,a'));
  return els.some((el) => {
    const t = (el.textContent || '').trim();
    if (!t || t.length > 40) return false;
    if (!FAIL_HINTS.test(t)) return false;
    return el.getClientRects().length > 0;
  });
}

function onPossibleSubmit(_reason: string): void {
  const cand = currentCandidate();
  if (!cand?.password) return;
  const now = Date.now();
  if (now - lastFloatAt < 4000) return; // 同一次提交的重试/重复事件不连弹
  lastFloatAt = now;
  lastSubmit = cand;
  void askBackground({ type: 'lv-store-last-submit', submit: { ...cand, _from: location.href } });
  // 延 1 秒再弹：留出时间看站点是否当场报错（登录失败时不该问「要不要保存」）。
  // 若这 1 秒里页面跳转，浮窗本来也会随文档销毁，由 reShowFloatAfterNavigation 在新页补弹。
  window.setTimeout(() => {
    if (looksLikeLoginFailed()) {
      lastSubmit = null;
      void askBackground({ type: 'lv-clear-last-submit' });
      return;
    }
    showSaveFloat(cand, () => { /* 已保存 */ }, () => {
      void askBackground({ type: 'lv-clear-last-submit' });
    });
  }, 1000);
}

function hookInputSnapshot(): void {
  document.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | null;
    if (!el || el.tagName !== 'INPUT') return;
    if (el.type === 'password' && el.value) {
      typedSnapshot = { username: visibleUsername(), password: el.value };
    }
  }, true);
}

// 提交类按钮文案：SPA 常只有 click + AJAX，不会触发原生 submit 事件
const SUBMIT_WORDS = /^(立即注册|马上注册|注册|提交注册|完成注册|下一步|提交|确认|确定|登\s*录|登录|sign\s*up|register|submit|continue|create\s*account|sign\s*in|log\s*in)/i;
const NOT_SUBMIT_WORDS = /验证码|获取|发送|同意|协议|条款|刷新|更换|忘记|找回|显示|隐藏|返回|取消|下载|扫码|切换|密码可见/;

function hookSubmitClicks(): void {
  document.addEventListener('click', (e) => {
    const el = e.target as Element | null;
    const btn = el?.closest?.('button, input[type=submit], a[role=button], [role=button], [type=submit]') as HTMLElement | null;
    if (!btn) return;
    const text = (btn.innerText || (btn as HTMLInputElement).value || btn.getAttribute('aria-label') || '').trim();
    if (!text || text.length > 20 || NOT_SUBMIT_WORDS.test(text) || !SUBMIT_WORDS.test(text)) return;
    if (!lastForms.length && !typedSnapshot) return;
    // 等站点本轮的同步校验/赋值跑完再读值
    setTimeout(() => onPossibleSubmit('click:' + text), 0);
  }, true);
}

function hookSubmit(): void {
  document.addEventListener('submit', (e) => {
    const target = e.target as Element | null;
    const hasPassword = !!target?.querySelector?.('input[type="password"]');
    const matchesContainer = lastForms.some((f) => f.container && (
      target?.matches?.(f.container) || target?.closest?.(f.container)
    ));
    // 不再强依赖 container 选择器：真实页面常把提交按钮包在 div 里，或用 form.submit() 编程提交
    if (hasPassword || matchesContainer || typedSnapshot) onPossibleSubmit('submit');
  }, true);
}

/** 注册成功后整页跳转：原页面浮窗随文档销毁，在新页面补弹一次 */
async function reShowFloatAfterNavigation(): Promise<void> {
  const p = await askBackground<{
    username?: string; password?: string; url?: string; _at?: number; _from?: string;
  }>({ type: 'lv-peek-last-submit' });
  if (!p?.password || !p._at || Date.now() - p._at > 60_000) return;
  if (p._from && p._from === location.href) return; // 同 URL 刷新，不重复打扰
  let shownAt = 0;
  try { shownAt = Number(sessionStorage.getItem('lv:save-float-shown-at') || 0); } catch { /* 隐私模式 */ }
  if (shownAt >= p._at) return;
  try { sessionStorage.setItem('lv:save-float-shown-at', String(p._at)); } catch { /* ignore */ }
  showSaveFloat(
    { username: p.username ?? '', password: p.password, url: p.url ?? location.origin },
    () => { /* 已保存（浮窗自身消失即反馈） */ },
    () => { void askBackground({ type: 'lv-clear-last-submit' }); },
  );
}

// ---------- 扫描调度 ----------

let scanTimer: number | undefined;

function schedule(): void {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = window.setTimeout(() => {
    if (!document.documentElement) return;
    try {
      const result = detectDocument(document, window);
      lastForms = result.forms;
      renderIcons();
      // 上报给 background（保存提示与 popup 显示用）
      void askBackground({
        type: 'lv-forms-report',
        url: location.href,
        origin: location.origin,
        isTop: window.top === window,
        forms: lastForms.map((f) => ({
          type: f.type,
          confidence: f.confidence,
          hasUsername: !!f.username,
          usernameName: f.username?.name ?? f.username?.id ?? null,
          passwordCount: f.passwords.filter((p) => p.fillable).length,
        })),
      });
    } catch {
      // 页面极端 DOM 不阻塞
    }
  }, 250);
}

// ---------- 扫码默认页的兜底：用户主动点「填充」时替他切到密码登录 ----------
// 注意边界：**只在用户显式发起填充时**调一次，绝不在页面加载时自动点。
// 站点把二维码当默认登录方式时，页面上根本不存在密码框，没有别的入口。
const TAB_REVEAL = /^(密码登录|账号登录|账户登录|帐号登录|密码登陆|账号密码登录|帐号密码登录|使用密码登录)$/;

function revealPasswordForm(): boolean {
  const norm = (s: string) => (s || '').replace(/\s+/g, '');
  const els = Array.from(document.querySelectorAll('a,button,div,span,li,label,p,em,i'));
  const hit = els.find((el) => {
    const t = norm((el as HTMLElement).innerText || '');
    if (!t || t.length > 12 || !TAB_REVEAL.test(t)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }) as HTMLElement | undefined;
  if (!hit) return false;
  try {
    hit.click();
  } catch {
    return false;
  }
  return true;
}

// ---------- 入口 ----------

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  main() {
    if (typeof MutationObserver === 'undefined' || typeof window === 'undefined') return;
    hookSubmit();
    hookInputSnapshot();
    hookSubmitClicks();
    void reShowFloatAfterNavigation();

  const observer = new MutationObserver(() => schedule());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('focusin', schedule, true);
  window.addEventListener('pageshow', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  document.addEventListener('DOMContentLoaded', schedule, { once: true });
  schedule();

  // background/popup 触发的填充（用户在 popup 点「填充」，同样是显式点击）
  chrome.runtime.onMessage.addListener((msg: { type?: string; url?: string }, _s, sendResponse) => {
    if (msg?.type === 'lv-fill-now') {
      void (async () => {
        const t0 = performance.now();
        const usable = (f?: DetectedForm) =>
          !!f && (!!f.password?._el || ((f.type === 'otp' || f.type === 'username-only') && !!f.username?._el));

        let top = lastForms[0];
        if (!usable(top)) {
          // 站点切 tab / 展开面板后，表单是分批渲染的：切一次就等死容易误判「没有表单」。
          // 这里轮询到 ~4 秒，中途还没成再补点一次标签。
          const rescan = () => {
            try {
              lastForms = detectDocument(document, window).forms;
              renderIcons();
            } catch { /* 极端 DOM 不阻塞 */ }
            return lastForms[0];
          };
          let revealed = revealPasswordForm();
          for (let i = 0; i < 14 && !usable(top); i++) {
            await new Promise((r) => setTimeout(r, 300));
            top = rescan();
            if (!revealed && i === 4) revealed = revealPasswordForm();
          }
        }
        if (!usable(top)) {
          sendResponse({ ok: false, error: '此页面没有可填充表单' });
          return;
        }
        const accountEl = top!.username?._el ?? null;
        const pwEl = top!.password?._el ?? null;
        const credRes = await askBackgroundRaw<{
          ok: boolean; code?: string; message?: string; data?: Credentials;
        }>({ type: 'get-credentials', url: location.href });
        if (!credRes || !credRes.ok) {
          const code = credRes?.code ?? 'no-response';
          sendResponse({
            ok: false,
            error: code === 'insecure-http' ? 'HTTP 明文页面不填充凭据'
              : code === 'locked' ? '保险库已锁定'
              : '本站没有保存的账号',
          });
          return;
        }
        const cred = credRes.data;
        if (!cred?.password) {
          sendResponse({ ok: false, error: '本站没有保存的账号' });
          return;
        }
        if (accountEl && cred.username) setValue(accountEl, cred.username);
        if (pwEl) {
          setValue(pwEl, cred.password);
          pwEl.focus();
        } else if (accountEl) {
          accountEl.focus();
          showBadge('已填入账号，请点站点自己的「下一步」继续（不会替你提交）', '#2f95ff');
        }
        emitFillTiming('popup', t0);
        sendResponse({ ok: true });
      })();
      return true; // async
    }
    if (msg?.type === 'lv-get-last-submit') {
      sendResponse(lastSubmit);
      lastSubmit = null;
    }
    return false;
  });
  },
});