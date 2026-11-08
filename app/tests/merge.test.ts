/**
 * 合并引擎（lib/commit.ts）的并发行为测试。
 *
 * 这里用内存 store 精确控制时序：在「我方 read 之后、write 之前」插入另一个浏览器
 * 的完整写入，验证我们的重放不会把它覆盖掉。这比开两个真浏览器更能钉住语义，
 * 也不受环境波动影响（真浏览器并发在 e2e 里另有冒烟）。
 */
import { describe, it, expect } from 'vitest';
import { createVault, type Envelope, type VaultEntry, type VaultData } from '../src/lib/vault';
import { decryptWithDek } from '../src/lib/payload';
import { commitOps, applyOp, type VaultStore } from '../src/lib/commit';

const MASTER = 'merge-test-master-pw';
const VER = '0.2.0';

function mkEntry(id: string, username: string, password = 'Pass-' + id): VaultEntry {
  return {
    id, title: '站点 ' + id, username, password,
    urls: ['https://' + id + '.test'], notes: '',
    createdAt: '', updatedAt: '', passwordHistory: [],
  } as VaultEntry;
}

interface MemStore {
  store: VaultStore;
  hooks: { beforeWrite: null | (() => Promise<void>) };
  writes: number;
  lastEnvelope: () => Envelope;
  decode: () => Promise<VaultData>;
}

/** 内存中的「保险库文件」：CAS 语义与 host 一致（baseRevision 不等于当前 revision 就冲突） */
function memStore(initial: Envelope, dek: Uint8Array): MemStore {
  let envelope = initial;
  let revision = 1;
  const m: MemStore = {
    hooks: { beforeWrite: null },
    writes: 0,
    lastEnvelope: () => envelope,
    decode: () => decryptWithDek(envelope, dek),
    store: {
      read: async () => ({ envelope, revision }),
      write: async (e: Envelope, base: number) => {
        // 模拟「另一个浏览器恰好在这时写入」：先执行钩子，再校验 revision
        const hook = m.hooks.beforeWrite;
        m.hooks.beforeWrite = null;
        if (hook) await hook();
        if (base !== revision) throw Object.assign(new Error('conflict'), { code: 'conflict' });
        envelope = e;
        revision += 1;
        m.writes += 1;
        return revision;
      },
    },
  };
  return m;
}

async function freshVault() {
  const { envelope, dek } = await createVault(MASTER, VER);
  return { envelope, dek };
}

describe('合并引擎 · 并发写入不丢数据', () => {
  it('两个浏览器同时新增不同条目 → 两条都在', async () => {
    const { envelope, dek } = await freshVault();
    const s = memStore(envelope, dek);

    // 我方读到 revision 1，正准备写 B；此刻另一个浏览器抢先写入 A
    s.hooks.beforeWrite = async () => {
      await commitOps(s.store, dek, [{ kind: 'upsert-entry', entry: mkEntry('a', 'a@test') }]);
    };
    const res = await commitOps(s.store, dek, [
      { kind: 'upsert-entry', entry: mkEntry('b', 'b@test') },
    ]);

    const data = await s.decode();
    const ids = data.entries.map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']);
    expect(res.attempts).toBe(2); // 撞了一次冲突并重放成功
  });

  it('同时改同一条 → 后写生效，被覆盖的旧密码进历史', async () => {
    const { envelope, dek } = await freshVault();
    const s = memStore(envelope, dek);

    // 先落一条 p1
    await commitOps(s.store, dek, [{ kind: 'upsert-entry', entry: mkEntry('x', 'x@test', 'p1') }]);

    // 我方要写 p3；另一个浏览器在中间把密码改成 p2
    s.hooks.beforeWrite = async () => {
      await commitOps(s.store, dek, [{ kind: 'upsert-entry', entry: mkEntry('x', 'x@test', 'p2') }]);
    };
    await commitOps(s.store, dek, [{ kind: 'upsert-entry', entry: mkEntry('x', 'x@test', 'p3') }]);

    const data = await s.decode();
    const entry = data.entries.find((e) => e.id === 'x')!;
    expect(entry.password).toBe('p3');
    const history = entry.passwordHistory.map((h) => h.password);
    expect(history).toContain('p1');
    expect(history).toContain('p2');
  });

  it('一个浏览器删除、另一个新增 → 删除生效且新增还在', async () => {
    const { envelope, dek } = await freshVault();
    const s = memStore(envelope, dek);
    await commitOps(s.store, dek, [
      { kind: 'upsert-entry', entry: mkEntry('old', 'old@test') },
      { kind: 'upsert-entry', entry: mkEntry('keep', 'keep@test') },
    ]);

    s.hooks.beforeWrite = async () => {
      await commitOps(s.store, dek, [{ kind: 'delete-entry', id: 'old' }]);
    };
    await commitOps(s.store, dek, [{ kind: 'upsert-entry', entry: mkEntry('fresh', 'fresh@test') }]);

    const ids = (await s.decode()).entries.map((e) => e.id).sort();
    expect(ids).toEqual(['fresh', 'keep']);
  });

  it('一直冲突 → 明确抛错，且磁盘数据保持原样（不半截写入）', async () => {
    const { envelope, dek } = await freshVault();
    const before = await decryptWithDek(envelope, dek);

    const stubborn: VaultStore = {
      read: async () => ({ envelope, revision: 1 }),
      write: async () => { throw Object.assign(new Error('conflict'), { code: 'conflict' }); },
    };
    await expect(commitOps(stubborn, dek, [{ kind: 'upsert-entry', entry: mkEntry('z', 'z@test') }]))
      .rejects.toMatchObject({ code: 'conflict' });

    const after = await decryptWithDek(envelope, dek);
    expect(after.entries.length).toBe(before.entries.length);
  });

  it('重放次数可配置，且不会无限重试', async () => {
    const { envelope, dek } = await freshVault();
    let writes = 0;
    const always: VaultStore = {
      read: async () => ({ envelope, revision: 1 }),
      write: async () => { writes += 1; throw Object.assign(new Error('conflict'), { code: 'conflict' }); },
    };
    await expect(commitOps(always, dek, [], { retries: 3 })).rejects.toMatchObject({ code: 'conflict' });
    expect(writes).toBe(3);
  });
});

describe('applyOp · 重放规则', () => {
  const base = (): VaultData => ({ entries: [], meta: { createdAt: '2026-01-01', generatorVersion: VER } } as VaultData);

  it('更新时调用方没带的字段不会被清空', () => {
    const d = base();
    applyOp(d, { kind: 'upsert-entry', entry: mkEntry('k', 'k@test', 'pw1') });
    // 只带 id + password 的“补丁式”更新
    applyOp(d, { kind: 'upsert-entry', entry: { id: 'k', password: 'pw2' } as VaultEntry });
    const e = d.entries[0]!;
    expect(e.password).toBe('pw2');
    expect(e.username).toBe('k@test');      // 未被 undefined 覆盖
    expect(e.urls.length).toBe(1);
  });

  it('密码未变时不追加历史', () => {
    const d = base();
    applyOp(d, { kind: 'upsert-entry', entry: mkEntry('h', 'h@test', 'same') });
    applyOp(d, { kind: 'upsert-entry', entry: mkEntry('h', 'h@test', 'same') });
    expect(d.entries[0]!.passwordHistory.length).toBe(0);
  });

  it('删除不存在的 id 不报错', () => {
    const d = base();
    expect(() => applyOp(d, { kind: 'delete-entry', id: 'nope' })).not.toThrow();
    expect(d.entries.length).toBe(0);
  });
});
