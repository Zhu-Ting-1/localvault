/**
 * 复制敏感内容（密码 / 恢复密钥）并安排一次自动清空。
 *
 * 只复制不管，密码会一直躺在系统剪贴板里——任何进程、任何「粘贴」都能读到。
 * 这里复制完立刻让 background 挂一个 30 秒的闹钟，到点由 offscreen 文档把剪贴板覆盖掉。
 */
export const CLIP_CLEAR_SECONDS = 30;

export async function copySecret(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  try {
    await chrome.runtime.sendMessage({ type: 'schedule-clipboard-clear', seconds: CLIP_CLEAR_SECONDS });
  } catch {
    // 扩展刚重载之类：清不掉也不能让复制本身失败
  }
}
