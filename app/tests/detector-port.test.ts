/**
 * detector.js 的回归测试：用 16 个固定测试页，保证识别行为不随改动漂移。
 * 测试页在 app/tests/fixtures/detector/，也可以用 `npm run fixtures` 在浏览器里逐个点。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { detectDocument } from '../src/lib/detector.js';

const here = dirname(fileURLToPath(import.meta.url));
// fixture 与测试放在一起：app/tests/fixtures/detector/
const fixtures = join(here, 'fixtures', 'detector');

function load(name: string): { dom: JSDOM; detect: () => ReturnType<typeof detectDocument> } {
  const html = readFileSync(join(fixtures, name), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://fixture.local/' + name,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  (dom.window as unknown as Record<string, unknown>).__LV_NO_LAYOUT__ = true;
  return { dom, detect: () => detectDocument(dom.window.document, dom.window as unknown as Window) };
}

function oneForm(name: string, type: string, user: string | null, pwdCount: number) {
  const { dom, detect } = load(name);
  const result = detect();
  expect(result.forms, name + ' 表单数').toHaveLength(1);
  const form = result.forms[0]!;
  expect(form.type).toBe(type);
  if (user === null) {
    expect(form.username).toBeFalsy();
  } else {
    expect(form.username?.name ?? form.username?.id).toBe(user);
  }
  const fillable = form.passwords.filter((p: { fillable: boolean }) => p.fillable);
  expect(fillable).toHaveLength(pwdCount);
  dom.window.close();
  return form;
}

describe('识别器回归（17 个固定测试页）', () => {
  it('经典登录表单', () => oneForm('classic.html', 'login', 'username', 1));
  it('Xmind：账号密码 + 验证码登录标签 + 页尾订阅表单', () => oneForm('xmind.html', 'login', 'account', 1));
  it('登录页带免费注册链接（淘宝/12306 修复回归）', () => oneForm('signup-link.html', 'login', 'fm-login-id', 1));
  it('React 受控组件', () => oneForm('react.html', 'login', 'email', 1));
  it('Vue 表单', () => oneForm('vue.html', 'login', 'account', 1));
  it('open Shadow DOM', () => {
    const f = oneForm('shadow.html', 'login', 'username', 1);
    expect(f.password?.selector).toContain('shadow-pass');
  });
  it('注册表单（双密码框）', () => oneForm('signup.html', 'signup', 'email', 2));
  it('改密表单（三密码框）', () => oneForm('change.html', 'change', null, 3));
  it('隐藏密码框不可填充', () => {
    const { dom, detect } = load('hidden.html');
    const r = detect();
    expect(r.forms).toHaveLength(0);
    expect(r.stats.hiddenPasswords).toBe(1);
    dom.window.close();
  });
  it('蜜罐排除', () => {
    const { dom, detect } = load('honeypot.html');
    const r = detect();
    expect(r.forms).toHaveLength(1);
    expect(r.stats.honeypots).toBeGreaterThanOrEqual(1);
    dom.window.close();
  });
  it('两个表单选可见的', () => {
    const { dom, detect } = load('two-forms.html');
    const r = detect();
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0]!.container).toBe('#visible-form');
    dom.window.close();
  });
  it('无密码框零误报', () => {
    const { dom, detect } = load('no-password.html');
    expect(detect().forms).toHaveLength(0);
    dom.window.close();
  });
  it('禁用密码框不产生可填充表单', () => {
    const { dom, detect } = load('disabled.html');
    expect(detect().forms).toHaveLength(0);
    dom.window.close();
  });
  it('仅密码框（两步登录）', () => oneForm('usernameless.html', 'login', null, 1));
  it('延迟插入后可识别', () => {
    const { dom, detect } = load('late.html');
    expect(detect().forms).toHaveLength(0);
    dom.window.document.getElementById('show')!.click();
    expect(detect().forms).toHaveLength(1);
    dom.window.close();
  });
  it('SPA 切换后可识别', () => {
    const { dom, detect } = load('spa.html');
    expect(detect().forms).toHaveLength(0);
    dom.window.document.getElementById('go')!.click();
    expect(detect().forms).toHaveLength(1);
    dom.window.close();
  });
  it('iframe 子页面独立识别', () => oneForm('iframe-child.html', 'login', 'username', 1));
});

// ---------- 短信/邮箱验证码登录（无密码框）----------

function detectHtml(html: string) {
  const dom = new JSDOM(`<body>${html}</body>`, {
    url: 'https://fixture.local/otp',
    pretendToBeVisual: true,
  });
  (dom.window as unknown as Record<string, unknown>).__LV_NO_LAYOUT__ = true;
  const result = detectDocument(dom.window.document, dom.window as unknown as Window);
  dom.window.close();
  return result;
}

describe('验证码登录识别（无密码框）', () => {
  it('手机号 + 短信验证码 + 获取验证码按钮 → otp', () => {
    const r = detectHtml(`<form>
      <input type="tel" placeholder="请输入手机号">
      <input type="text" placeholder="短信验证码" maxlength="6">
      <button type="button">获取验证码</button>
      <button type="submit">登录</button>
    </form>`);
    expect(r.forms).toHaveLength(1);
    const f = r.forms[0]!;
    expect(f.type).toBe('otp');
    expect(f.username?.placeholder).toContain('手机号');
    expect(f.password).toBeNull();
    expect(f.otp?.placeholder).toContain('验证码');
  });

  it('邮箱 + 验证码 → otp', () => {
    const r = detectHtml(`<div class="box">
      <input type="email" placeholder="邮箱地址">
      <input type="text" placeholder="邮箱验证码" maxlength="6">
      <a class="btn">获取验证码</a>
    </div>`);
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0]!.type).toBe('otp');
    expect(r.forms[0]!.username?.type).toBe('email');
  });

  it('没有账号框时不算验证码登录', () => {
    const r = detectHtml(`<form>
      <input type="text" placeholder="短信验证码" maxlength="6">
      <button>登录</button>
    </form>`);
    expect(r.forms).toHaveLength(0);
  });

  it('优惠码 / 邮编等弱信号不误报', () => {
    const r = detectHtml(`<form>
      <input type="tel" placeholder="手机号">
      <input name="promo" placeholder="优惠码" maxlength="6">
      <input name="postcode" placeholder="邮编" maxlength="6">
      <button>提交</button>
    </form>`);
    expect(r.forms).toHaveLength(0);
  });

  it('密码登录表单仍按 login 识别，不额外产出 otp', () => {
    const r = detectHtml(`<form>
      <input name="username" placeholder="手机号">
      <input type="password" name="password">
      <button>登录</button>
    </form>`);
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0]!.type).toBe('login');
  });

  it('注册页（密码 + 确认密码 + 验证码）只出 signup，不重复出 otp', () => {
    const r = detectHtml(`<form>
      <input name="phone" placeholder="手机号">
      <input type="text" placeholder="短信验证码" maxlength="6">
      <input type="password" name="password">
      <input type="password" name="confirm">
      <button>立即注册</button>
    </form>`);
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0]!.type).toBe('signup');
  });
});

// ---------- 账号先行（email-first）：第一屏只有账号框 ----------

describe('账号先行登录识别（密码在下一屏）', () => {
  it('fixture：邮箱 + 下一步 → username-only（隐藏的密码在另一个表单里）', () => {
    const { dom, detect } = load('email-first.html');
    const r = detect();
    expect(r.forms).toHaveLength(1);
    const f = r.forms[0]!;
    expect(f.type).toBe('username-only');
    expect(f.username?.name ?? f.username?.id).toBe('loginfmt');
    expect(f.password).toBeNull();
    dom.window.close();
  });

  it('中文站：手机号 + 继续', () => {
    const r = detectHtml(`<form>
      <input name="account" placeholder="请输入手机号/邮箱">
      <button type="submit">继续</button>
    </form>`);
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0]!.type).toBe('username-only');
  });

  it('搜索框不误报（type=search + 搜索按钮）', () => {
    const r = detectHtml(`<form>
      <input type="search" name="q" placeholder="输入关键词">
      <button type="submit">搜索</button>
    </form>`);
    expect(r.forms).toHaveLength(0);
  });

  it('邮箱 + 订阅按钮不算登录（无账号/下一步语义）', () => {
    const r = detectHtml(`<form>
      <label>订阅更新</label>
      <input type="email" name="email" placeholder="你的邮箱">
      <button type="submit">订阅</button>
    </form>`);
    expect(r.forms).toHaveLength(0);
  });

  it('账号 + 密码同容器时仍是 login，不额外产出 username-only', () => {
    const r = detectHtml(`<form>
      <input name="email" placeholder="邮箱">
      <input type="password" name="pw">
      <button>登录</button>
    </form>`);
    expect(r.forms).toHaveLength(1);
    expect(r.forms[0]!.type).toBe('login');
  });

  it('隐藏密码框的容器不被当成账号先行（hidden.html 回归）', () => {
    const { dom, detect } = load('hidden.html');
    expect(detect().forms).toHaveLength(0);
    dom.window.close();
  });
});
