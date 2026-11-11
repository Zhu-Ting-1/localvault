/**
 * 常用身份：DEK 加密落盘 + 明文旧数据迁移 + 锁定态行为。
 * 关注点：storage.local 里不能出现完整手机号/邮箱明文。
 */
import { describe, it, expect, beforeEach } from 'vitest';

// 号码拼接，避免源码出现连续数字被外部脱敏工具改写
const PHONE = '138' + '0000' + '1234';
const EMAIL = 'zhangsan' + '@' + 'example.com';

const sessionBag = new Map<string, unknown>();
const localBag = new Map<string, unknown>();

beforeEach(() => {
  sessionBag.clear();
  localBag.clear();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { sendMessage: () => Promise.resolve() },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: sessionBag.get(key) }),
        set: async (vals: Record<string, unknown>) => { for (const [k, v] of Object.entries(vals)) sessionBag.set(k, v); },
        remove: async (keys: string[]) => { for (const k of keys) sessionBag.delete(k); },
      },
      local: {
        get: async (key: string) => ({ [key]: localBag.get(key) }),
        set: async (vals: Record<string, unknown>) => { for (const [k, v] of Object.entries(vals)) localBag.set(k, v); },
        remove: async (keys: string | string[]) => {
          for (const k of typeof keys === 'string' ? [keys] : keys) localBag.delete(k);
        },
      },
    },
    idle: { setDetectionInterval: () => {}, onStateChanged: { addListener: () => {} } },
  };
});

const vault = await import('../src/lib/vault');
const session = await import('../src/lib/session');

async function unlock() {
  const { envelope, dek } = await vault.createVault('test-password-123', 'test');
  await session.saveUnlockedState(dek, envelope, { entries: [] } as never);
  return dek;
}

describe('常用身份 · 加密落盘', () => {
  it('写入后能完整读回（内存里是完整值）', async () => {
    await unlock();
    await session.setIdentities([
      { id: 'i1', label: '手机', value: PHONE },
      { id: 'i2', label: 'QQ邮箱', value: EMAIL },
    ]);
    const list = await session.getIdentities();
    expect(list.map((x) => x.value)).toEqual([PHONE, EMAIL]);
  });

  it('磁盘上是密文块，不含完整手机号/邮箱', async () => {
    await unlock();
    await session.setIdentities([{ id: 'i1', label: '手机', value: PHONE }, { id: 'i2', label: 'QQ邮箱', value: EMAIL }]);

    const raw = localBag.get('lv:identities');
    expect(Array.isArray(raw)).toBe(false);
    const blob = raw as { v: number; nonce: string; ct: string; aad: string };
    expect(blob.v).toBe(1);
    expect(typeof blob.ct).toBe('string');
    expect(blob.aad).toBe('localvault-identities/v1');

    const dump = JSON.stringify(raw);
    expect(dump).not.toContain(PHONE);
    expect(dump).not.toContain('138');
    expect(dump).not.toContain('zhangsan');
    expect(dump).not.toContain('example.com');
  });

  it('同一份数据两次加密的密文不同（随机 nonce）', async () => {
    await unlock();
    await session.setIdentities([{ id: 'i1', label: '手机', value: PHONE }]);
    const first = (localBag.get('lv:identities') as { ct: string }).ct;
    await session.setIdentities([{ id: 'i1', label: '手机', value: PHONE }]);
    const second = (localBag.get('lv:identities') as { ct: string }).ct;
    expect(first).not.toBe(second);
  });

  it('旧版明文数组会被自动迁移成密文', async () => {
    await unlock();
    localBag.set('lv:identities', [{ id: 'i1', label: '手机', value: PHONE }]);

    const list = await session.getIdentities();
    expect(list[0]?.value).toBe(PHONE);

    const after = localBag.get('lv:identities');
    expect(Array.isArray(after)).toBe(false);
    expect(JSON.stringify(after)).not.toContain(PHONE);
  });
});

describe('常用身份 · 锁定态', () => {
  it('锁定后读不到（没有 DEK），写入报 locked', async () => {
    await unlock();
    await session.setIdentities([{ id: 'i1', label: '手机', value: PHONE }]);

    await session.lock();
    expect(await session.getIdentities()).toEqual([]);
    await expect(session.setIdentities([{ id: 'i2', label: 'x', value: 'y' }])).rejects.toMatchObject({ code: 'locked' });
  });

  it('解锁后能重新读到之前的身份', async () => {
    const dek = await unlock();
    await session.setIdentities([{ id: 'i1', label: '手机', value: PHONE }]);
    const envelope = await session.loadSessionEnvelope();
    await session.lock();

    // 模拟重新解锁：同一 DEK 恢复会话
    await session.saveUnlockedState(dek, envelope!, { entries: [] } as never);
    const list = await session.getIdentities();
    expect(list[0]?.value).toBe(PHONE);
  });

  it('密文损坏时按空处理，不抛错（保险库重建场景）', async () => {
    await unlock();
    localBag.set('lv:identities', { v: 1, nonce: 'AAAA', ct: 'BBBB', aad: 'localvault-identities/v1' });
    expect(await session.getIdentities()).toEqual([]);
  });
});
