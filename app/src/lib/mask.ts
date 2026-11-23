/**
 * 常用身份的打码展示（手机号 / 邮箱 / 其他账号）。
 *
 * 只作用于**显示层**：存储与填充仍使用完整值——否则既认不出是哪个账号，
 * 也无法填进注册表单。目标是「别人瞥一眼看不到完整信息，你自己仍能区分」。
 *
 * 规则（保留可识别的前后片段，中间以 * 代替）：
 *   手机  138 0000 0000       → 138****0000   （前 3 后 4）
 *   邮箱  octocat@example.com  → oc***t@example.com（本地部分保留首尾，域名保留）
 *   其他  zhangsan             → z***n
 */

export type IdentityKind = 'phone' | 'email' | 'generic';

/** 已打码特征：出现这些符号就不再处理（保证幂等，重复调用不会越打越花） */
const ALREADY_MASKED = /[*＊·•]/;

export function identityKind(value: string): IdentityKind {
  const v = (value ?? '').trim();
  if (!v) return 'generic';
  if (v.includes('@')) return 'email';
  // 去掉常见分隔符后全是数字，且长度像电话号码
  const digits = v.replace(/[\s\-()]/g, '');
  if (/^\+?\d{5,15}$/.test(digits)) return 'phone';
  return 'generic';
}

/** 手机号：11 位 → 132****2398；国际号码保留 + 与更多 * */
function maskPhone(raw: string): string {
  const plus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  const n = digits.length;
  if (n === 0) return '';
  if (n <= 4) return '*'.repeat(n);
  if (n <= 7) return digits.slice(0, 2) + '*'.repeat(Math.max(1, n - 3)) + digits.slice(-1);
  const head = digits.slice(0, 3);
  const tail = digits.slice(-4);
  const stars = Math.min(6, Math.max(2, n - 7));
  return (plus ? '+' : '') + head + '*'.repeat(stars) + tail;
}

/** 邮箱：本地部分前 2 后 1，域名保留（域名是公开信息，保留才好辨认） */
function maskEmail(raw: string): string {
  const v = raw.trim();
  const at = v.lastIndexOf('@');
  if (at <= 0) return maskGeneric(v);
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  let head: string;
  if (local.length >= 8) head = local.slice(0, 2) + '***' + local.slice(-2);
  else if (local.length >= 6) head = local.slice(0, 2) + '***' + local.slice(-1);
  else if (local.length >= 4) head = local.slice(0, 1) + '***' + local.slice(-1);
  else if (local.length >= 2) head = local.slice(0, 1) + '***';
  else head = '***';
  return head + '@' + domain;
}

/** 其他账号（用户名 / 昵称等）：按长度保留首尾 */
function maskGeneric(raw: string): string {
  const v = raw.trim();
  const n = v.length;
  if (n === 0) return '';
  if (n <= 2) return '*'.repeat(n);
  if (n <= 4) return v.slice(0, 1) + '*'.repeat(n - 2) + v.slice(-1);
  if (n <= 8) return v.slice(0, 1) + '***' + v.slice(-1);
  return v.slice(0, 2) + '***' + v.slice(-2);
}

/** 把任意身份值转成可安全展示的打码形式；空值与已打码值原样返回 */
export function maskValue(value: string): string {
  const v = (value ?? '').trim();
  if (!v) return '';
  if (ALREADY_MASKED.test(v)) return v;
  switch (identityKind(v)) {
    case 'email':
      return maskEmail(v);
    case 'phone':
      return maskPhone(v);
    default:
      return maskGeneric(v);
  }
}

/** 打码后是否仍足以区分（同类型两个身份打码结果相同时，调用方可提示用户改名） */
export function maskCollides(list: string[]): boolean {
  const seen = new Set<string>();
  for (const v of list) {
    const m = maskValue(v);
    if (!v) continue;
    if (seen.has(m)) return true;
    seen.add(m);
  }
  return false;
}
