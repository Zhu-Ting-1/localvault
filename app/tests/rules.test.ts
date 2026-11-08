import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { detectPasswordRule, applyRuleToGenOpts, collectRuleContext, validateAgainstRule } from '../src/lib/rules';
import { generatePassword } from '../src/lib/generator';

function input(html: string): HTMLInputElement {
  const dom = new JSDOM(`<body>${html}</body>`);
  return dom.window.document.querySelector('input')!;
}

describe('detectPasswordRule', () => {
  it('maxlength=16 → 最多 16 位', () => {
    const r = detectPasswordRule(input('<input type="password" maxlength="16">'));
    expect(r.maxLength).toBe(16);
    expect(r.note).toContain('最多16位');
  });

  it('minlength=6 → 至少 6 位', () => {
    const r = detectPasswordRule(input('<input type="password" minlength="6">'));
    expect(r.minLength).toBe(6);
  });

  it('pattern [a-zA-Z0-9]{6,16} → 6-16位且不含符号（用户场景）', () => {
    const r = detectPasswordRule(input('<input type="password" pattern="[a-zA-Z0-9]{6,16}">'));
    expect(r.minLength).toBe(6);
    expect(r.maxLength).toBe(16);
    expect(r.symbolsAllowed).toBe(false);
    expect(r.note).toBe('6-16位 · 不含符号');
  });

  it('pattern 含符号类 → 允许符号', () => {
    const r = detectPasswordRule(input('<input type="password" pattern="[a-zA-Z0-9!@#$%]{8,}">'));
    expect(r.symbolsAllowed).toBe(true);
  });

  it('title 提示「只能是字母或数字」→ 不含符号', () => {
    const r = detectPasswordRule(input('<input type="password" title="密码只能包含字母和数字">'));
    expect(r.symbolsAllowed).toBe(false);
  });

  it('无限制属性 → 空规则（默认 20 位可用）', () => {
    const r = detectPasswordRule(input('<input type="password">'));
    expect(r.minLength).toBeUndefined();
    expect(r.maxLength).toBeUndefined();
    expect(r.symbolsAllowed).toBeUndefined();
    expect(r.note).toBe('');
  });

  it('null 输入 → 空规则', () => {
    expect(detectPasswordRule(null).note).toBe('');
  });
});

describe('applyRuleToGenOpts', () => {
  it('默认 20 位被 maxlength=16 夹住 → 16', () => {
    expect(applyRuleToGenOpts({ maxLength: 16 }).length).toBe(16);
  });

  it('minlength=6 而请求 5 → 提到 6', () => {
    expect(applyRuleToGenOpts({ minLength: 6 }, { length: 5 }).length).toBe(6);
  });

  it('symbolsAllowed=false → 关符号', () => {
    expect(applyRuleToGenOpts({ symbolsAllowed: false }).symbols).toBe(false);
  });

  it('无规则 → 默认 20 位带符号', () => {
    const o = applyRuleToGenOpts({});
    expect(o.length).toBe(20);
    expect(o.symbols).toBe(true);
  });

  it('端到端：规则约束下生成的密码必须真的满足规则（注册能过）', () => {
    // 用户场景：6-16 位字母或数字
    const rule = { minLength: 6, maxLength: 16, symbolsAllowed: false };
    for (let i = 0; i < 20; i++) {
      const o = applyRuleToGenOpts(rule);
      const pw = generatePassword(o);
      expect(pw.length).toBeGreaterThanOrEqual(6);
      expect(pw.length).toBeLessThanOrEqual(16);
      expect(pw).toMatch(/^[a-zA-Z0-9]+$/); // 不含符号
    }
  });
});

describe('提示文字规则（国内站点常见写法）', () => {
  it('用户场景：「6~30位字母或数字」→ 6-30 位且不含符号', () => {
    const el = input('<input type="password" placeholder="请输入6~30位字母或数字">');
    const r = detectPasswordRule(el, { scopeText: collectRuleContext(el) });
    expect(r.minLength).toBe(6);
    expect(r.maxLength).toBe(30);
    expect(r.symbolsAllowed).toBe(false);
    expect(r.note).toBe('6-30位 · 不含符号');
    const pw = generatePassword(applyRuleToGenOpts(r));
    expect(validateAgainstRule(pw, r)).toBeNull();
  });

  it('邻近提示文字「密码为6-16位字母、数字组成」→ 不含符号', () => {
    const el = input('<div id="wrap"><input type="password"><span id="tip">密码为6-16位字母、数字组成</span></div>');
    // 取到的是 div，用 querySelector('input')
    const pw = el.ownerDocument.querySelector('input')!;
    const r = detectPasswordRule(pw, { scopeText: '密码为6-16位字母、数字组成' });
    expect(r.maxLength).toBe(16);
    expect(r.symbolsAllowed).toBe(false);
  });

  it('「至少8位，最多20位」→ min=8 max=20', () => {
    const r = detectPasswordRule(input('<input type="password">'), { scopeText: '密码至少8位，最多20位' });
    expect(r.minLength).toBe(8);
    expect(r.maxLength).toBe(20);
  });

  it('「必须包含特殊字符」→ 强制带符号', () => {
    const r = detectPasswordRule(input('<input type="password">'), { scopeText: '密码必须包含特殊字符' });
    expect(r.symbolsRequired).toBe(true);
    expect(applyRuleToGenOpts(r).symbols).toBe(true);
  });

  it('防误判：「需包含字母和数字」是正面要求，不等于禁止符号', () => {
    const r = detectPasswordRule(input('<input type="password">'), { scopeText: '密码需包含字母和数字' });
    expect(r.symbolsAllowed).toBeUndefined();
  });

  it('「只能包含字母或数字或特殊符号」→ 不判不含符号', () => {
    const r = detectPasswordRule(input('<input type="password">'), { scopeText: '密码只能包含字母或数字或特殊符号' });
    expect(r.symbolsAllowed).toBeUndefined();
  });

  it('maxlength=6 时生成的密码不被截断（生成器下限放开）', () => {
    const rule = detectPasswordRule(input('<input type="password" maxlength="6">'));
    const pw = generatePassword(applyRuleToGenOpts(rule));
    expect(pw.length).toBe(6);
    expect(validateAgainstRule(pw, rule)).toBeNull();
  });

  it('属性优先于文案：maxlength=16 与「6~30位」冲突时取更严格的 16', () => {
    const el = input('<input type="password" maxlength="16" placeholder="6~30位字母或数字">');
    const r = detectPasswordRule(el, { scopeText: collectRuleContext(el) });
    expect(r.maxLength).toBe(16);
    expect(r.symbolsAllowed).toBe(false);
    expect(generatePassword(applyRuleToGenOpts(r)).length).toBe(16);
  });

  it('pattern 要求必须含符号 → symbolsRequired', () => {
    const r = detectPasswordRule(input('<input type="password" pattern="(?=.*[!@#]).{8,20}">'));
    expect(r.symbolsRequired).toBe(true);
  });
});

describe('validateAgainstRule', () => {
  it('合规返回 null，超长/带符号给出原因', () => {
    const rule = { minLength: 6, maxLength: 16, symbolsAllowed: false };
    expect(validateAgainstRule('Abc123', rule)).toBeNull();
    expect(validateAgainstRule('Abc1', rule)).toContain('至少');
    expect(validateAgainstRule('A'.repeat(20), rule)).toContain('最多');
    expect(validateAgainstRule('Abc123!', rule)).toContain('不允许特殊字符');
  });
});