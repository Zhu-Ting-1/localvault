/**
 * 站点密码规则检测：从注册表单的 DOM 属性与提示文字推断网站限制。
 *
 * 「注册优先」原则：密码只需在**注册那一刻**满足站点规则；登录时是把已存密码
 * 原样填回，站点不会再校验规则。所以检测只挂在生成/填充那一瞬间，不需要先注册，
 * 也不需要为登录页做规则适配。
 *
 * 信号可信度：
 *   ★★★ maxlength / minlength / pattern —— 浏览器强制执行，最可信
 *   ★★  placeholder / title / aria-describedby / 邻近提示文字 —— 常见「6~30位字母或数字」
 *   ★   填充后 input.value 被 JS 改写/截断 —— 靠 validateAgainstRule + 填充后自检兜底
 */

export interface SiteRule {
  minLength?: number;
  maxLength?: number;
  /** undefined = 未知（按默认生成）；false = 不允许符号；true = 允许符号 */
  symbolsAllowed?: boolean;
  /** 站点明确要求必须含特殊字符 */
  symbolsRequired?: boolean;
  /** 人类可读的限制说明，如「6-30位 · 不含符号」；手工构造的规则可省略 */
  note?: string;
  /** 各信号的来源（调试用） */
  sources?: string[];
}

/** 生成参数（后台生成密码时消费） */
export interface GenParams {
  length: number;
  symbols: boolean;
}

// ---------------------------------------------------------------- pattern 推断

/** 符号探针：逐个试，只要有一个能过就说明字符类允许符号 */
const SYMBOL_PROBES = ['!', '@', '#', '$', '%', '*', '-', '_', '=', '+', '?', '.', '&'];
/** 长度探针：pattern 常带 {8,} / {6,16}，单个固定长度样本容易全灭 */
const PROBE_LENGTHS = [8, 10, 12, 16, 20, 24, 30, 32];

function probeBase(len: number): string {
  // 开头保证同时有大写、小写、数字，满足常见「必须含大小写+数字」的 lookahead
  const chars = 'Aa1bcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < len) out += chars;
  return out.slice(0, len);
}

/**
 * 用 pattern 正则推断符号是否被允许。
 * 注意：HTML pattern 在浏览器里是「整串匹配」，但直接 new RegExp(p).test() 是找子串，
 * 所以必须补锚；否则 '[a-zA-Z0-9]{6,16}' 会在 'Abcdef12!@' 里匹配到子串而误判允许符号。
 *
 * 判定逻辑（对多个长度 × 多个符号交叉测试）：
 *   纯字母数字样本过 && 含符号样本过 → 允许符号
 *   纯字母数字样本过 && 所有符号样本都不过 → 不允许符号
 *   纯字母数字样本全灭 && 有符号样本过 → 站点要求必须含符号
 *   全灭 → 推不出，返回 undefined（不臆断）
 */
function patternAllowsSymbols(pattern: string): { allow?: boolean; require?: boolean } {
  let re: RegExp;
  try {
    re = new RegExp('^(?:' + pattern + ')$');
  } catch {
    return {};
  }
  let plainEverPassed = false;
  let symbolEverPassed = false;
  for (const len of PROBE_LENGTHS) {
    const base = probeBase(len - 1);
    const plainOk = re.test(base + 'x');
    let symOk = false;
    for (const sym of SYMBOL_PROBES) {
      if (re.test(base + sym)) { symOk = true; break; }
    }
    if (plainOk) plainEverPassed = true;
    if (symOk) symbolEverPassed = true;
    if (plainOk && symOk) return { allow: true };
  }
  if (symbolEverPassed && !plainEverPassed) return { allow: true, require: true };
  if (plainEverPassed && !symbolEverPassed) return { allow: false };
  return {};
}

/** 从 pattern 的量词里猜长度范围：`[a-zA-Z0-9]{6,16}` / `(?=.*\d).{8,20}` / `.{8,}` */
function patternLengthRange(pattern: string): { min?: number; max?: number } {
  // 只认「字符类/点/右括号 + {m,n}」这种长度量词，跳过 {1,} 之类的复杂度量词
  const re = /(?:[.\]wWdDsS]|\))\s*\{(\d{1,2})(?:\s*,\s*(\d{1,2})?)?\}/g;
  let picked: { min?: number; max?: number } = {};
  for (const m of pattern.matchAll(re)) {
    const min = parseInt(m[1]!, 10);
    const max = m[2] ? parseInt(m[2], 10) : undefined;
    if (min < 4 || min > 64) continue;
    if (max !== undefined && (max < min || max > 64)) continue;
    picked = { min, max }; // 主体长度量词通常在最后，取最后一个合法的
  }
  return picked;
}

