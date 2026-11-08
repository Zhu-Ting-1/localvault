/**
 * host 客户端 + 会话的单测。
 * chrome.* API 用内存 stub 模拟（storage.session / idle）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HostClient, type ConflictInfo } from '../src/lib/host';

// ---------- HostClient ----------

/** 模拟 host：读改写 CAS，conflict 语义与 VaultHost.cs 一致 */
function fakeHostSend(state: { revision: number; ciphertext: string | null }) {
  return async (msg: unknown) => {
    const m = msg as { op: string; ciphertext?: string; baseRevision?: number };
    switch (m.op) {
      case 'hello':
        return { ok: true, data: { version: '0.1.0', vaultPath: 'C:\\fake\\vault.db', exists: state.ciphertext !== null, revision: state.revision, recoveredFromBackup: false, utc: 'now' } };
      case 'ping':
        return { ok: true, data: { pong: true, utc: 'now' } };
      case 'read':
        return { ok: true, data: { exists: state.ciphertext !== null, revision: state.revision, ciphertext: state.ciphertext, updatedAt: 'now', recoveredFromBackup: false } };
      case 'write':
        if (m.baseRevision !== state.revision) {
          return { ok: false, error: 'conflict', message: 'baseRevision 不匹配', data: { revision: state.revision, ciphertext: state.ciphertext, updatedAt: 'now' } satisfies ConflictInfo };
        }
        state.revision += 1;
        state.ciphertext = m.ciphertext!;
        return { ok: true, data: { revision: state.revision, vaultPath: 'C:\\fake\\vault.db', utc: 'now' } };
      default:
        return { ok: false, error: 'unknown_op', message: 'unknown op: ' + m.op };
    }
  };
}

describe('HostClient', () => {
  it('hello/read 走通', async () => {
    const state = { revision: 0, ciphertext: null };
    const c = new HostClient(fakeHostSend(state));
    const hello = await c.hello();
    expect(hello.exists).toBe(false);
    const r = await c.read();
    expect(r.exists).toBe(false);
  });

  it('CAS 写入成功 revision 递增', async () => {
    const state = { revision: 0, ciphertext: null };
    const c = new HostClient(fakeHostSend(state));
    const w = await c.write('AAA', 0);
    expect(w.revision).toBe(1);
    const r = await c.read();
    expect(r.ciphertext).toBe('AAA');
  });

  it('旧 baseRevision → conflict，带当前密文', async () => {
    const state = { revision: 0, ciphertext: null };
    const c = new HostClient(fakeHostSend(state));
    await c.write('FIRST', 0);
    await expect(c.write('STALE', 0)).rejects.toMatchObject({
      code: 'conflict',
      conflict: { revision: 1, ciphertext: 'FIRST' },
    });
  });
});

// ---------- 会话（chrome.storage.session stub） ----------

const sessionBag = new Map<string, unknown>();
const localBag = new Map<string, unknown>();

beforeEach(() => {
  sessionBag.clear();
  localBag.clear();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { sendMessage: vi.fn(), connectNative: vi.fn() },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: sessionBag.get(key) }),
        set: async (vals: Record<string, unknown>) => { for (const [k, v] of Object.entries(vals)) sessionBag.set(k, v); },
        remove: async (keys: string[]) => { for (const k of keys) sessionBag.delete(k); },
      },
      local: {
        get: async (key: string) => ({ [key]: localBag.get(key) }),
        set: async (vals: Record<string, unknown>) => { for (const [k, v] of Object.entries(vals)) localBag.set(k, v); },
        // chrome API 允许传字符串或字符串数组
        remove: async (keys: string | string[]) => { for (const k of typeof keys === 'string' ? [keys] : keys) localBag.delete(k); },
      },
    },
    idle: {
      setDetectionInterval: vi.fn(),
      onStateChanged: { addListener: vi.fn() },
    },
  };
});

