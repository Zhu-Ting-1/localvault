/**
 * 性能基线：1000 条条目时的加密/解密开销。
 *
 * 这里只测「数据层」——每次保存都要重加密整个 payload，这是最容易随条目数变慢的一环。
 * UI 列表渲染是另一回事（默认 1000 条一次性渲染约几百毫秒，已用 content-visibility 缓解）。
 */
import { describe, it, expect } from 'vitest';
import { createVault, type VaultData, type VaultEntry } from '../src/lib/vault';
import { encryptPayloadWithDek, decryptWithDek } from '../src/lib/payload';

function mkEntry(i: number): VaultEntry {
  return {
    id: `id-${i}`,
    title: `站点 ${i} · 一个还算正常长度的标题`,
    username: `user${i}@example.test`,
    password: `Pw-${i}-${'x'.repeat(12)}!`,
    urls: [`https://site${i}.example.test/login`, `https://www.site${i}.example.test/`],
    notes: i % 7 === 0 ? '这条带备注，用来让数据更接近真实分布。'.repeat(3) : '',
    createdAt: new Date(2026, 0, 1).toISOString(),
    updatedAt: new Date(2026, 0, 2).toISOString(),
    passwordHistory: [{ password: `Old-${i}-1`, changedAt: new Date(2025, 11, 1).toISOString() }],
  } as VaultEntry;
}

describe('性能 · 1000 条条目', () => {
  it('加密 + 解密都在可接受范围内，且数据完整', async () => {
    const { envelope, dek } = await createVault('perf-master-pw-123', '0.2.0');
    const data: VaultData = {
      entries: Array.from({ length: 1000 }, (_, i) => mkEntry(i)),
      meta: { createdAt: new Date(2026, 0, 1).toISOString(), generatorVersion: '0.2.0' },
    };

    const t0 = performance.now();
    const next = await encryptPayloadWithDek(envelope, dek, data);
    const t1 = performance.now();
    const back = await decryptWithDek(next, dek);
    const t2 = performance.now();

    const encMs = Math.round(t1 - t0);
    const decMs = Math.round(t2 - t1);
    console.log(`    [perf] 1000 条：加密 ${encMs}ms / 解密 ${decMs}ms`);

    expect(back.entries.length).toBe(1000);
    expect(back.entries[999]!.username).toBe('user999@example.test');
    // 阈值按「机械硬盘 + 老笔记本」留足余量；实测通常是个位数毫秒
    expect(encMs).toBeLessThan(300);
    expect(decMs).toBeLessThan(300);
  });
});