// ---------------------------------------------------------------- 提示文字解析

const LEN_RANGE = /(\d{1,2})\s*[-~—－～至到]\s*(\d{1,2})\s*(?:位|个字符?|characters?|chars?)/i;
const LEN_MIN = [
  /(?:至少|不少于|最少|不小于|不低于|at\s+least|minimum|min\.?)\s*(\d{1,2})\s*(?:位|个字符?|characters?|chars?)/i,
  /(\d{1,2})\s*位(?:以上|起)/,
];
const LEN_MAX = [
  /(?:最多|不超过|至多|不大于|不高于|at\s+most|maximum|max\.?|up\s+to)\s*(\d{1,2})\s*(?:位|个字符?|characters?|chars?)/i,
  /(\d{1,2})\s*位(?:以内|以下)/,
];

// 分三类，避免把「需包含字母和数字」这类**正面要求**误判成「禁止符号」：
// A 明确说不许特殊字符；B 有「只能/仅限/由…」限定词；C 「字母或数字」「…组成」的构成式描述
const NO_SYM_EXPLICIT =
  /(?:不含|不能(?:包含|含|使用|输入)|不(?:支持|允许|可用)|禁止)[^。；;]{0,4}特殊[字符符号]|no\s+special\s+characters|alphanumeric\s+only/i;
const NO_SYM_LIMITED =
  /(?:只能|仅限|仅能|只支持|只可|只含|仅含|由|须为|应为|限于)[^。；;]{0,12}(?:字母|英文)[^。；;]{0,10}(?:数字|阿拉伯数字)/i;
const NO_SYM_COMPOSED =
  /(?:字母或数字|字母[、,，与和或\s]*数字\s*(?:组成|构成)|字母数字|letters\s+and\s+numbers\s+only)/i;
const SYMBOLS_WELCOME = /(?:或|和|包含|包括|支持|可用|允许)[^。；;]{0,8}特殊[字符符号]|特殊[字符符号][^。；;]{0,8}(?:可选|可用)/;
const REQUIRE_SYMBOLS =
  /(?:必须|需|应|至少)[^。；;]{0,10}特殊[字符符号]|special\s+character\s+(?:is\s+)?(?:required|must)/i;

function hintFromText(text: string): { min?: number; max?: number; symbolsAllowed?: boolean; symbolsRequired?: boolean; why: string[] } {
  const out: { min?: number; max?: number; symbolsAllowed?: boolean; symbolsRequired?: boolean; why: string[] } = { why: [] };
  if (!text) return out;

  const range = text.match(LEN_RANGE);
  if (range) {
    const lo = parseInt(range[1]!, 10);
    const hi = parseInt(range[2]!, 10);
    if (lo >= 4 && lo <= 64 && hi >= lo && hi <= 64) {
      out.min = lo;
      out.max = hi;
      out.why.push(`提示文字「${range[0]}」`);
    }
  }
  for (const re of LEN_MIN) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n >= 4 && n <= 64 && (out.min === undefined || n > out.min)) { out.min = n; out.why.push(`提示文字「${m[0]}」`); }
      break;
    }
  }
  for (const re of LEN_MAX) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n >= 4 && n <= 64 && (out.max === undefined || n < out.max)) { out.max = n; out.why.push(`提示文字「${m[0]}」`); }
      break;
    }
  }

  if (REQUIRE_SYMBOLS.test(text)) {
    out.symbolsAllowed = true;
    out.symbolsRequired = true;
    out.why.push('提示文字要求特殊字符');
  } else if (
    (NO_SYM_EXPLICIT.test(text) || NO_SYM_LIMITED.test(text) || NO_SYM_COMPOSED.test(text)) &&
    !SYMBOLS_WELCOME.test(text)
  ) {
    out.symbolsAllowed = false;
    out.why.push('提示文字限定字母/数字');
  }
  return out;
}

/** 采集密码框附近的提示文字（placeholder / title / aria-describedby / label / 最近容器） */
export function collectRuleContext(input: HTMLInputElement | undefined | null): string {
  if (!input) return '';
  const bits: string[] = [];
  const push = (s?: string | null) => { const t = (s ?? '').trim(); if (t) bits.push(t); };
  push(input.getAttribute('placeholder'));
  push(input.getAttribute('title'));
  push(input.getAttribute('aria-label'));
  const descIds = input.getAttribute('aria-describedby') ?? '';
  for (const id of descIds.split(/\s+/).filter(Boolean)) {
    push(input.ownerDocument?.getElementById(id)?.textContent);
  }
  const labels = (input as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels)) push(l.textContent);

  // 向上找第一个「文本量适中」的容器：避免把整页文案（含验证码位数等）都算进来
  let node: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 3 && node; i++) {
    const t = ((node as HTMLElement & { innerText?: string }).innerText ?? node.textContent ?? '').trim();
    if (t && t.length <= 400) { push(t); break; }
    node = node.parentElement;
  }
  return Array.from(new Set(bits)).join('  ').slice(0, 600);
}

