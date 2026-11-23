/**
 * 端到端：真实 host、真实文件系统。全程在测试目录（app/.e2e-vault）进行，
 * 不读取也不修改用户的真实保险库。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vault from '../src/lib/vault';
import { encryptPayloadWithDek } from '../src/lib/payload';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// host 位置不再固定在 %LOCALAPPDATA%（数据/程序都跟随用户选的安装目录），
// 测试用仓库构建产物；特殊场景可用 LOCALVAULT_HOST_EXE 覆盖。
const HOST_EXE = process.env.LOCALVAULT_HOST_EXE
  || join(here, '..', '..', 'host', 'vault-host.exe');
const ROOT = join(root, '.e2e-vault');

const PWD = 'e2e-master-pw-2026';
const TEST_ENTRIES = [
  { id: 'e1', title: '测试条目A', username: 'user-a@example.test', password: 'p@ssA-2026', urls: ['https://a.example.com'], notes: 'note A', createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z', passwordHistory: [] },
  { id: 'e2', title: '测试条目B', username: 'user-b', password: 'p@ssB-2026', urls: [], notes: '', createdAt: '2026-11-04T10:01:00Z', updatedAt: '2026-11-04T10:01:00Z', passwordHistory: [] },
];

let child: ChildProcess;
let buf = Buffer.alloc(0);
let pending: ((v: unknown) => void) | null = null;

function hostCall(req: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string; message?: string }> {
  return new Promise((res) => {
    pending = res as (v: unknown) => void;
    const payload = Buffer.from(JSON.stringify(req), 'utf8');
    const head = Buffer.alloc(4);
    head.writeInt32LE(payload.length, 0);
    child.stdin!.write(Buffer.concat([head, payload]));
  });
}

beforeAll(async () => {
  expect(existsSync(HOST_EXE), 'vault-host.exe 应已构建').toBeTruthy();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  child = spawn(HOST_EXE, [], {
    env: { ...process.env, LOCALVAULT_ROOT: ROOT },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout!.on('data', (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    if (pending && buf.length >= 4) {
      const len = buf.readInt32LE(0);
      if (buf.length >= 4 + len) {
        const body = buf.subarray(4, 4 + len).toString('utf8');
        buf = buf.subarray(4 + len);
        const p = pending; pending = null;
        p(JSON.parse(body));
      }
    }
  });
  await new Promise((r) => setTimeout(r, 250));

  // 造库：createVault + 手动注入测试条目
  const created = await vault.createVault(PWD, 'e2e-test');
  const envelope = await encryptPayloadWithDek(
    created.envelope, created.dek,
    { entries: TEST_ENTRIES, meta: { createdAt: '2026-11-04T10:00:00Z', generatorVersion: 'e2e-test' } },
  );
  const w = await hostCall({ id: 'w1', op: 'write', baseRevision: 0, ciphertext: JSON.stringify(envelope) });
  expect(w.ok).toBeTruthy();
});

afterAll(() => {
  try { child?.stdin?.end(); } catch { /* noop */ }
  try { child?.kill(); } catch { /* noop */ }
  rmSync(ROOT, { recursive: true, force: true });
});

function readEnvelopeFromDisk(): { outer: Record<string, unknown>; env: vault.Envelope } {
  const outer = JSON.parse(readFileSync(join(ROOT, 'vault.db'), 'utf8'));
  return { outer, env: JSON.parse(outer.ciphertext as string) as vault.Envelope };
}

