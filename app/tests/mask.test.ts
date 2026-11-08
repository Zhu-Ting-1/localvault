import { describe, it, expect } from 'vitest';
import { maskValue, identityKind, maskCollides } from '../src/lib/mask';

// 号码用拼接构造：源码里不出现连续 11 位数字，避免被外部脱敏工具改写
const P1 = '132' + '1234' + '2398';
const P2 = '+86' + '132' + '1234' + '2398';
const P_SPACED = '132' + ' 1234 ' + '2398';
const P_DASHED = '132' + '-1234-' + '2398';
// 前 3 位、后 4 位都相同，只有中间不同 → 打码后无法区分
const P_SAME_TAIL_A = '138' + '0000' + '1234';
const P_SAME_TAIL_B = '138' + '9999' + '1234';
const P_OTHER = '139' + '0000' + '5678';

describe('identityKind', () => {
  it('识别手机号、邮箱与通用账号', () => {
    expect(identityKind(P1)).toBe('phone');
    expect(identityKind(P2)).toBe('phone');
    expect(identityKind('octocat@example.com')).toBe('email');
    expect(identityKind('zhangsan')).toBe('generic');
    expect(identityKind('张三')).toBe('generic');
  });
});

describe('maskValue · 手机号', () => {
  it('11 位手机号 → 前 3 后 4', () => {
    expect(maskValue(P1)).toBe('132****2398');
  });

  it('保留 + 前缀（国际号码）', () => {
    expect(maskValue(P2)).toBe('+861******2398');
  });

  it('带空格/横线也能打码', () => {
    expect(maskValue(P_DASHED)).toBe('132****2398');
    expect(maskValue(P_SPACED)).toBe('132****2398');
  });

  it('4 位数字不像手机号，按通用规则保留首尾', () => {
    expect(maskValue('1234')).toBe('1**4');
  });

  it('7 位短号保留前 2 后 1', () => {
    expect(maskValue('123' + '4567')).toBe('12****7');
  });
});

describe('maskValue · 邮箱', () => {
  it('长本地部分 → 前 2 后 1，域名保留', () => {
    expect(maskValue('octocat@example.com')).toBe('oc***t@example.com');
  });

  it('短本地部分 → 前 1', () => {
    expect(maskValue('me@example.com')).toBe('m***@example.com');
    expect(maskValue('a@x.com')).toBe('***@x.com');
  });

  it('全英文长邮箱只露头尾（前 2 后 2），中间不出现原文', () => {
    const m = maskValue('zhang.san.work@corp.example.com');
    expect(m).toBe('zh***rk@corp.example.com');
    expect(m).not.toContain('ang.san.wor');
  });
});

describe('maskValue · 通用与边界', () => {
  it('用户名按长度保留首尾', () => {
    expect(maskValue('zhangsan')).toBe('z***n');
    expect(maskValue('neo')).toBe('n*o');
    expect(maskValue('张三')).toBe('**');
  });

  it('幂等：已打码的值不会越打越花', () => {
    expect(maskValue('132****2398')).toBe('132****2398');
    expect(maskValue('oc***t@example.com')).toBe('oc***t@example.com');
  });

  it('空值返回空串', () => {
    expect(maskValue('')).toBe('');
    expect(maskValue('   ')).toBe('');
  });

  it('打码后仍能区分不同账号', () => {
    expect(maskValue(P1)).not.toBe(maskValue(P_OTHER));
    expect(maskValue('octocat@example.com')).not.toBe(maskValue('work@example.com'));
  });
});

describe('maskCollides', () => {
  it('前 3 后 4 相同的手机号打码后无法区分', () => {
    expect(maskCollides([P_SAME_TAIL_A, P_SAME_TAIL_B])).toBe(true);
  });

  it('可区分时返回 false', () => {
    expect(maskCollides([P1, P_OTHER])).toBe(false);
  });
});
