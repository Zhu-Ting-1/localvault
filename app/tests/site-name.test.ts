/**
 * 条目「名字」与「复制内容」的回归测试。
 *
 * 两条产品约束：
 *  1. 名字不能是域名/URL（否则列表里全是 ai.example.com 这种，认不出是什么网站）；
 *  2. 复制必须「账号一行、密码一行」，不能粘成一串。
 */
import { describe, it, expect } from 'vitest';
import {
  displaySiteName,
  formatCredentialCopy,
  isHostLikeTitle,
  prettyDomain,
  hostOfUrl,
} from '../src/lib/site-name';

describe('站点名显示', () => {
  it('中文/品牌名原样显示', () => {
    expect(displaySiteName('GitHub 代码托管', ['https://github.com/login'])).toBe('GitHub 代码托管');
  });

  it('名字就是域名时退化成域名主体首字母大写', () => {
    expect(displaySiteName('ai.example.com', ['https://ai.example.com/login'])).toBe('Example');
    expect(displaySiteName('www.wikipedia.org', ['https://www.wikipedia.org/signin'])).toBe('Wikipedia');
  });

  it('名字为空时用 URL 兜底', () => {
    expect(displaySiteName('', ['https://mail.qq.com/'])).toBe('QQ');
    expect(displaySiteName(undefined, [])).toBe('未命名');
  });

  it('URL 形式的标题也算没有名字', () => {
    expect(displaySiteName('https://www.wikipedia.org/signin', ['https://www.wikipedia.org/signin'])).toBe('Wikipedia');
  });

  it('通用错误页标题不算名字（避免出现「404 Not Found」）', () => {
    expect(isHostLikeTitle('404 Not Found')).toBe(true);
    expect(isHostLikeTitle('Just a moment...')).toBe(true);
    expect(isHostLikeTitle('登录')).toBe(true);
    // 正常名字不受影响
    expect(isHostLikeTitle('招商银行')).toBe(false);
    expect(isHostLikeTitle('GitHub 代码托管')).toBe(false);
  });

  it('host 解析与域名美化', () => {
    expect(hostOfUrl('https://www.wikipedia.org/signin?x=1')).toBe('wikipedia.org');
    expect(hostOfUrl('wikipedia.org')).toBe('wikipedia.org');
    expect(hostOfUrl('')).toBe('');
    expect(prettyDomain('ai.example.com')).toBe('Example');
    expect(prettyDomain('mail.qq.com')).toBe('QQ');
    expect(prettyDomain('192.168.1.10')).toBe('');
  });
});

describe('复制内容', () => {
  it('账号和密码都在：两行，账号在前', () => {
    expect(formatCredentialCopy('user@example.com', 'P@ssw0rd')).toBe('user@example.com\nP@ssw0rd');
  });

  it('只有账号 / 只有密码时只复制存在的那个', () => {
    expect(formatCredentialCopy('user@example.com', '')).toBe('user@example.com');
    expect(formatCredentialCopy('', 'P@ssw0rd')).toBe('P@ssw0rd');
  });

  it('都没有时返回空串（调用方提示「没有账号和密码」）', () => {
    expect(formatCredentialCopy('', '')).toBe('');
    expect(formatCredentialCopy('   ', '')).toBe('');
  });

  it('账号两端空格会被去掉，不会产生空行', () => {
    expect(formatCredentialCopy('  user@example.com  ', 'pw')).toBe('user@example.com\npw');
  });
});