// ---------------------------------------------------------------- 主入口

export function detectPasswordRule(
  input: HTMLInputElement | undefined | null,
  opts: { scopeText?: string } = {},
): SiteRule {
  const sources: string[] = [];
  let minLength: number | undefined;
  let maxLength: number | undefined;
  let symbolsAllowed: boolean | undefined;
  let symbolsRequired: boolean | undefined;

  if (!input) return { note: '', sources };

  // 1. ★★★ DOM 属性：浏览器强制，最可信
  if (input.maxLength > 0 && input.maxLength < 100) {
    maxLength = input.maxLength;
    sources.push(`maxlength=${maxLength}`);
  }
  if (input.minLength > 0 && input.minLength < 100) {
    minLength = input.minLength;
    sources.push(`minlength=${minLength}`);
  }

  // 2. ★★★ pattern 正则
  const pattern = input.getAttribute('pattern');
  if (pattern) {
    sources.push(`pattern="${pattern}"`);
    const sym = patternAllowsSymbols(pattern);
    if (sym.allow !== undefined) symbolsAllowed = sym.allow;
    if (sym.require) symbolsRequired = true;
    const range = patternLengthRange(pattern);
    if (range.min !== undefined && (minLength === undefined || range.min > minLength)) minLength = range.min;
    if (range.max !== undefined && (maxLength === undefined || range.max < maxLength)) maxLength = range.max;
  }

  // 3. ★★ 提示文字：国内站点常写作「6~30位字母或数字」，只写在页面文案里
  const text = opts.scopeText ?? collectRuleContext(input);
  const hint = hintFromText(text);
  if (hint.min !== undefined && (minLength === undefined || hint.min > minLength)) minLength = hint.min;
  if (hint.max !== undefined && (maxLength === undefined || hint.max < maxLength)) maxLength = hint.max;
  if (symbolsAllowed === undefined && hint.symbolsAllowed !== undefined) symbolsAllowed = hint.symbolsAllowed;
  if (hint.symbolsRequired) symbolsRequired = true;
  sources.push(...hint.why);

  // 范围自洽：min 不能超过 max
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    minLength = undefined;
    sources.push('(冲突的长度提示已忽略)');
  }

  const parts: string[] = [];
  if (minLength !== undefined && maxLength !== undefined) parts.push(`${minLength}-${maxLength}位`);
  else if (maxLength !== undefined) parts.push(`最多${maxLength}位`);
  else if (minLength !== undefined) parts.push(`至少${minLength}位`);
  if (symbolsRequired) parts.push('须含符号');
  else if (symbolsAllowed === false) parts.push('不含符号');
  else if (symbolsAllowed === true) parts.push('可含符号');

  return { minLength, maxLength, symbolsAllowed, symbolsRequired, note: parts.join(' · '), sources };
}

/** 把规则套在生成参数上：默认 20 位带符号，被规则夹住后取规则内最长 */
export function applyRuleToGenOpts(
  rule: SiteRule,
  opts: { length?: number; symbols?: boolean } = {},
): GenParams {
  let length = opts.length ?? 20;
  if (rule.maxLength !== undefined && length > rule.maxLength) length = rule.maxLength;
  if (rule.minLength !== undefined && length < rule.minLength) length = rule.minLength;
  length = Math.max(4, Math.min(64, length));
  let symbols = opts.symbols ?? true;
  if (rule.symbolsAllowed === false) symbols = false;
  if (rule.symbolsRequired) symbols = true;
  return { length, symbols };
}

/** 生成结果自检 / 填充后被站点改写时的判定：返回不合规则的原因，合规返回 null */
export function validateAgainstRule(password: string, rule: SiteRule): string | null {
  if (rule.minLength !== undefined && password.length < rule.minLength) return `密码至少 ${rule.minLength} 位`;
  if (rule.maxLength !== undefined && password.length > rule.maxLength) return `密码最多 ${rule.maxLength} 位`;
  const hasSymbol = /[^a-zA-Z0-9]/.test(password);
  if (rule.symbolsAllowed === false && hasSymbol) return '本站不允许特殊字符';
  if (rule.symbolsRequired && !hasSymbol) return '本站要求包含特殊字符';
  return null;
}
