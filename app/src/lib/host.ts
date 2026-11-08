/**
 * Native messaging 客户端：与 vault-host.exe 通信。
 * 协议：4 字节小端长度 + UTF-8 JSON；op = hello / read / write / ping。
 * 写入用 CAS（baseRevision），conflict 时回调上层决定怎么合并/重试。
 *
 * Node/测试环境没有 chrome.runtime，全部经注入的 sendFn 通道，便于单测。
 */

export interface HelloInfo {
  version: string;
  vaultPath: string;
  exists: boolean;
  revision: number;
  recoveredFromBackup: boolean;
  utc: string;
}

export interface ReadResult {
  exists: boolean;
  revision: number;
  ciphertext: string | null;
  updatedAt: string | null;
  recoveredFromBackup: boolean;
}

export interface WriteResult {
  revision: number;
  vaultPath: string;
  utc: string;
}

/** host 的 diag 结果：给「设置 / 诊断」页用，纯只读 */
export interface DiagInfo {
  version: string;
  root: string;
  vaultPath: string;
  exists: boolean;
  bytes: number;
  revision: number;
  updatedAt: string | null;
  recoveredFromBackup: boolean;
  readError: string | null;
  writable: boolean;
  writeError: string | null;
  freeBytes: number;
  backupCount: number;
  backups: Array<{ name: string; bytes: number; utc: string }>;
  logPath: string;
  lockTimeoutMs: number;
  utc: string;
}

export interface ConflictInfo {
  revision: number;
  ciphertext: string | null;
  updatedAt: string | null;
}

export type HostError = { code: 'conflict'; conflict: ConflictInfo } | { code: string; message: string };

