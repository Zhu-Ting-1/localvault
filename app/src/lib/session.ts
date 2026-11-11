/**
 * 保险库会话：解锁状态、DEK 生命周期、自动锁定、错误密码退避。
 *
 * 安全模型：
 * - DEK 只放 chrome.storage.session（浏览器关闭即清空，内容脚本不可读）。
 * - 空闲 15 分钟自动锁定；手动锁定随时可用；错误密码指数退避。
 * - 解锁后的明文条目表只在内存，不落任何存储。
 *
 * 「记住解锁」（可选，默认关）：DEK 经 host DPAPI 包裹后存 storage.local；
 * 任何锁定都删钥匙但保留开关；改主密码后记忆作废。
 */
import type { Envelope, VaultData } from './vault';
import { sealJson, openJson, type SealedBlob } from './payload';
import { HostClient } from './host';

// 惰性构造的 host 客户端：仅用于「记住解锁」的 DPAPI 包裹服务。
// 不在模块加载时构造，避免单测环境（无 chrome.runtime）初始化失败。
// 必须复用 background 那一个 HostClient：每次 connectNative 都会拉起新的 host 进程，
// 新进程里没有钥匙（DEK 只在拉起它的那个进程里），自己 new 一个只会拿到 locked。
let rememberHost: HostClient | null = null;

/** background 启动时注入共享的 host 客户端。 */
export function setRememberHost(client: HostClient): void {
  rememberHost = client;
}

const SESSION_DEK = 'lv:dek';          // b64(DEK)
const SESSION_ENVELOPE = 'lv:envelope'; // 当前 envelope JSON（密文，非敏感，便于免重读）
const SESSION_UNLOCKED_AT = 'lv:unlockedAt'; // 本次解锁的时间戳（用于绝对超时）
const LOCAL_REMEMBER = 'lv:remember';         // 密钥本体：只有解锁态才存在
const LOCAL_REMEMBER_PREF = 'lv:rememberPref'; // 用户意愿：这个开关不该被锁掉
const SESSION_BOOT_DONE = 'lv:bootRestoreDone'; // 本次浏览器会话是否已尝试过「开机自动解锁」
const IDLE_LOCK_MINUTES = 15;
/** 用户可调：空闲多少分钟自动锁定；0 = 不因空闲锁定（锁屏仍然锁）。 */
const LOCAL_IDLE_MINUTES = 'lv:idleLockMinutes';
let idleLockMinutes = IDLE_LOCK_MINUTES;
/** 绝对超时：连续解锁超过这么久就强制重新输主密码。
 *  空闲锁只能挡「人离开」，挡不住「一直有操作」——比如忘记锁屏又一直用着浏览器。 */
const ABSOLUTE_LOCK_MS = 8 * 60 * 60 * 1000;
export const ABSOLUTE_LOCK_MINUTES = ABSOLUTE_LOCK_MS / 60000;

export type LockState = 'no-vault' | 'locked' | 'unlocked';

// ---- 内存态（service worker 存活期）----

let cachedData: VaultData | null = null;
let failedAttempts = 0;
let lockoutUntil = 0;

// ---- 退避 ----
// 退避状态持久化到 storage.session：SW 被浏览器回收后不再清零，
// 网页无法借「等回收重置退避」加速对主密码的在线猜测。session 域随浏览器关闭清空，
// 不构成持久存储。读写失败按内存态兜底（可用性优先）。

const LOCKOUT_KEY = 'lv:lockout';

async function loadLockout(): Promise<void> {
  try {
    const bag = await chrome.storage.session.get(LOCKOUT_KEY);
    const saved = bag[LOCKOUT_KEY] as { failedAttempts?: number; lockoutUntil?: number } | undefined;
    if (saved) {
      failedAttempts = saved.failedAttempts ?? 0;
      lockoutUntil = saved.lockoutUntil ?? 0;
    }
  } catch { /* session 存储不可用：保持内存态 */ }
}

async function saveLockout(): Promise<void> {
  try {
    await chrome.storage.session.set({ [LOCKOUT_KEY]: { failedAttempts, lockoutUntil } });
  } catch { /* 忽略 */ }
}

void loadLockout(); // SW 启动时恢复

