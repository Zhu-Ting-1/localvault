/**
 * 「选择要填充的账号」浮窗：同一站点存了多条账号时使用。
 *
 * 为什么必须有：以前 `get-credentials` 固定取第一条，用户在同一站有两个账号
 * （比如工作邮箱 + 个人邮箱）时会被闷头填错那个，还得手动改——比不填更糟。
 *
 * 视觉与 identity-menu 一致（方案 B 玻璃轻蓝）。列表里账号打码，填入用完整值。
 */
import { maskValue } from './mask';
import { TEST_BRIDGE } from './test-bridge';

const MENU_ID = 'lv-account-menu';

export interface AccountRow {
  id: string;
  title: string;
  username: string;
  password: string;
}

export interface AccountMenuTargets {
  usernameEl: HTMLInputElement | null;
  passwordEls: HTMLInputElement[];
}

export function showAccountMenu(
  rows: AccountRow[],
  targets: AccountMenuTargets,
  /** 选定某行时调用；返回补全了密码的行（v2：列表里没有密码，按 id 现取）。
   *  也兼容同步 void（旧调用方）。 */
  onFilled: (row: AccountRow) => AccountRow | void | Promise<AccountRow | void>,
): void {
  hideAccountMenu();

  const host = document.createElement('div');
  host.id = MENU_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const items = rows.map((r, i) => `
      <button class="idrow" data-i="${i}">
        <span class="lbl">${escapeHtml(clip(r.title || '未命名'))}</span>
        <span class="val">${escapeHtml(maskValue(r.username))}</span>
      </button>`).join('');

  shadow.innerHTML = `
    <style>
      :host { all: initial; color-scheme: light; }
      .card {
        width: 300px; box-sizing: border-box; background: rgba(255,255,255,.86);
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
      .idrow .lbl { color: #71839a; flex: none; max-width: 84px; overflow: hidden;
                    text-overflow: ellipsis; white-space: nowrap; }
      .idrow .val { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                    font-variant-numeric: tabular-nums; }
      .acts { display: flex; margin-top: 9px; }
      button.close { flex: 1; appearance: none; border: 1px solid rgba(20,90,170,.12); border-radius: 10px;
        background: rgba(255,255,255,.75); color: #16202e; font: 12px/1 inherit; padding: 7px 12px; cursor: pointer; }
      button.close:hover { background: rgba(233,243,255,.9); border-color: rgba(47,149,255,.28); }
    </style>
    <div class="card">
      <div class="t">本站有 ${rows.length} 个账号</div>
      <div class="sub">选一个填入（账号打码显示，点选填入完整值）</div>
      ${items}
      <div class="acts"><button class="close" id="close">取消</button></div>
    </div>`;

  const fill = (index: number) => {
    const row = rows[index];
    if (!row) return;
    void (async () => {
      // v2：调用方可能在此时按 id 现取密码（列表路径没有密码）
      const picked = (await onFilled(row)) ?? row;
      if (targets.usernameEl && picked.username) setVal(targets.usernameEl, picked.username);
      for (const el of targets.passwordEls) setVal(el, picked.password ?? '');
      targets.passwordEls[0]?.focus();
      hideAccountMenu();
    })();
  };

  shadow.querySelectorAll('.idrow').forEach((btn) => {
    btn.addEventListener('click', () => fill(Number((btn as HTMLElement).dataset.i)));
  });
  shadow.getElementById('close')!.addEventListener('click', hideAccountMenu);

  setTimeout(() => {
    document.addEventListener('click', function onDoc(e) {
      const hostEl = document.getElementById(MENU_ID);
      if (hostEl && !hostEl.contains(e.target as Node)) {
        hideAccountMenu();
        document.removeEventListener('click', onDoc);
      }
    });
  }, 0);

  // E2E 测试桥（与 signup-menu / identity-menu 同款：DOM 事件跨 world）
  host.addEventListener('lv-test-select', (e) => {
    if (!TEST_BRIDGE && !e.isTrusted) return; // 正式包只认真实点击（见 test-bridge.ts）
    fill((e as CustomEvent).detail?.index ?? 0);
  });

  document.documentElement.appendChild(host);

  const anchor = targets.passwordEls[0] ?? targets.usernameEl;
  const rect = anchor?.getBoundingClientRect();
  if (rect) {
    const h = host.getBoundingClientRect().height;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 316));
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8 && rect.top - h - 6 > 8) top = rect.top - h - 6;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(top) + 'px';
  }
}

export function hideAccountMenu(): void {
  document.getElementById(MENU_ID)?.remove();
}

function setVal(el: HTMLInputElement, value: string): void {
  try {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch { /* ignore */ }
}

function clip(s: string): string {
  return s.length > 14 ? s.slice(0, 13) + '…' : s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