describe('端到端（真实 host 与文件系统）', () => {
  it('磁盘上没有任何条目明文', () => {
    const raw = readFileSync(join(ROOT, 'vault.db'), 'utf8');
    const probes = ['测试条目A', '测试条目B', 'user-a', 'user-b', 'p@ssA-2026', 'p@ssB-2026', 'a.example.com', 'note A', '"entries"'];
    const leaks = probes.filter((p) => raw.includes(p));
    expect(leaks, '泄漏探针: ' + leaks.join(',')).toEqual([]);
  });

  it('篡改 payload 1 字节 → 解密失败并明确提示', async () => {
    const { env } = readEnvelopeFromDisk();
    const ct = vault.unb64(env.payload.ct);
    ct[5] = (ct[5] ?? 0) ^ 0x01;
    env.payload.ct = vault.b64(ct);
    // 行为要求：要么报 corrupt（篡改定位到 payload），要么报 wrong-password（GCM tag 失败
    // 与错误密码不可区分），都必须是明确的 VaultError，绝不能静默返回数据
    await expect(vault.openVault(env, PWD)).rejects.toMatchObject({
      code: expect.stringMatching(/corrupt|wrong-password/),
    });
  });

  it('.bak 存在且可恢复到完整条目', async () => {
    // host 的 File.Replace 语义：第二次写入起才有 .bak（首次写没有旧文件可替换）。
    // 测试目录目前只写过一次 → 再写一次同内容，制造出 .bak。
    const { outer } = readEnvelopeFromDisk();
    const cur = await hostCall({ id: 'bak1', op: 'read' });
    await hostCall({ id: 'bak2', op: 'write', baseRevision: cur.data!.revision as number, ciphertext: outer.ciphertext as string });

    expect(existsSync(join(ROOT, 'vault.db.bak'))).toBeTruthy();
    const bak = JSON.parse(readFileSync(join(ROOT, 'vault.db.bak'), 'utf8'));
    const bakEnv = JSON.parse(bak.ciphertext) as vault.Envelope;
    const r = await vault.openVault(bakEnv, PWD);
    expect(r.data.entries).toHaveLength(TEST_ENTRIES.length);
    expect(r.data.entries[0]?.title).toBe(TEST_ENTRIES[0]!.title);
  });

  it('改主密码：新可用、旧失效、payload 逐字节不变、recovery 不动', async () => {
    const { env } = readEnvelopeFromDisk();
    const { dek } = await vault.openVault(env, PWD);
    const NEW = 'rotated-master-pw-2026';
    const next = await vault.changeMasterPassword(env, dek, NEW);

    expect(next.payload.ct).toBe(env.payload.ct);
    expect(next.payload.nonce).toBe(env.payload.nonce);
    expect(next.wrappers.find((w) => w.id === 'recovery-1')?.ct)
      .toBe(env.wrappers.find((w) => w.id === 'recovery-1')?.ct);

    const afterNew = await vault.openVault(next, NEW);
    expect(afterNew.data.entries).toHaveLength(TEST_ENTRIES.length);
    await expect(vault.openVault(next, PWD)).rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('导出 → 删库 → 导入 → 数据一致', async () => {
    const { outer } = readEnvelopeFromDisk();
    const exported = outer.ciphertext as string; // 导出 = 加密 envelope 原文
    writeFileSync(join(ROOT, 'export.json'), exported);

    // 删库 = 覆写成无害内容
    const w1 = await hostCall({ id: 'g1', op: 'write', baseRevision: outer.revision as number, ciphertext: JSON.stringify({ format: 'localvault/v1', deleted: true }) });
    expect(w1.ok).toBeTruthy();

    // 导入 = 写回导出文件
    const cur = await hostCall({ id: 'g2', op: 'read' });
    const w2 = await hostCall({ id: 'g3', op: 'write', baseRevision: cur.data!.revision as number, ciphertext: exported });
    expect(w2.ok).toBeTruthy();

    const restored = JSON.parse((await hostCall({ id: 'g4', op: 'read' })).data!.ciphertext as string);
    const after = await vault.openVault(restored, PWD);
    expect(after.data.entries).toHaveLength(TEST_ENTRIES.length);
    expect(after.data.entries.map((e) => e.title)).toEqual(TEST_ENTRIES.map((e) => e.title));
    expect(after.data.entries.map((e) => e.password)).toEqual(TEST_ENTRIES.map((e) => e.password));
  });

  it('连续 3 次错误密码全部被拒', async () => {
    const { env } = readEnvelopeFromDisk();
    for (let i = 0; i < 3; i++) {
      await expect(vault.openVault(env, 'totally-wrong-' + i)).rejects.toMatchObject({ code: 'wrong-password' });
    }
  });
});
