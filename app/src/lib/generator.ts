/** 密码生成器：CSPRNG，默认 20 位，含大小写数字与安全符号，排除易混淆字符 */
const SETS = {
  lower: 'abcdefghijkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+?',
};

export interface GenOptions {
  length?: number;
  symbols?: boolean;
}

/** 无偏随机整数 [0, max)：拒绝采样，避免 `%` 带来的取模偏差 */
function randInt(max: number): number {
  if (max <= 0) return 0;
  const limit = Math.floor(0x100000000 / max) * max; // max 能整除的最大区间
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) return v % max;
  }
}

export function generatePassword(opts: GenOptions = {}): string {
  // 下限 4（= 保证每类至少一个所需的长度）：站点 maxlength 可能只有 6 位，
  // 若写死 8 会被浏览器截断成 6 位，导致填进去的密码与将要保存的密码不一致。
  const length = Math.max(4, Math.min(64, opts.length ?? 20));
  const alphabet =
    SETS.lower + SETS.upper + SETS.digits + (opts.symbols === false ? '' : SETS.symbols);
  // 每一位都来自 CSPRNG（含「每类至少一个」这几位）
  const pick = (set: string) => set[randInt(set.length)] ?? set[0]!;
  const must = [pick(SETS.lower), pick(SETS.upper), pick(SETS.digits), ...(opts.symbols === false ? [] : [pick(SETS.symbols)])];
  const rest: string[] = [];
  for (let i = must.length; i < length; i++) rest.push(alphabet[randInt(alphabet.length)] ?? alphabet[0]!);
  // Fisher-Yates 打乱（同样用 CSPRNG，索引无偏）
  const all = [...must, ...rest];
  for (let i = all.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const tmp = all[i]!;
    all[i] = all[j]!;
    all[j] = tmp;
  }
  return all.join('');
}

export function passwordStrength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let score = 0;
  if (p.length >= 8) score++;
  if (p.length >= 14) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p) && /[^a-zA-Z0-9]/.test(p)) score++;
  const LABELS = ['太短', '弱', '一般', '强', '很强'] as const;
  return {
    score: score as 0 | 1 | 2 | 3 | 4,
    label: LABELS[score] ?? '弱',
  };
}