export function lockoutRemainingMs(): number {
  return Math.max(0, lockoutUntil - Date.now());
}

export function recordFailedAttempt(): number {
  failedAttempts += 1;
  // 1 → 1s；2 → 2s；3 → 6s；4 → 15s；5 → 30s：连续 3 次错误进入明显退避
  const SEC: readonly number[] = [0, 1, 2, 6, 15, 30];
  const sec = failedAttempts < SEC.length ? (SEC[failedAttempts] ?? 60) : 60;
  lockoutUntil = Date.now() + sec * 1000;
  void saveLockout();
  return sec * 1000;
}

export function resetFailedAttempts(): void {
  failedAttempts = 0;
  lockoutUntil = 0;
  void saveLockout();
}

export function failedAttemptCount(): number {
  return failedAttempts;
}

// ---- 会话存取 ----

async function setSession(values: Record<string, unknown>): Promise<void> {
  await chrome.storage.session.set(values);
}

async function getSession<T>(key: string): Promise<T | null> {
  const bag = await chrome.storage.session.get(key);
  return (bag[key] as T) ?? null;
}

async function clearSession(...keys: string[]): Promise<void> {
  await chrome.storage.session.remove(keys);
}

export async function saveUnlockedState(
  dek: Uint8Array,
  envelope: Envelope,
  data: VaultData,
  revision: number = -1,
): Promise<void> {
  cachedData = data;
  sessionRevision = revision;
  const b64dek = btoa(String.fromCharCode(...dek));
  await setSession({ [SESSION_DEK]: b64dek, [SESSION_ENVELOPE]: JSON.stringify(envelope) });
}

/** 内存里这份数据对应的文件 revision（-1 = 未知，需要重新对齐） */
let sessionRevision = -1;

export function getSessionRevision(): number {
  return sessionRevision;
}

/** 记下「这次解锁发生在什么时候」，并挂一个闹钟到点强制上锁。
 *  必须单独调用：saveUnlockedState 在每次写盘时都会执行，不能拿它当「刚解锁」。 */
export async function markUnlocked(): Promise<void> {
  const at = Date.now();
  await setSession({ [SESSION_UNLOCKED_AT]: at });
  try {
    if (chrome.alarms?.create) {
      chrome.alarms.create('lv:absolute-lock', { delayInMinutes: ABSOLUTE_LOCK_MINUTES });
    }
  } catch { /* 构建期/测试环境没有 alarms */ }
}

/** 绝对超时检查：超时就地上锁并返回 false。 */
export async function ensureNotExpired(): Promise<boolean> {
  const at = await getSession<number>(SESSION_UNLOCKED_AT);
  if (!at) {
    // 老会话没有这个字段（升级前的状态）：从现在开始计时，不打断用户
    await markUnlocked();
    return true;
  }
  if (Date.now() - at > ABSOLUTE_LOCK_MS) {
    await lock();
    await lockExecutor(); // host 进程里的钥匙一起清（v2）
    return false;
  }
  return true;
}

export async function loadSessionEnvelope(): Promise<Envelope | null> {
  const raw = await getSession<string>(SESSION_ENVELOPE);
  return raw ? (JSON.parse(raw) as Envelope) : null;
}

