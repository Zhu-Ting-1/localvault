/**
 * Offscreen 文档：只为「到点清空剪贴板」存在。
 *
 * 为什么需要它：MV3 的 service worker 没有剪贴板访问权，`navigator.clipboard` 在 SW 里不可用；
 * 官方给的路子就是开一个 offscreen 文档代劳，用完立刻关掉。
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if ((msg as { type?: string })?.type !== 'lv-clear-clipboard') return;

  try {
    const ta = document.createElement('textarea');
    // 用空格而不是空串：部分浏览器会忽略「复制空内容」，空格能确保覆盖掉原值
    ta.value = ' ';
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    sendResponse({ ok: true });
  } catch {
    sendResponse({ ok: false });
  }
  return true;
});