describe('会话模块（storage.session stub）', async () => {
  const session = await import('../src/lib/session');
  const vault = await import('../src/lib/vault');

  // DPAPI 包裹的替身：真实路径走 host，单测没有 native 通道
  const realWrap = async (b64: string) => 'W' + b64;
  const realUnwrap = async (w: string) => w.replace(/^W/, '');
  session.setRememberCrypto(realWrap, realUnwrap);

  it('解锁状态存取 + 锁定清空', async () => {
    const { envelope, dek } = await vault.createVault('test-password-123', 'test');
    const { data } = await vault.openVault(envelope, 'test-password-123');

    session.setVaultExistsProbe(async () => true);
    // v2：解锁标志由 host-vault 层经 markHostUnlocked 写入（钥匙在 host 进程，扩展不持 DEK）
    await session.markHostUnlocked();
    expect(await session.currentLockState()).toBe('unlocked');

    // v2：锁定/恢复只动标志，不再有扩展侧 DEK
    expect(await session.isHostUnlockedFlag()).toBe(true);

    await session.lock();
    // 锁定后磁盘上仍有库 → locked；probe 设 false 才是 no-vault
    expect(await session.currentLockState()).toBe('locked');
    session.setVaultExistsProbe(async () => false);
    expect(await session.currentLockState()).toBe('no-vault');
    expect(await session.isHostUnlockedFlag()).toBe(false);
    expect(session.getCachedData()).toBeNull();
  });

  it('空会话 → locked 语义区分 no-vault', async () => {
    // 只有 envelope 没有 dek = 锁定态
    const { envelope } = await vault.createVault('test-password-123', 'test');
    session.setCachedData({ entries: [], meta: { createdAt: '', generatorVersion: 'test' } });
    await chrome.storage.session.set({ 'lv:envelope': JSON.stringify(envelope) });
    session.setVaultExistsProbe(async () => true);
    expect(await session.currentLockState()).toBe('locked');
  });

  it('重启场景回归：session 清空但磁盘有库 → locked（不是 no-vault）', async () => {
    // 用户实际遇到的 bug：浏览器重启后 storage.session 清空，
    // currentLockState 误判 no-vault → UI 显示"重新创建保险库"
    session.setVaultExistsProbe(async () => true); // 磁盘上有库
    sessionBag.clear();                            // 模拟浏览器重启（session 清空）
    expect(await session.currentLockState()).toBe('locked');

    // 磁盘上也没有 → no-vault
    session.setVaultExistsProbe(async () => false);
    expect(await session.currentLockState()).toBe('no-vault');

    // 恢复默认 probe
    session.setVaultExistsProbe(async () => false);
  });

  it('错误密码退避：3 次后 ≥ 5 秒', () => {
    const s = session as { recordFailedAttempt: () => number; lockoutRemainingMs: () => number; resetFailedAttempts: () => void };
    s.resetFailedAttempts();
    const a1 = s.recordFailedAttempt();
    const a2 = s.recordFailedAttempt();
    const a3 = s.recordFailedAttempt();
    expect(a1).toBeLessThanOrEqual(a2);
    expect(a2).toBeLessThanOrEqual(a3);
    expect(a3).toBeGreaterThanOrEqual(5000);
    expect(s.lockoutRemainingMs()).toBeGreaterThan(0);
    s.resetFailedAttempts();
    expect(s.lockoutRemainingMs()).toBe(0);
  });

  it('idle 监听已注册', () => {
    const chromeAny = chrome as unknown as { idle: { setDetectionInterval: ReturnType<typeof vi.fn>; onStateChanged: { addListener: ReturnType<typeof vi.fn> } } };
    const mod = session as { setupIdleLock: () => void };
    mod.setupIdleLock();
    expect(chromeAny.idle.setDetectionInterval).toHaveBeenCalledWith(15 * 60);
    expect(chromeAny.idle.onStateChanged.addListener).toHaveBeenCalled();
  });

  it('自动锁定时间可调：默认 15 分钟，0 = 只保留锁屏锁定', async () => {
    const chromeAny = chrome as unknown as { idle: { setDetectionInterval: ReturnType<typeof vi.fn> } };
    expect(await session.getIdleLockMinutes()).toBe(15);

    await session.setIdleLockMinutes(30);
    expect(await session.getIdleLockMinutes()).toBe(30);
    expect(chromeAny.idle.setDetectionInterval).toHaveBeenLastCalledWith(30 * 60);

    await session.setIdleLockMinutes(0);
    expect(await session.getIdleLockMinutes()).toBe(0);
    expect(chromeAny.idle.setDetectionInterval).toHaveBeenLastCalledWith(12 * 60 * 60);
  });

  it('记住解锁：持久化 DEK → 重启（session 清空）→ 自动恢复 → 手动锁定清除', async () => {
    const { envelope, dek } = await vault.createVault('test-password-123', 'test');
    const { data } = await vault.openVault(envelope, 'test-password-123');

    // 1. 解锁 + 开启记忆
    session.setVaultExistsProbe(async () => true);
    await session.saveUnlockedState(dek, envelope, data);
    await session.setRememberUnlock(true, dek);
    expect(await session.isRememberEnabled()).toBe(true);

    // 2. 模拟浏览器重启：session 清空，但 local 还在
    sessionBag.clear();
    expect(await session.getRememberedDek()).not.toBeNull();
    const restored = await session.getRememberedDek();
    expect(vault.b64(restored!)).toBe(vault.b64(dek));

    // 3. 锁定 → 钥匙必删（安全），但「意愿」要留着（否则开关自己变灰）
    await session.lock();
    expect(await session.getRememberedDek()).toBeNull();
    expect(localBag.has('lv:remember')).toBe(false);
    expect(await session.isRememberEnabled()).toBe(true);
    expect(localBag.get('lv:rememberPref')).toBe(true);

    // 4. 用户主动关掉开关 → 意愿与钥匙一起清
    await session.setRememberUnlock(false);
    expect(await session.isRememberEnabled()).toBe(false);
    expect(localBag.has('lv:rememberPref')).toBe(false);
  });

  it('开机自动解锁每会话只尝试一次（否则空闲锁会被 status 立刻解开）', async () => {
    sessionBag.clear(); // 模拟浏览器启动
    expect(await session.shouldAttemptBootRestore()).toBe(true);
    expect(await session.shouldAttemptBootRestore()).toBe(false);

    // 锁定只清 session 里的会话数据，不重置这个闸门
    await session.lock();
    expect(await session.shouldAttemptBootRestore()).toBe(false);
  });

  it('默认不开启记住解锁', async () => {
    expect(await session.isRememberEnabled()).toBe(false);
    expect(await session.getRememberedDek()).toBeNull();
  });

  it('记住解锁：包裹失败就不落盘（不明文兜底）', async () => {
    const { envelope, dek } = await vault.createVault('test-password-123', 'test');
    await vault.openVault(envelope, 'test-password-123');
    session.setVaultExistsProbe(async () => true);
    session.setRememberCrypto(async () => { throw new Error('host-unavailable'); }, realUnwrap);
    await expect(session.setRememberUnlock(true, dek)).rejects.toThrow();
    expect(localBag.has('lv:remember')).toBe(false);
    expect(localBag.has('lv:rememberPref')).toBe(false);
    session.setRememberCrypto(realWrap, realUnwrap);
  });

  it('记住解锁：旧版裸 base64（无 dpapi: 前缀）一律作废', async () => {
    localBag.set('lv:remember', Buffer.from(new Uint8Array(32)).toString('base64'));
    expect(await session.getRememberedDek()).toBeNull();
    expect(localBag.has('lv:remember')).toBe(false);
  });
});