export async function loadSessionDek(): Promise<Uint8Array | null> {
  const b64dek = await getSession<string>(SESSION_DEK);
  if (!b64dek) return null;
  const bin = atob(b64dek);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function setCachedData(data: VaultData): Promise<void> {
  cachedData = data;
}

export function getCachedData(): VaultData | null {
  return cachedData;
}

// ---- 「记住解锁」（可选持久化，默认关）----
//
// 拆成两件事，别混在一起：
//   · 意愿（lv:rememberPref）：用户勾没勾这个开关。锁定时**保留**，
//     否则「走开 15 分钟 → 空闲锁 → 开关自己变灰」——功能等于废掉。
//   · 钥匙（lv:remember）：解出来的 DEK。**任何一次锁定都要删掉**，
//     否则「锁定」形同虚设：本机恶意程序照样能从 storage.local 拿到钥匙。
//
// 于是：锁 = 真没了钥匙（安全不打折）；解锁一次 = 按意愿把钥匙重新放好（下次开机仍能自动解锁）。

// 钥匙落盘前必须经 host 的 DPAPI 包裹。**没有明文兜底**：
// host 不在（没装、崩溃、被策略挡住）就不记，宁可用户下次多输一次主密码，
// 也不能让裸 DEK 进 chrome.storage.local（那是 LevelDB 明文，任何同用户进程可读）。
// 默认实现走 host；单测注入替身（见 setRememberCrypto）。
const REMEMBER_PREFIX = 'dpapi:';

let wrapDek = async (b64: string): Promise<string> => {
  if (!rememberHost) throw new Error('host-unavailable');
  return (await rememberHost.dpapiProtect(b64)).data;
};
let unwrapDek = async (wrapped: string): Promise<string> => {
  if (!rememberHost) throw new Error('host-unavailable');
  return (await rememberHost.dpapiUnprotect(wrapped)).data;
};

/** 仅供单测注入 DPAPI 替身；生产路径永远是 host。 */
export function setRememberCrypto(
  wrap: (b64: string) => Promise<string>,
  unwrap: (wrapped: string) => Promise<string>,
): void {
  wrapDek = wrap;
  unwrapDek = unwrap;
}

export async function setRememberUnlock(enabled: boolean, dek?: Uint8Array): Promise<void> {
  if (!enabled) {
    await chrome.storage.local.remove([LOCAL_REMEMBER, LOCAL_REMEMBER_PREF]);
    return;
  }
  if (dek) {
    const b64dek = btoa(String.fromCharCode(...dek));
    let wrapped: string;
    try {
      wrapped = await wrapDek(b64dek);
    } catch (e) {
      // 包不上就不记：同时把「意愿」也退回，避免界面显示已开启却没钥匙
      await chrome.storage.local.remove([LOCAL_REMEMBER, LOCAL_REMEMBER_PREF]);
      throw e instanceof Error ? e : new Error('wrap-failed');
    }
    await chrome.storage.local.set({ [LOCAL_REMEMBER]: REMEMBER_PREFIX + wrapped });
  }
  await chrome.storage.local.set({ [LOCAL_REMEMBER_PREF]: true });
}

export async function getRememberedDek(): Promise<Uint8Array | null> {
  const bag = await chrome.storage.local.get(LOCAL_REMEMBER);
  const stored = bag[LOCAL_REMEMBER] as string | undefined;
  // 只认新格式。旧版本可能写过裸 base64 DEK，一律作废（不解析、不使用）
  if (!stored || !stored.startsWith(REMEMBER_PREFIX)) {
    if (stored) await chrome.storage.local.remove(LOCAL_REMEMBER);
    return null;
  }
  let b64dek: string;
  try {
    b64dek = await unwrapDek(stored.slice(REMEMBER_PREFIX.length));
  } catch {
    // host 不可用 / 包裹被换用户或换机器：删掉，别让下次开机反复失败
    await chrome.storage.local.remove(LOCAL_REMEMBER);
    return null;
  }
  const bin = atob(b64dek);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 开关状态看「意愿」，不看钥匙在不在（钥匙锁上就没了，但开关没变） */
export async function isRememberEnabled(): Promise<boolean> {
  const bag = await chrome.storage.local.get(LOCAL_REMEMBER_PREF);
  return !!bag[LOCAL_REMEMBER_PREF];
}

/** 本次浏览器会话是否该尝试「开机自动解锁」——每会话只尝试一次。
 *  为什么要这个闸：否则空闲锁刚把钥匙删了，下一次 status 又会触发自动恢复，
 *  锁立刻被自己解开（以前是靠「删钥匙」顺带解决，现在钥匙照删，但得再挡一道）。 */
export async function shouldAttemptBootRestore(): Promise<boolean> {
  const done = await getSession<boolean>(SESSION_BOOT_DONE);
  if (done) return false;
  await setSession({ [SESSION_BOOT_DONE]: true });
  return true;
}

// ---- 身份信息（注册页备选账号，如手机号/常用邮箱）----
// 落盘用 DEK 加密（AES-GCM，AAD=localvault-identities/v1），磁盘上只有密文，
// 与保险库同等强度；展示层由 lib/mask.ts 打码（手机前 3 后 4、邮箱保留首尾），
// 填充时使用完整值。锁定态没有 DEK → 读取返回空，写入报 locked。

const LOCAL_IDENTITIES = 'lv:identities';
const IDENTITIES_AAD = 'localvault-identities/v1';

export interface Identity {
  id: string;
  label: string;   // 显示名，如「手机」「QQ 邮箱」
  value: string;   // 完整值（手机号 / 邮箱），仅内存与填充时使用
}

interface SealedIdentities extends SealedBlob {
  v: 1;
}

export async function getIdentities(): Promise<Identity[]> {
  const bag = await chrome.storage.local.get(LOCAL_IDENTITIES);
  const raw: unknown = bag[LOCAL_IDENTITIES];
  if (!raw) return [];

  // 旧版本直接存明文数组：解锁态下顺手迁移成密文（锁定态先照常返回，等解锁后迁移）
  if (Array.isArray(raw)) {
    const legacy = raw as Identity[];
    const dek = await loadSessionDek();
    if (dek) {
      try {
        await setIdentities(legacy);
      } catch {
        /* 迁移失败不影响本次读取 */
      }
    }
    return legacy;
  }

  const dek = await loadSessionDek();
  if (!dek) return []; // 锁定态：密文不可读
  try {
    const data = await openJson<{ identities?: Identity[] }>(dek, raw as SealedIdentities);
    return Array.isArray(data?.identities) ? data.identities : [];
  } catch {
    // 保险库重建（换了 DEK）或密文损坏：按空处理，不阻塞注册流程
    return [];
  }
}

export async function setIdentities(list: Identity[]): Promise<void> {
  const dek = await loadSessionDek();
  if (!dek) throw Object.assign(new Error('保险库已锁定，无法保存常用身份'), { code: 'locked' });
  const sealed = await sealJson(dek, { identities: list }, IDENTITIES_AAD);
  const blob: SealedIdentities = { v: 1, ...sealed };
  await chrome.storage.local.set({ [LOCAL_IDENTITIES]: blob });
}

/** 旧版把身份放在 storage.local：搬进保险库后清掉这个键。
 *  只在迁移路径调用，正常情况下这里应该是空的。 */
export async function clearLegacyIdentities(): Promise<void> {
  await chrome.storage.local.remove(LOCAL_IDENTITIES);
}

// ---- 锁定 ----

export async function lock(): Promise<void> {
  cachedData = null;
  sessionRevision = -1;
  failedAttempts = 0;
  lockoutUntil = 0;
  await clearSession(SESSION_DEK, SESSION_ENVELOPE, SESSION_UNLOCKED_AT, SESSION_UNLOCKED_FLAG);
  try { chrome.alarms?.clear?.('lv:absolute-lock'); } catch { /* 忽略 */ }
  // 只删「钥匙」，保留「意愿」：这样空闲锁/锁屏锁不会把用户勾选的开关一起关掉。
  // 开关本身要关，得用户自己去设置页关（或调 setRememberUnlock(false)）。
  await chrome.storage.local.remove(LOCAL_REMEMBER);
}

// ---- 锁定态 ----

/** 磁盘上是否存在加密信封（由 background 注入，避免 session 依赖 host）。 */
let vaultExistsOnDisk: () => Promise<boolean> = async () => false;

export function setVaultExistsProbe(fn: () => Promise<boolean>): void {
  vaultExistsOnDisk = fn;
}

/**
 * 解锁态判定（v2）：钥匙在 host 进程里，扩展不持任何密钥；
 * 但 service worker 会被浏览器回收，回收后模块内存归零——
 * 「已解锁」这个事实必须存 chrome.storage.session（浏览器关闭即清空，安全模型不变）。
 * SW 冷启动时从 session 标志恢复判定；host 进程死掉（钥匙没了）时，调用会收到 locked 再纠正。
 */
const SESSION_UNLOCKED_FLAG = 'lv:unlockedFlag';

/** 锁定执行器：session 触发锁定（空闲/锁屏/绝对超时）时，同步把 host 进程的 DEK 也清掉。
 *  background 注入 lockAll——session 不能反向 import host 模块。 */
let lockExecutor: () => Promise<void> = async () => {};

export async function markHostUnlocked(): Promise<void> {
  await setSession({ [SESSION_UNLOCKED_FLAG]: true });
}

export async function markHostLocked(): Promise<void> {
  await clearSession(SESSION_UNLOCKED_FLAG);
}

export async function isHostUnlockedFlag(): Promise<boolean> {
  return !!(await getSession<boolean>(SESSION_UNLOCKED_FLAG));
}

export function setLockExecutor(fn: () => Promise<void>): void {
  lockExecutor = fn;
}

export async function currentLockState(): Promise<LockState> {
  // no-vault 不能只看 session：浏览器重启后 session 清空（安全设计），
  // 但磁盘上的 vault.db 还在。必须查磁盘，否则重启后误判为「未创建」。
  if (!(await vaultExistsOnDisk())) return 'no-vault';
  if (!(await isHostUnlockedFlag())) return 'locked';
  // 绝对超时：超过 8 小时强制重新解锁
  if (!(await ensureNotExpired())) return 'locked';
  return 'unlocked';
}

// ---- 空闲自动锁定 ----

/** 读取用户设置的空闲锁定时长（分钟）；0 = 不因空闲锁定。 */
export async function getIdleLockMinutes(): Promise<number> {
  try {
    const got = await chrome.storage.local.get(LOCAL_IDLE_MINUTES);
    const v = got?.[LOCAL_IDLE_MINUTES];
    if (typeof v === 'number' && v >= 0) return v;
  } catch { /* 读不到就用默认值 */ }
  return IDLE_LOCK_MINUTES;
}

/** 改空闲锁定时长并立即生效（下次浏览器空闲计时按新阈值走）。 */
export async function setIdleLockMinutes(min: number): Promise<void> {
  const safe = Number.isFinite(min) && min >= 0 ? Math.round(min) : IDLE_LOCK_MINUTES;
  await chrome.storage.local.set({ [LOCAL_IDLE_MINUTES]: safe });
  idleLockMinutes = safe;
  applyIdleInterval();
}

function applyIdleInterval(): void {
  try {
    // chrome.idle 的阈值下限是 15 秒；关闭时设成 12 小时，等于永远等不到 idle
    const seconds = idleLockMinutes > 0 ? Math.max(15, idleLockMinutes * 60) : 12 * 60 * 60;
    chrome.idle?.setDetectionInterval?.(seconds);
  } catch {
    // 构建期预执行或测试环境无 idle API
  }
}

export function setupIdleLock(): void {
  // WXT build 时会用 fake-browser 预执行本模块做静态分析，API 未 mock 会抛错——吞掉即可。
  try {
    if (chrome.idle) {
      applyIdleInterval();
      void (async () => {
        idleLockMinutes = await getIdleLockMinutes();
        applyIdleInterval();
      })();

      // Chromium 已知行为：监听器注册后经常**立即回调一次 'locked'**（Windows 上的
      // 初始状态误报），会把刚解锁的库直接锁掉。忽略启动窗口内的 locked 回调——
      // 用户真的锁屏时 2 秒后仍是 locked，后续回调照常触发，不影响真实锁定。
      const startedAt = Date.now();
      chrome.idle.onStateChanged.addListener((state) => {
        // Chromium/Windows 已知行为：监听器注册后 ~1 秒会误报一次 'idle'（阈值根本没到），
        // 锁屏后则误报/正常 'locked' 混杂。防误杀规则：
        //  - idle：启动后 IDLE 分钟内的 idle 事件必是误报（最长空闲不可能超过阈值）
        //  - locked：启动后 2 秒内的 locked 是初始状态误报；真锁屏 2 秒后仍 locked 会再次回调
        if (state === 'locked') {
          if (Date.now() - startedAt < 2000) return;
        } else if (state === 'idle') {
          if (idleLockMinutes <= 0) return; // 用户关了空闲锁定，只保留锁屏锁定
          if (Date.now() - startedAt < idleLockMinutes * 60 * 1000) return;
        } else {
          return;
        }
        void (async () => { await lock(); await lockExecutor(); })();
      });
    }
  } catch {
    // 构建期预执行或测试环境无 idle API：跳过注册，运行时真实浏览器可用
  }
}

// ---- 浏览器关闭即锁 ----
// storage.session 本身随浏览器关闭清空，无需额外监听。
