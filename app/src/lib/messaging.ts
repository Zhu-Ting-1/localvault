/** popup 与 background 的消息封装 */
type Ok<T> = { ok: true; data: T };
type Err = { ok: false; code: string; message: string; retryAfterMs?: number };
export type Res<T> = Ok<T> | Err;

export function send<T = Record<string, unknown>>(type: string, extra: Record<string, unknown> = {}): Promise<Res<T>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res: Res<T>) => {
      const le = chrome.runtime.lastError;
      if (le) resolve({ ok: false, code: 'runtime', message: le.message ?? 'runtime error' } as Err);
      else resolve(res ?? { ok: false, code: 'no-response', message: 'background 未响应' });
    });
  });
}

export interface StatusData {
  state: 'no-vault' | 'locked' | 'unlocked';
  hostOk: boolean;
  vaultPath: string | null;
  lockoutMs: number;
  rememberEnabled: boolean;
}
