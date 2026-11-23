import { describe, it, expect } from 'vitest';
import { parseEnvelope, createVault } from '../src/lib/vault';

describe('parseEnvelope（旧数据/损坏数据防崩）', () => {
  it('无法识别的测试密文 → null（不抛异常）', () => {
    expect(parseEnvelope('localvault-unknown-format-2026')).toBeNull();
  });

  it('空值 / null / undefined → null', () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope(undefined)).toBeNull();
    expect(parseEnvelope('')).toBeNull();
  });

  it('合法 JSON 但格式不对 → null', () => {
    expect(parseEnvelope('{"hello":"world"}')).toBeNull();
    expect(parseEnvelope('{"format":"localvault/v9","kdf":{}}')).toBeNull();
    expect(parseEnvelope('[1,2,3]')).toBeNull();
  });

  it('损坏的 JSON → null（不抛异常）', () => {
    expect(parseEnvelope('{"format": ')).toBeNull();
    expect(parseEnvelope('not json at all')).toBeNull();
  });

  it('createVault 产出的 envelope 能被解析回来', async () => {
    const { envelope } = await createVault('some-password-123', 'test');
    expect(parseEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  });
});