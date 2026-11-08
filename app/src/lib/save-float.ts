/**
 * 页面内浮窗：注册/登录提交后的「保存到保险库？」确认条。
 * 挂在 closed shadow DOM 里，样式与页面隔离。
 *
 * 交互：提交捕获读到账号+密码 → 浮窗出现在右下角 → 保存/忽略 → 保存走 background 入库。
 */
import type { DetectedForm } from '../lib/detector';
import { TEST_BRIDGE } from './test-bridge';

const FLOAT_ID = 'lv-save-float';

export interface SaveCandidate {
  username: string;
  password: string;
  url: string;
}

let hideTimer: number | undefined;

export function showSaveFloat(candidate: SaveCandidate, onSaved: () => void, onSkipped?: () => void): void {
  hideFloat();

  const host = document.createElement('div');
  host.id = FLOAT_ID;
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const domain = candidate.url.replace(/^https?:\/\//, '').split('/')[0] ?? candidate.url;
  const masked = candidate.username || '（账号为空）';

  shadow.innerHTML = `
    <style>
      :host { all: initial; color-scheme: light; }
      .card {
        width: 320px; box-sizing: border-box; background: rgba(255,255,255,.84);
        border: 1px solid rgba(255,255,255,.92); border-radius: 14px;
        box-shadow: 0 14px 34px rgba(30,90,170,.18), 0 0 0 1px rgba(20,90,170,.06), 0 1px 0 rgba(255,255,255,.9) inset;
        backdrop-filter: blur(20px) saturate(1.5); -webkit-backdrop-filter: blur(20px) saturate(1.5);
        padding: 14px; font: 12.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
        color: #16202e; animation: lv-in .18s ease-out;
      }
      @keyframes lv-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      .head { display: flex; align-items: center; gap: 8px; }
      .logo { width: 26px; height: 26px; border-radius: 8px; background: rgba(233,243,255,.9);
              border: 1px solid rgba(47,149,255,.12); box-shadow: 0 1px 0 rgba(255,255,255,.9) inset;
              display: grid; place-items: center; color: #2f95ff; flex: none; }
      .t { font-weight: 650; font-size: 13.5px; }
      .d { font-size: 11px; color: #71839a; margin-top: 1px; }
      .row { margin-top: 10px; padding: 8px 10px; background: rgba(233,243,255,.6);
             border: 1px solid rgba(255,255,255,.9); border-radius: 10px; font-size: 12px; }
      .row b { color: #16202e; }
      .acts { display: flex; gap: 6px; margin-top: 10px; }
      button { appearance: none; border: 1px solid rgba(20,90,170,.12); border-radius: 10px;
               background: rgba(255,255,255,.75); color: #16202e; font: 12px/1 inherit;
               padding: 7px 12px; cursor: pointer; backdrop-filter: blur(8px); }
      button:hover { background: rgba(233,243,255,.9); border-color: rgba(47,149,255,.28); }
      .primary { flex: 1; background: #2f95ff; border-color: #2f95ff; color: #fff; font-weight: 600;
                 box-shadow: 0 1px 0 rgba(255,255,255,.35) inset, 0 3px 8px rgba(47,149,255,.18); }
      .primary:hover { background: #1f86f5; }
      .skip { font-size: 11.5px; }
    </style>
    <div class="card">
      <div class="head">
        <div class="logo">
          <svg viewBox="0 0 24 24" style="width:15px;height:15px">
            <path d="M12 2 4.5 5.2v5.6c0 4.4 3.1 8.4 7.5 9.6 4.4-1.2 7.5-5.2 7.5-9.6V5.2L12 2Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
            <path d="M8.8 12.1 11 14.3l4.2-4.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div>
          <div class="t">保存到 LocalVault？</div>
          <div class="d">${escapeHtml(domain)}</div>
        </div>
      </div>
      <div class="row">账号 <b>${escapeHtml(masked)}</b> · 密码已加密存储</div>
      <div class="acts">
        <button class="primary" id="save">保存</button>
        <button class="skip" id="skip">本次不保存</button>
      </div>
    </div>`;

  shadow.getElementById('save')!.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'save-from-float', candidate });
      onSaved();
    } catch { /* 扩展重载 */ }
    hideFloat();
  });
  shadow.getElementById('skip')!.addEventListener('click', () => { onSkipped?.(); hideFloat(); });

  // 30 秒无操作自动消失（不打扰）
  hideTimer = window.setTimeout(hideFloat, 30_000);

  // E2E 测试桥（同 signup-menu.ts：DOM 事件跨 world）
  host.addEventListener('lv-test-save', (e) => {
    if (!TEST_BRIDGE && !e.isTrusted) return; // 正式包只认真实点击（见 test-bridge.ts）
    void chrome.runtime.sendMessage({ type: 'save-from-float', candidate });
    onSaved();
    hideFloat();
  });
  document.documentElement.appendChild(host);
}

export function hideFloat(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
  document.getElementById(FLOAT_ID)?.remove();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// 供 content script 使用：把 DetectedForm 的值变成候选
export function candidateFromForm(form: DetectedForm, origin: string): SaveCandidate | null {
  const password = form.password?._el?.value ?? '';
  if (!password) return null;
  return {
    username: form.username?._el?.value ?? '',
    password,
    url: origin,
  };
}