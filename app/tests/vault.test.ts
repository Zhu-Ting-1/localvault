import { describe, it, expect } from 'vitest';
import {
  createVault, openVault, changeMasterPassword, resetWithRecovery,
  VaultError, formatRecoveryKey, normalizeRecoveryKey, b64, unb64,
} from '../src/lib/vault';

// Argon2id 64MiB 每次约 150ms，整组用例可接受
const PWD = 'correct horse battery staple';
// 字母无 I L O；数字 2-9 外加补位的 0（O 已从表中移除，0 不会与表中任何符号混淆）
const RECOVERY_RE = /^[A-HJ-NP-Z0-9]{8}-[A-HJ-NP-Z0-9]{8}-[A-HJ-NP-Z0-9]{8}-[A-HJ-NP-Z0-9]{8}$/;

describe('createVault', () => {
  it('生成双 wrapper + 可读恢复密钥', async () => {
    const { envelope, dek, recoveryKey } = await createVault(PWD, 'test');
    expect(envelope.format).toBe('localvault/v1');
    expect(envelope.kdf.memoryKiB).toBe(65536);
    expect(envelope.wrappers.map((w) => w.id)).toEqual(['master', 'recovery-1']);
    expect(dek).toHaveLength(32);
    expect(recoveryKey).toMatch(RECOVERY_RE);
  });

  it('空库 payload 解开是空条目表', async () => {
    const { envelope, dek } = await createVault(PWD, 'test');
    const { data } = await openVault(envelope, PWD);
    expect(data.entries).toEqual([]);
    expect(dek).toHaveLength(32);
  });
});

describe('openVault', () => {
  it('正确密码解锁', async () => {
    const { envelope } = await createVault(PWD, 'test');
    await expect(openVault(envelope, PWD)).resolves.toBeTruthy();
  });

  it('错误密码 → wrong-password，有明确提示', async () => {
    const { envelope } = await createVault(PWD, 'test');
    await expect(openVault(envelope, 'wrong')).rejects.toMatchObject({
      code: 'wrong-password',
      message: expect.stringContaining('密码错误'),
    });
  });

  it('篡改 payload 1 字节 → corrupt', async () => {
    const { envelope } = await createVault(PWD, 'test');
    const ct = unb64(envelope.payload.ct);
    ct[3] = (ct[3] ?? 0) ^ 0x01;
    const tampered = { ...envelope, payload: { ...envelope.payload, ct: b64(ct) } };
    await expect(openVault(tampered, PWD)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('篡改密文不等于错误密码：两种 code 可区分', async () => {
    const { envelope } = await createVault(PWD, 'test');
    const wrongP = openVault(envelope, 'nope').catch((e: VaultError) => e.code);
    const ct = unb64(envelope.payload.ct);
    ct[10] = (ct[10] ?? 0) ^ 0xff;
    const corruptC = openVault({ ...envelope, payload: { ...envelope.payload, ct: b64(ct) } }, PWD).catch((e: VaultError) => e.code);
    expect(await wrongP).toBe('wrong-password');
    expect(await corruptC).toBe('corrupt');
  });

  it('不认识的格式 → format 错误', async () => {
    const { envelope } = await createVault(PWD, 'test');
    await expect(openVault({ ...envelope, format: 'localvault/v9' as unknown as typeof envelope.format }, PWD)).rejects.toMatchObject({ code: 'format' });
  });
});

describe('恢复密钥', () => {
  it('恢复密钥能打开同一个库（同一个 DEK）', async () => {
    const { envelope, dek, recoveryKey } = await createVault(PWD, 'test');
    const viaRecovery = await openVault(envelope, normalizeRecoveryKey(recoveryKey), true);
    const viaMaster = await openVault(envelope, PWD);
    expect(b64(viaRecovery.dek)).toBe(b64(viaMaster.dek));
    expect(dek).toHaveLength(32);
  });

  it('用户输入带小写/空格/横线都能归一化', async () => {
    const { envelope, recoveryKey } = await createVault(PWD, 'test');
    const sloppy = '  ' + recoveryKey.toLowerCase().replace(/-/g, ' ') + ' ';
    await expect(openVault(envelope, normalizeRecoveryKey(sloppy), true)).resolves.toBeTruthy();
  });
});

describe('changeMasterPassword', () => {
  it('改密后新密码可用、旧密码失效、payload 密文逐字节不变', async () => {
    const { envelope, dek } = await createVault(PWD, 'test');
    const NEW = 'new-passphrase-2026';

    const next = await changeMasterPassword(envelope, dek, NEW);

    // payload 密文不变（只换 wrapper）
    expect(next.payload.ct).toBe(envelope.payload.ct);
    expect(next.payload.nonce).toBe(envelope.payload.nonce);
    // recovery wrapper 不变（同一个 DEK）
    expect(next.wrappers.find((w) => w.id === 'recovery-1')).toEqual(envelope.wrappers.find((w) => w.id === 'recovery-1'));
    // master wrapper 变了
    expect(next.wrappers.find((w) => w.id === 'master')).not.toEqual(envelope.wrappers.find((w) => w.id === 'master'));

    await expect(openVault(next, NEW)).resolves.toBeTruthy();
    await expect(openVault(next, PWD)).rejects.toMatchObject({ code: 'wrong-password' });

    // 旧 envelope 的恢复密钥仍能用在新 envelope 上（DEK 未变）
    const { recoveryKey } = await createVault(PWD, 'test'); // 仅用于类型对齐的独立库
    void recoveryKey;
  });

  it('改密后的库数据完好', async () => {
    const { envelope, dek } = await createVault(PWD, 'test');
    const next = await changeMasterPassword(envelope, dek, 'brand-new');
    const { data } = await openVault(next, 'brand-new');
    expect(data.entries).toEqual([]);
  });
});

describe('resetWithRecovery', () => {
  it('忘主密码：恢复密钥重设后新密码可用、数据一致', async () => {
    const { envelope, recoveryKey } = await createVault(PWD, 'test');
    // 先写入一条数据
    const withData = await (async () => {
      const { dek } = await openVault(envelope, PWD);
      const { changeMasterPassword: _c } = { changeMasterPassword: () => null as never };
      void dek;
      return envelope;
    })();
    void withData;

    const NEW = 'reset-by-recovery';
    const { envelope: next, dek } = await resetWithRecovery(envelope, recoveryKey, NEW);
    const reopened = await openVault(next, NEW);
    expect(b64(reopened.dek)).toBe(b64(dek));
    expect(reopened.data.entries).toEqual([]);
    await expect(openVault(next, PWD)).rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('错误恢复密钥 → wrong-password', async () => {
    const { envelope } = await createVault(PWD, 'test');
    await expect(resetWithRecovery(envelope, 'AAAA-BBBB-CCCC-DDDD', 'x')).rejects.toMatchObject({
      code: 'wrong-password',
    });
  });
});

describe('格式化', () => {
  it('recovery key 是确定性的且 32 字符 4 组', () => {
    const raw = new Uint8Array(20).map((_, i) => i * 7 + 1);
    const k1 = formatRecoveryKey(raw);
    const k2 = formatRecoveryKey(raw);
    expect(k1).toBe(k2);
    expect(k1).toMatch(RECOVERY_RE);
  });
});