/**
 * 锁定态下在页面里弹出的解锁提示面板。
 *
 * 这里**不接收主密码**。面板长在页面 DOM 里，closed shadow root 只隐藏结构、不隐藏事件：
 * 页面脚本在 document 上加一个捕获阶段的 keydown 监听，就能把每一次按键读走——等于让
 * 一个可能被挂马的登录页拿到整个保险库的主密码。主密码只在扩展自己的页面（工具栏弹窗）里输入。
 *
 * 面板负责两件事：
 * 1. 提供「用 Windows Hello 解锁」：解包在 host 里做，键盘不经过页面；
 * 2. 提示用户去点扩展图标输主密码，并每 1.2 秒问一次状态——解锁后自动关闭、继续原来的填充。
 */

const PANEL_ID = 'lv-unlock-panel';
const POLL_MS = 1200;

export interface UnlockResult {
  ok: boolean;
  /** 失败原因（wrong-password / lockout / tpm-not-configured / …） */
  code?: string;
  message?: string;
  retryAfterMs?: number;
}

/** 弹出解锁提示面板。resolve(true) = 已解锁；false = 用户关闭或面板被移除。 */
export function askUnlock(): Promise<boolean> {
  hideUnlockPanel();

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let poll: number | undefined;

    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: light; }
        .card {
          width: 318px; box-sizing: border-box; background: rgba(255,255,255,.86);
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
        .tip { margin-top: 11px; padding: 9px 10px; border-radius: 9px; background: rgba(238,246,255,.9);
               border: 1px solid rgba(47,149,255,.14); color: #3a4a5e; font-size: 11.5px; }
        .tip b { font-weight: 650; color: #16202e; }
        .err { min-height: 15px; font-size: 11px; color: #d93b2b; margin-top: 6px; }
        .acts { display: flex; gap: 6px; margin-top: 8px; }
        button { appearance: none; border: 1px solid rgba(20,90,170,.12); border-radius: 10px;
                 background: rgba(255,255,255,.75); color: #16202e; font: 12px/1 inherit;
                 padding: 9px 12px; cursor: pointer; }
        button:hover { background: rgba(233,243,255,.9); border-color: rgba(47,149,255,.28); }
        button:disabled { opacity: .55; cursor: default; }
        .primary { flex: 1; background: #2f95ff; border-color: #2f95ff; color: #fff; font-weight: 600;
                   box-shadow: 0 1px 0 rgba(255,255,255,.35) inset, 0 3px 8px rgba(47,149,255,.18); }
        .primary:hover { background: #1f86f5; }
        .hidden { display: none; }
      </style>
      <div class="card">
        <div class="head">
          <div class="logo">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px">
              <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/>
              <path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </div>
          <div>
            <div class="t">保险库已锁定</div>
            <div class="d">解锁后继续填充，表单内容不会丢</div>
          </div>
        </div>
        <div class="tip">主密码只在 <b>扩展弹窗</b> 里输入：放在网页里输入会被页面脚本读到。
          解锁后这里会自动继续。</div>
        <div class="err" id="err"></div>
        <div class="acts">
          <button class="primary" id="tpm">用 Windows Hello 解锁</button>
          <button id="cancel">关闭</button>
        </div>
      </div>`;

    const errEl = shadow.getElementById('err') as HTMLElement;
    const tpm = shadow.getElementById('tpm') as HTMLButtonElement;
    const cancel = shadow.getElementById('cancel') as HTMLButtonElement;

    const stopPoll = () => {
      if (poll) { clearInterval(poll); poll = undefined; }
    };

    const close = (value: boolean) => {
      if (settled) return;
      settled = true;
      stopPoll();
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(value);
    };

    // 页面脚本在捕获阶段能读到面板里的按键，但读不到「已解锁」这件事的价值：
    // 轮询只走扩展内部消息，也没有密钥往返。
    const startPoll = () => {
      poll = window.setInterval(async () => {
        if (settled) return;
        try {
          const res = await chrome.runtime.sendMessage({ type: 'status' }) as
            { ok?: boolean; data?: { state?: string } } | null;
          if (res?.ok && res.data?.state === 'unlocked') close(true);
        } catch { /* 扩展重载中：下一轮再试 */ }
      }, POLL_MS);
    };

    tpm.addEventListener('click', async () => {
      if (tpm.disabled) return;
      tpm.disabled = true;
      tpm.textContent = '等待 Windows Hello…';
      errEl.textContent = '';
      let res: UnlockResult | null = null;
      try {
        res = await chrome.runtime.sendMessage({ type: 'unlock-tpm' }) as UnlockResult;
      } catch {
        res = null;
      }
      tpm.disabled = false;
      tpm.textContent = '用 Windows Hello 解锁';
      if (res?.ok) { close(true); return; }
      const code = res?.code ?? 'no-response';
      if (code === 'tpm-not-configured' || code === 'tpm-legacy') {
        tpm.classList.add('hidden');   // 本机没配过（或需要重设），不再显示
        errEl.textContent = code === 'tpm-legacy'
          ? '旧的 Hello 配置需要重设：请先用主密码解锁，到设置里重新开启'
          : '';
        return;
      }
      if (code === 'tpm-cancelled') { errEl.textContent = ''; return; }  // 用户取消不算错误
      errEl.textContent = res?.message ?? 'Windows Hello 解锁失败，请用主密码';
    });

    cancel.addEventListener('click', () => close(false));

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    }
    document.addEventListener('keydown', onKey, true);

    document.documentElement.appendChild(host);
    cancel.focus();
    startPoll();
  });
}

export function hideUnlockPanel(): void {
  document.getElementById(PANEL_ID)?.remove();
}
