import { describe, it, expect } from 'vitest';
import { generatePassword, passwordStrength } from '../src/lib/generator';

describe('generatePassword', () => {
  it('默认 20 位且每类至少一个', () => {
    const p = generatePassword();
    expect(p).toHaveLength(20);
    expect(p).toMatch(/[a-z]/);
    expect(p).toMatch(/[A-Z]/);
    expect(p).toMatch(/[2-9]/);
    expect(p).toMatch(/[!@#$%^&*\-_=+?]/);
  });

  it('关闭符号时不包含符号', () => {
    const p = generatePassword({ symbols: false });
    expect(p).not.toMatch(/[!@#$%^&*\-_=+?]/);
  });

  it('长度可调且夹在 4..64（站点 maxlength 可能只有 6 位，必须能生成短密码）', () => {
    expect(generatePassword({ length: 4 })).toHaveLength(4);
    expect(generatePassword({ length: 6 })).toHaveLength(6);
    expect(generatePassword({ length: 200 })).toHaveLength(64);
    expect(generatePassword({ length: 32 })).toHaveLength(32);
  });

  it('生成 6 位且关符号时仍满足「字母或数字」类站点规则', () => {
    const p = generatePassword({ length: 6, symbols: false });
    expect(p).toHaveLength(6);
    expect(p).toMatch(/^[a-zA-Z2-9]+$/);
  });

  it('不含易混淆字符 0 O 1 l I', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });

  it('多次生成不重复（CSPRNG 基本随机性）', () => {
    const set = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(set.size).toBe(20);
  });
});

describe('passwordStrength', () => {
  it('短密码 0 分', () => expect(passwordStrength('abc').score).toBe(0));
  it('20 位混合 4 分', () => {
    const p = generatePassword();
    expect(passwordStrength(p).score).toBe(4);
  });
});