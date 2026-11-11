/**
 * 条目「名字」的展示与判定。
 *
 * 为什么需要它：v2 的 head 里 title 可能是空的，也可能在早期版本里被直接写成了域名
 * （保存时站点识别失败就会这样）。列表里把域名当名字显示，用户根本认不出这是哪个网站。
 *
 * 规则：
 *  - title 看起来是真实名字（中文、品牌名等）→ 直接用；
 *  - title 是域名 / URL，或者为空 → 用域名主体首字母大写兜底（example.com → Example）；
 *  - 名字只用于「显示」，不改数据；真正的名字由自动识别（后台打开列表 / 保存后）写回 title。
 */

const HOST_LIKE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i;
// 通用错误页/登录页标题：不能当名字，否则列表里会出现「404 Not Found」
const JUNK_TITLE = /^(?:4\d\d|5\d\d|error|not\s*found|forbidden|access\s*denied|unauthorized|just\s*a\s*moment|attention\s*required|sign\s*in|log\s*in|login|loading|redirecting|页面不存在|页面未找到|访问受限|请登录|登录|错误)/i;

/** 从 URL（或裸域名）取 host，去掉 www. */
export function hostOfUrl(url: string | undefined): string {
  const raw = (url ?? '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
    return new URL(withScheme).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// 常见「二级后缀」的第二段：co.uk / com.cn / gov.cn / ac.jp ……
const SECOND_LEVEL = new Set(['com', 'org', 'net', 'gov', 'edu', 'co', 'ac']);

/**
 * 取可注册域（用于展示）：ai.example.com → example.com，mail.qq.com → qq.com。
 * 纯 IP 返回空串（没有「名字」可提取）。
 */
export function registrableDomain(host: string): string {
  const clean = (host || '').replace(/^www\./i, '').trim();
  if (!clean) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) return '';
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  const tld = (parts[parts.length - 1] ?? '').toLowerCase();
  const second = (parts[parts.length - 2] ?? '').toLowerCase();
  // 只有 ccTLD（两位）才可能是 co.uk / com.cn 这种两段后缀；.com 的子域不能取三段
  if (tld.length === 2 && SECOND_LEVEL.has(second)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** 域名主体当名字：ai.example.com → Example；qq.com → QQ */
export function prettyDomain(host: string): string {
  const root = registrableDomain(host);
  const base = root.split('.')[0] || '';
  if (!base) return '';
  return base.length <= 3 ? base.toUpperCase() : base.charAt(0).toUpperCase() + base.slice(1);
}

/** title 是否只是「域名/URL」，即并不是真正的名字 */
export function isHostLikeTitle(title: string | undefined): boolean {
  const t = (title ?? '').trim();
  if (!t) return true;
  return HOST_LIKE.test(t) || /^https?:\/\//i.test(t) || JUNK_TITLE.test(t);
}

/** 条目在 UI 里显示的名字 */
export function displaySiteName(title: string | undefined, urls: string[] | undefined): string {
  const t = (title ?? '').trim();
  if (t && !isHostLikeTitle(t)) return t;
  const host = hostOfUrl((urls ?? [])[0]);
  const pretty = prettyDomain(host);
  if (pretty) return pretty;
  return t || '未命名';
}

/** 复制到剪贴板的内容：账号一行、密码一行；缺一项就只复制另一项。 */
export function formatCredentialCopy(username: string, password: string): string {
  const u = (username ?? '').trim();
  const p = password ?? '';
  if (u && p) return u + '\n' + p;
  return u || p;
}
