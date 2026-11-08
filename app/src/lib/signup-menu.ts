/**
 * 注册页选择菜单（closed shadow DOM，样式隔离）：
 * 展示按**本站密码规则**生成的密码 + 备选身份（手机/邮箱），
 * 点「使用此密码」或点选身份即连同密码一并填入表单。
 *
 * 规则来源：内容脚本在点击图标那一刻读取密码框的 maxlength/minlength/pattern
 * 及邻近提示文字（如「6~30位字母或数字」）。检测不到就按默认 20 位带符号生成，
 * 用户也可在菜单里手动改长度 / 关符号——检测只是兜底，永远留手动出路。
 */
import type { Identity } from './session';
import { TEST_BRIDGE } from './test-bridge';
import type { SiteRule, GenParams } from './rules';
import { maskValue } from './mask';

const MENU_ID = 'lv-signup-menu';

interface SignupOptions {
  password: string;
  identities: Identity[];
  rule?: SiteRule;
  genOpts?: GenParams;
}

export interface SignupFormTargets {
  usernameEls: HTMLInputElement[];
  passwordEls: HTMLInputElement[];
}

export function showSignupMenu(
  opts: SignupOptions,
  targets: SignupFormTargets,
  onFilled: () => void,
): void {
  hideSignupMenu();

  const rule: SiteRule = opts.rule ?? {};
  const host = document.createElement('div');
  host.id = MENU_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const idRows = opts.identities.length
    ? opts.identities.map((id, i) => `
      <button class="idrow" data-i="${i}">
        <span class="lbl">${escapeHtml(id.label)}</span>
        <span class="val">${escapeHtml(maskValue(id.value))}</span>
      </button>`).join('')
    : '<div class="noid">还没有常用身份，在扩展弹窗 → 设置里添加手机号 / 邮箱</div>';

  const ruleNote = rule.note
    ? `<div class="detected"><span class="dot"></span>已适配本站规则：<b>${escapeHtml(rule.note)}</b></div>`
    : '<div class="detected muted"><span class="dot"></span>未检测到本站限制，按默认 20 位生成（可自行调整）</div>';
  const sourceLine = (rule.sources ?? []).length
    ? `<div class="src">依据：${escapeHtml((rule.sources ?? []).slice(0, 2).join('、'))}</div>`
    : '';

  const startLen = opts.genOpts?.length ?? 20;
  const startSymbols = rule.symbolsRequired ? true : (opts.genOpts?.symbols ?? true);
  const symbolsLocked = rule.symbolsAllowed === false || rule.symbolsRequired === true;

  shadow.innerHTML = `
    <style>
      :host { all: initial; color-scheme: light; }
      .card {
        width: 320px; box-sizing: border-box; background: rgba(255,255,255,.84);
        border: 1px solid rgba(255,255,255,.92); border-radius: 14px;
        box-shadow: 0 14px 34px rgba(30,90,170,.18), 0 0 0 1px rgba(20,90,170,.06), 0 1px 0 rgba(255,255,255,.9) inset;
        backdrop-filter: blur(20px) saturate(1.5); -webkit-backdrop-filter: blur(20px) saturate(1.5);
        padding: 13px; font: 12.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
        color: #16202e; animation: lv-in .16s ease-out;
      }
      @keyframes lv-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      .t { font-weight: 650; font-size: 13px; letter-spacing: .1px; }
      .pw {
        margin-top: 9px; padding: 9px 10px; background: rgba(233,243,255,.78);
        border: 1px solid rgba(255,255,255,.9); border-left: 2px solid #2f95ff; border-radius: 9px;
        box-shadow: 0 1px 0 rgba(255,255,255,.9) inset;
        font-family: ui-monospace, Consolas, monospace; font-size: 12px;
      }
      .pw .mono { word-break: break-all; user-select: all; color: #16202e; }
      .rulebox {
        margin-top: 9px; padding: 9px 10px; background: rgba(240,247,255,.66);
        border: 1px solid rgba(255,255,255,.9); border-radius: 10px;
        box-shadow: 0 1px 0 rgba(255,255,255,.9) inset;
      }
      .detected { font-size: 11.5px; color: #2f95ff; display: flex; align-items: center; gap: 6px; }
      .detected.muted { color: #71839a; }
      .detected b { font-weight: 650; }
      .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #2f95ff; flex: none; }
      .detected.muted .dot { background: #a9b8cc; }
      .src { margin-top: 4px; font-size: 10.5px; color: #9aabc0; word-break: break-all; }
      .tune { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 11.5px; color: #71839a; }
      .tune label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
      .tune input[type=number] {
        width: 46px; padding: 3px 5px; border: 1px solid rgba(20,90,170,.14); border-radius: 7px;
        font: 11.5px/1.3 inherit; color: #16202e; background: rgba(255,255,255,.82);
      }
      .tune input[type=checkbox] { accent-color: #2f95ff; margin: 0; cursor: pointer; }
      .tune input:disabled { cursor: not-allowed; opacity: .65; }
      .warn { margin-top: 6px; font-size: 11px; color: #b26a12; }
      .warn:empty { display: none; }
      .sec { margin-top: 10px; font-size: 11px; color: #71839a; }
      .idrow {
        display: flex; width: 100%; gap: 8px; align-items: center; margin-top: 5px; box-sizing: border-box;
        appearance: none; border: 1px solid rgba(20,90,170,.10); border-radius: 10px;
        background: rgba(255,255,255,.72); backdrop-filter: blur(8px);
        padding: 8px 10px; cursor: pointer; font: 12px/1.3 inherit; color: #16202e; text-align: left;
      }
      .idrow:hover { background: rgba(233,243,255,.92); border-color: rgba(47,149,255,.35); }
      .idrow .lbl { color: #71839a; flex: none; }
      .idrow .val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .noid { margin-top: 8px; font-size: 11px; color: #9aabc0; padding: 6px 0; }
      .acts { display: flex; gap: 6px; margin-top: 10px; }
      button { appearance: none; border: 1px solid rgba(20,90,170,.12); border-radius: 10px;
               background: rgba(255,255,255,.75); color: #16202e; font: 12px/1 inherit;
               padding: 7px 12px; cursor: pointer; backdrop-filter: blur(8px); }
      button:hover { background: rgba(233,243,255,.9); border-color: rgba(47,149,255,.28); }
      button.primary { flex: 1; background: #2f95ff; border-color: #2f95ff; color: #fff; font-weight: 600;
               box-shadow: 0 1px 0 rgba(255,255,255,.35) inset, 0 3px 8px rgba(47,149,255,.18); }
      button.primary:hover { background: #1f86f5; }
    </style>
    <div class="card">
      <div class="t">生成注册密码</div>
      <div class="pw"><span class="mono">${escapeHtml(opts.password)}</span></div>
      <div class="rulebox">
        ${ruleNote}
        ${sourceLine}
        <div class="tune">
          <label>长度 <input type="number" id="len" min="4" max="64" value="${startLen}"> 位</label>
          <label><input type="checkbox" id="sym" ${startSymbols ? 'checked' : ''} ${symbolsLocked ? 'disabled' : ''}> 含特殊字符</label>
        </div>
        ${symbolsLocked ? '<div class="src">符号开关由本站规则锁定</div>' : ''}
        <div class="warn" id="warn"></div>
      </div>
      <div class="acts">
        <button class="primary use" id="use">使用此密码</button>
        <button class="regen" id="regen">换一个</button>
      </div>
      ${opts.identities.length ? `<div class="sec">选择账号（打码显示，点选填入完整值）：</div>${idRows}` : ''}
    </div>`;


  let currentPassword = opts.password;
  let genOpts: GenParams = { length: startLen, symbols: startSymbols };
  const mono = shadow.querySelector('.mono')!;
  const warnEl = shadow.getElementById('warn')!;

  /** 生成结果是否真的能过本站规则；extra 用于填充后被站点改写的兜底提示 */
  const refreshWarn = (extra?: string) => {
    let msg = extra ?? '';
    if (!msg) {
      if (rule.minLength !== undefined && currentPassword.length < rule.minLength) msg = `密码至少 ${rule.minLength} 位`;
      else if (rule.maxLength !== undefined && currentPassword.length > rule.maxLength) msg = `超出本站上限 ${rule.maxLength} 位，请调小长度`;
      else if (rule.symbolsAllowed === false && /[^a-zA-Z0-9]/.test(currentPassword)) msg = '本站不允许特殊字符';
      else if (rule.symbolsRequired && !/[^a-zA-Z0-9]/.test(currentPassword)) msg = '本站要求包含特殊字符';
    }
    warnEl.textContent = msg;
  };
  refreshWarn();

  const regenerate = async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'get-signup-options', genOpts })) as
        | { ok: true; data: SignupOptions } | { ok: false; code?: string };
      if (res && res.ok) {
        currentPassword = res.data.password;
        mono.textContent = currentPassword;
        refreshWarn();
      } else {
        refreshWarn(res?.code === 'locked' ? '保险库已锁定，点扩展图标解锁后重试' : '生成失败，请重试');
      }
    } catch {
      refreshWarn('生成失败，请重试');
    }
  };

  const fill = (username: string | null) => {
    for (const el of targets.passwordEls) setVal(el, currentPassword);
    if (username) for (const el of targets.usernameEls) setVal(el, username);

    // 兜底：有些站点用 JS 截断/改写输入（例如隐藏的 maxlength 监听），
    // 填完读回一次，若不一致就留在菜单里明确提示，避免「以为填了其实被截短」。
    const rewritten = targets.passwordEls.find((el) => el.value !== currentPassword);
    if (rewritten) {
      refreshWarn(`本站把密码改写成了 ${rewritten.value.length} 位（可能超出限制），请调小长度后重试`);
      return;
    }
    onFilled();
    hideSignupMenu();
  };

  shadow.getElementById('use')!.addEventListener('click', () => fill(null));
  shadow.getElementById('regen')!.addEventListener('click', () => { void regenerate(); });

  shadow.getElementById('len')!.addEventListener('change', (e) => {
    const n = Math.round(Number((e.target as HTMLInputElement).value));
    genOpts.length = Number.isFinite(n) && n > 0 ? Math.max(4, Math.min(64, n)) : genOpts.length;
    (e.target as HTMLInputElement).value = String(genOpts.length);
    void regenerate();
  });
  shadow.getElementById('sym')!.addEventListener('change', (e) => {
    genOpts.symbols = (e.target as HTMLInputElement).checked;
    void regenerate();
  });

  shadow.querySelectorAll('.idrow').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number((btn as HTMLElement).dataset.i);
      const id = opts.identities[i];
      fill(id ? id.value : null);
    });
  });

  // 点击菜单外关闭
  setTimeout(() => {
    document.addEventListener('click', function onDoc(e) {
      const hostEl = document.getElementById(MENU_ID);
      if (hostEl && !hostEl.contains(e.target as Node)) {
        hideSignupMenu();
        document.removeEventListener('click', onDoc);
      }
    });
  }, 0);

  // E2E 测试桥：isolated world 的 JS 属性对主世界（page.evaluate）不可见，
  // 但 DOM 事件跨世界共享——content script 监听自定义事件，测试从主世界 dispatch。
  host.addEventListener('lv-test-select', (e) => {
    if (!TEST_BRIDGE && !e.isTrusted) return; // 正式包只认真实点击（见 test-bridge.ts）
    const i = (e as CustomEvent).detail?.index ?? 0;
    const id = opts.identities[i];
    fill(id ? id.value : null);
  });

  document.documentElement.appendChild(host);

  // 定位：渲染后按**真实高度**决定在密码框下方还是上方，避免菜单变高后超出视口。
  // fixed 定位直接用 viewport 坐标（不加 scrollX/Y，滚动后才跟得住）。
  const rect = targets.passwordEls[0]?.getBoundingClientRect();
  if (rect) {
    const h = host.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 336));
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8 && rect.top - h - 6 > 8) top = rect.top - h - 6;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(top) + 'px';
  }
}

function setVal(el: HTMLInputElement, value: string): void {
  try {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /* ignore */ }
}

export function hideSignupMenu(): void {
  document.getElementById(MENU_ID)?.remove();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
