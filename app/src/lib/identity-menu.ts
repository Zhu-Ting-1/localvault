/**
 * 「选择常用身份」浮窗：用于「手机号/邮箱 + 验证码」这类**没有密码框**的登录。
 * 只做一件事：把选中的手机号/邮箱填进账号框。验证码由站点自己的按钮获取、用户自己填。
 *
 * 视觉与 signup-menu 一致（方案 B 玻璃轻蓝），但更薄：没有密码、没有规则卡。
 */
import type { Identity } from './session';
import { TEST_BRIDGE } from './test-bridge';
import { maskValue } from './mask';

const MENU_ID = 'lv-identity-menu';

export interface IdentityMenuTargets {
  accountEls: HTMLInputElement[];
}

export function showIdentityMenu(
  identities: Identity[],
  targets: IdentityMenuTargets,
  onFilled: () => void,
): void {
  hideIdentityMenu();

  const host = document.createElement('div');
  host.id = MENU_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const rows = identities.length
    ? identities.map((id, i) => `
      <button class="idrow" data-i="${i}">
        <span class="lbl">${escapeHtml(id.label)}</span>
        <span class="val">${escapeHtml(maskValue(id.value))}</span>
      </button>`).join('')
    : '<div class="empty">还没有常用身份。点扩展图标 →「身份」里添加手机号或邮箱即可。</div>';

  shadow.innerHTML = `
    <style>
      :host { all: initial; color-scheme: light; }
      .card {
        width: 288px; box-sizing: border-box; background: rgba(255,255,255,.86);
        border: 1px solid rgba(255,255,255,.92); border-radius: 14px;
        box-shadow: 0 14px 34px rgba(30,90,170,.18), 0 0 0 1px rgba(20,90,170,.06), 0 1px 0 rgba(255,255,255,.9) inset;
        backdrop-filter: blur(20px) saturate(1.5); -webkit-backdrop-filter: blur(20px) saturate(1.5);
        padding: 12px; color: #16202e; animation: lv-in .16s ease-out;
        font: 12.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
      }
      @keyframes lv-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      .t { font-weight: 650; font-size: 12.5px; }
      .sub { margin-top: 3px; font-size: 10.5px; color: #71839a; }
      .idrow {
        display: flex; width: 100%; gap: 8px; align-items: center; margin-top: 6px; box-sizing: border-box;
        appearance: none; border: 1px solid rgba(20,90,170,.10); border-radius: 10px;
        background: rgba(255,255,255,.75); backdrop-filter: blur(8px);
        padding: 8px 10px; cursor: pointer; font: 12px/1.3 inherit; color: #16202e; text-align: left;
      }
      .idrow:hover { background: rgba(233,243,255,.92); border-color: rgba(47,149,255,.35); }
      .idrow .lbl { color: #71839a; flex: none; }
      .idrow .val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                    font-variant-numeric: tabular-nums; }
      .empty { margin-top: 8px; font-size: 11px; color: #71839a; line-height: 1.6; }
      .acts { display: flex; margin-top: 9px; }
      button.close { flex: 1; appearance: none; border: 1px solid rgba(20,90,170,.12); border-radius: 10px;
        background: rgba(255,255,255,.75); color: #16202e; font: 12px/1 inherit; padding: 7px 12px; cursor: pointer; }
      button.close:hover { background: rgba(233,243,255,.9); border-color: rgba(47,149,255,.28); }
    </style>
    <div class="card">
      <div class="t">选择要填充的账号</div>
      <div class="sub">验证码请用站点自己的「获取验证码」按钮获取</div>
      ${rows}
      <div class="acts"><button class="close" id="close">取消</button></div>
    </div>`;

  let current = '';
  const fill = (index: number) => {
    const id = identities[index];
    if (!id) return;
    current = id.value;
    for (const el of targets.accountEls) setVal(el, current);
    onFilled();
    hideIdentityMenu();
  };

  shadow.querySelectorAll('.idrow').forEach((btn) => {
    btn.addEventListener('click', () => fill(Number((btn as HTMLElement).dataset.i)));
  });
  shadow.getElementById('close')!.addEventListener('click', hideIdentityMenu);

  setTimeout(() => {
    document.addEventListener('click', function onDoc(e) {
      const hostEl = document.getElementById(MENU_ID);
      if (hostEl && !hostEl.contains(e.target as Node)) {
        hideIdentityMenu();
        document.removeEventListener('click', onDoc);
      }
    });
  }, 0);

  // E2E 测试桥（与 signup-menu 同款：DOM 事件跨 world）
  host.addEventListener('lv-test-select', (e) => {
    if (!TEST_BRIDGE && !e.isTrusted) return; // 正式包只认真实点击（见 test-bridge.ts）
    fill((e as CustomEvent).detail?.index ?? 0);
  });

  document.documentElement.appendChild(host);

  // 渲染后按真实高度定位：优先账号框下方，放不下则上翻
  const rect = targets.accountEls[0]?.getBoundingClientRect();
  if (rect) {
    const h = host.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 304));
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

export function hideIdentityMenu(): void {
  document.getElementById(MENU_ID)?.remove();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
