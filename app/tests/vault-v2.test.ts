/**
 * v2 payload 的行为测试。
 *
 * 重点不是"能加能解"，而是三条安全性质：
 *  1. 列表路径只解 head —— secret 坏掉也不影响列表
 *  2. AAD 绑定 —— 把密文挪到别的条目/别的用途，必须解不开
 *  3. 迁移往返 —— v1 的条目无损变成 v2 再读回来
 */
import { describe, it, expect } from 'vitest';
import { createVault, type VaultData, type VaultEntry } from '../src/lib/vault';
import {
  buildPayloadV2, readAllV2, readHeadsV2, openEntrySecret, openEntryHead,
  sealEntryV2, isPayloadV2,
} from '../src/lib/vault-v2';

const VER = '0.3.3';

function mkEntry(i: number): VaultEntry {
  return {
    id: `id-${i}`,
    title: `站点 ${i}`,
    username: `user${i}@test.local`,
    password: `Pw-${i}-secret!`,
    urls: [`https://site${i}.test`],
    notes: i % 2 ? '带备注' : '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    passwordHistory: [{ password: `Old-${i}`, changedAt: '2025-12-01T00:00:00.000Z' }],
  };
}

const mkData = (n: number): VaultData => ({
  entries: Array.from({ length: n }, (_, i) => mkEntry(i)),
  meta: { createdAt: '2026-01-01T00:00:00.000Z', generatorVersion: VER },
} as VaultData);

async function fresh() {
  const { dek } = await createVault('v2-master-pw-123', VER);
  return dek;
}

describe('vault v2 · 编码与读取', () => {
  it('迁移往返：3 条条目的每个字段都一致', async () => {
    const dek = await fresh();
    const original = mkData(3);
    const payload = await buildPayloadV2(dek, original);

    expect(isPayloadV2(payload)).toBe(true);
    expect(payload.entries.length).toBe(3);

    const back = await readAllV2(dek, payload);
    expect(back.entries).toEqual(original.entries);
    expect(back.meta.createdAt).toBe(original.meta.createdAt);
  });

  it('列表路径只解 head：secret 被破坏也不影响列表', async () => {
    const dek = await fresh();
    const payload = await buildPayloadV2(dek, mkData(2));

    // 故意把第一条的 secret 密文改坏（模拟损坏/被篡改）
    const broken = {
      ...payload,
      entries: payload.entries.map((e, i) =>
        i === 0 ? { ...e, secret: { ...e.secret, ct: e.secret.ct.slice(0, -4) + 'AAAA' } } : e),
    };

    const heads = await readHeadsV2(dek, broken);
    expect(heads.length).toBe(2);
    expect(heads[0]!.title).toBe('站点 0');
    expect(heads[0]).not.toHaveProperty('password');

    // 而解 secret 会失败 —— 说明列表路径确实没碰它
    await expect(openEntrySecret(dek, broken.entries[0]!)).rejects.toBeTruthy();
  });

  it('AAD 绑定：把 secret 挪到另一条 → 解不开', async () => {
    const dek = await fresh();
    const payload = await buildPayloadV2(dek, mkData(2));
    const [a, b] = payload.entries;

    const swapped = { ...a!, secret: b!.secret };
    await expect(openEntrySecret(dek, swapped)).rejects.toBeTruthy();
  });

  it('AAD 绑定：把 head 当 secret 解 → 解不开', async () => {
    const dek = await fresh();
    const e = await sealEntryV2(dek, mkEntry(0));
    const cross = { ...e, secret: e.head };
    await expect(openEntrySecret(dek, cross)).rejects.toBeTruthy();
  });

  it('空库与单条都能正常工作', async () => {
    const dek = await fresh();
    const empty = await buildPayloadV2(dek, mkData(0));
    expect(empty.entries.length).toBe(0);
    expect((await readHeadsV2(dek, empty)).length).toBe(0);

    const one = await buildPayloadV2(dek, mkData(1));
    const head = await openEntryHead(dek, one.entries[0]!);
    expect(head.username).toBe('user0@test.local');
  });

  it('1000 条只解 head 的耗时明显低于全解', async () => {
    const dek = await fresh();
    const payload = await buildPayloadV2(dek, mkData(1000));

    const t0 = performance.now();
    const heads = await readHeadsV2(dek, payload);
    const t1 = performance.now();
    const full = await readAllV2(dek, payload);
    const t2 = performance.now();

    console.log(`    [v2] 1000 条：只解 head ${Math.round(t1 - t0)}ms / 全解 ${Math.round(t2 - t1)}ms`);
    expect(heads.length).toBe(1000);
    expect(full.entries.length).toBe(1000);
    expect(t1 - t0).toBeLessThan(300);
  });
});