/** host 的 v2 列表项：只有 head，**没有 password 字段** */
export interface HostHead {
  id: string;
  title: string;
  username: string;
  urls: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HostSecret {
  id: string;
  password: string;
  passwordHistory: Array<{ password: string; changedAt: string }>;
  notes: string;
}

export interface HostIdentity {
  id: string;
  label: string;
  value: string;
}

type SendFn = (msg: unknown) => Promise<unknown>;

let seq = 0;
const nextId = () => `lv-${Date.now().toString(36)}-${++seq}`;

/**
 * 审计来源：host 自己看不到「是哪个程序」发起的请求，由扩展自报浏览器身份。
 * 日志里就能区分 Chrome / Edge / Opera 扩展，以及本地管理后台（ui）。
 */
function clientSource(): string {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/Edg\//.test(ua)) return 'ext/edge';
    if (/OPR\//.test(ua)) return 'ext/opera';
    if (/Firefox\//.test(ua)) return 'ext/firefox';
    if (/Chrome\//.test(ua)) return 'ext/chrome';
    return 'ext';
  } catch { return 'ext'; }
}

function asError(raw: unknown): HostError {
  const r = raw as { error?: string; message?: string; data?: ConflictInfo };
  if (r?.error === 'conflict') {
    return { code: 'conflict', conflict: r.data ?? { revision: 0, ciphertext: null, updatedAt: null } };
  }
  return { code: r?.error ?? 'unknown', message: r?.message ?? '未知 host 错误' };
}

export class HostClient {
  constructor(private send: SendFn) {}

  private async call<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    const res = (await this.send({ id: nextId(), op, source: clientSource(), ...extra })) as {
      ok?: boolean;
      data?: T;
      error?: string;
      message?: string;
    };
    if (res?.ok) return res.data as T;
    throw asError(res);
  }

  hello(): Promise<HelloInfo> {
    return this.call<HelloInfo>('hello');
  }

  ping(): Promise<{ pong: boolean; utc: string }> {
    return this.call('ping');
  }

  read(): Promise<ReadResult> {
    return this.call<ReadResult>('read');
  }

  /** 诊断信息（host 版本、路径、revision、备份列表、目录可写性、剩余空间） */
  diag(): Promise<DiagInfo> {
    return this.call<DiagInfo>('diag');
  }

  /** CAS 写入。baseRevision 传上次 read/write 返回的 revision。 */
  write(ciphertext: string, baseRevision: number): Promise<WriteResult> {
    return this.call<WriteResult>('write', { ciphertext, baseRevision });
  }

  // ---- v2：密钥下沉到 host 之后的读写接口 ----

  /** 把 DEK 交给 host。host 用第一条 head 验证它是否能打开这个库。
   *  之后扩展不再持有钥匙，只在需要时按条取明文。 */
  unlock(dek: Uint8Array): Promise<{ method: string; entries: number; version: string }> {
    let bin = '';
    for (let i = 0; i < dek.length; i++) bin += String.fromCharCode(dek[i]!);
    return this.call('unlock', { dek: btoa(bin) });
  }

  hostLock(): Promise<{ locked: boolean }> {
    return this.call('lock');
  }

  /** 列表：只解 head，返回结构里没有 password */
  list(): Promise<{ entries: HostHead[] }> {
    return this.call('list');
  }

  /** 取单条密码（复制/填充时用，用完即弃） */
  getSecret(id: string): Promise<HostSecret> {
    return this.call('get-secret', { id });
  }

  upsert(entry: Record<string, unknown>): Promise<{ id: string; revision: number; created: boolean }> {
    return this.call('upsert', { entry });
  }

  remove(id: string): Promise<{ id: string; revision: number }> {
    return this.call('delete', { id });
  }

  getIdentities(): Promise<{ identities: HostIdentity[] }> {
    return this.call('get-identities');
  }

  setIdentities(identities: HostIdentity[]): Promise<{ revision: number }> {
    return this.call('set-identities', { identities });
  }

  /** 迁移前强制备份（v0.2.x 读不懂 v2，没有它等于升级不可逆） */
  backupBeforeMigrate(): Promise<{ path: string; bytes: number }> {
    return this.call('backup-before-migrate');
  }

  /** SW 回收后恢复会话：host 读密钥槽恢复 DEK（一次性，读完即删） */
  unlockResume(): Promise<{ resumed: boolean; entries: number; version: string }> {
    return this.call('unlock-resume');
  }

  // ---- TPM / Windows Hello ----

  tpmStatus(): Promise<{ available: boolean; method?: 'tpm' | 'software' }> {
    return this.call('tpm-status');
  }

  tpmEnable(): Promise<{ enabled: boolean; bytes: number; method: string }> {
    return this.call('tpm-enable');
  }

  dpapiProtect(data: string): Promise<{ data: string }> {
    return this.call('dpapi-protect', { data });
  }

  dpapiUnprotect(data: string): Promise<{ data: string }> {
    return this.call('dpapi-unprotect', { data });
  }

  tpmDisable(): Promise<{ enabled: boolean }> {
    return this.call('tpm-disable');
  }

  /** 仅凭 TPM 包裹解锁（免主密码；本机未配置时报 tpm-not-configured） */
  unlockTpm(): Promise<{ method: string; entries: number; version: string }> {
    return this.call('unlock-tpm');
  }

  // ---- 导出包裹模式（加密程度三档）----

  getExportMode(): Promise<{ mode: 'host' | 'none' | 'strict' }> {
    return this.call('get-export-mode');
  }

  setExportMode(mode: 'host' | 'none' | 'strict'): Promise<{ mode: string }> {
    return this.call('set-export-mode', { mode });
  }

  /** host 内置加密自检（固定向量，不构成加密预言机） */
  selftest(): Promise<{ version: string; crypto: { ok: boolean; cases: number }; utc: string }> {
    return this.call('selftest');
  }

  // ---- 本地管理后台联动 ----

  /** 点击「填充」后上报一次（只带站点/浏览器元数据，绝不带密码）。 */
  reportFill(info: { site?: string; tab?: string; method?: string; app?: string; entryId?: string } = {}): Promise<{ recorded: boolean }> {
    return this.call('fill', { ...info });
  }

  /** 给条目补站点中文名/描述。noFetch=true 时只查内置映射（零网络、零延迟）。 */
  /** 零联网站点识别：url 查内置映射；title 是浏览器标签页的 document.title（由调用方传入）。 */
  fetchSiteInfo(url: string, title = ''): Promise<{ name: string; description: string; source: string }> {
    return this.call('fetch-site-info', { url, title });
  }

  /** 只改条目的中文站点名/解释，不碰密码。 */
  setSiteName(id: string, name: string, description = ''): Promise<{ id: string; name: string; revision: number }> {
    return this.call('set-site-name', { id, name, description });
  }

  /** 后台状态（含本地后台端口）。 */
  uiStatus(): Promise<{ state: string; uiPort: number; vaultPath: string; version: string }> {
    return this.call('status');
  }

  /** 后台 API 令牌（每次 host 启动重新生成）。只经 native messaging 下发，HTTP 取不到。 */
  uiToken(): Promise<{ token: string; port: number }> {
    return this.call('ui-token');
  }

  /** 审计统计（读取/填充/写入次数、按来源分组）。 */
  auditStats(): Promise<Record<string, unknown>> {
    return this.call('audit-stats');
  }
}

/**
 * 浏览器环境的标准通道：**单例长连接**。
 *
 * 为什么不能像 v1 那样每次调用新开一个端口：native messaging 的一个端口 = 一个 host 进程。
 * v2 之后 DEK 存在 host 进程内存里，unlock 在进程 A 完成、list 再起进程 B —— B 没有钥匙。
 * 所以必须全程复用同一个进程：一个长连端口 + 请求 id 分发响应。
 *
 * 断线（host 崩溃/浏览器回收 SW）时自动重连一次；重连后 host 是新进程、没有钥匙，
 * 需要钥匙的调用会收到 locked，由上层引导用户重新解锁。
 */
export function browserSendFn(): SendFn {
  interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  let port: chrome.runtime.Port | null = null;
  let connecting: Promise<chrome.runtime.Port> | null = null;
  const pending = new Map<string, Pending>();
  const buf: unknown[] = [];
  void buf;

  const CALL_TIMEOUT_MS = 20000;

  function failAll(err: string): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(err));
    }
    pending.clear();
  }

  function connect(): Promise<chrome.runtime.Port> {
    if (port) return Promise.resolve(port);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const p = chrome.runtime.connectNative('com.localvault.host');
      let connected = false;
      p.onMessage.addListener((resp: { id?: string }) => {
        // host 对每个请求回一条带 id 的响应
        const id = String(resp?.id ?? '');
        const rec = pending.get(id);
        if (rec) {
          pending.delete(id);
          clearTimeout(rec.timer);
          rec.resolve(resp);
        }
      });
      p.onDisconnect.addListener(() => {
        port = null;
        connecting = null;
        failAll(chrome.runtime.lastError?.message ?? 'host 连接断开');
        if (!connected) reject(new Error('host 连接失败'));
      });
      // connectNative 同步返回端口，没有独立的 onConnect 事件；这里标记已连上
      connected = true;
      port = p;
      resolve(p);
    });
    return connecting;
  }

  return async (msg) => {
    const req = msg as { id?: string };
    const p = await connect();
    return new Promise((resolve, reject) => {
      const id = String(req?.id ?? '');
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('host 响应超时'));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        p.postMessage(msg);
      } catch (e) {
        // 端口可能已死：重连一次再发
        pending.delete(id);
        clearTimeout(timer);
        port = null;
        connect()
          .then((p2) => {
            const timer2 = setTimeout(() => {
              pending.delete(id);
              reject(new Error('host 响应超时'));
            }, CALL_TIMEOUT_MS);
            pending.set(id, { resolve, reject, timer: timer2 });
            p2.postMessage(msg);
          })
          .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  };
}