/*
 * LocalVault form detector (MVP).
 * Pure DOM logic: no chrome.* APIs, no network. Runs inside the content script
 * (isolated world) and can also be required from Node + jsdom for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LVDetector = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 中文按钮常把字间加空格（「登 录」「注 册」），所以关键词都允许字间空白。
  var USER_HINT = /(user|email|login|account|phone|mobile|uid|uname|用户名|邮箱|账号|手机)/i;
  var USER_BAD = /(search|query|keyword|coupon|promo|otp|code|验证码|搜索)/i;
  var SIGNUP_HINT = /(sign\s*up|signup|register|create\s*(an\s*)?account|join|注\s*册|创建账号|创建账户|新用户)/i;
  var CHANGE_HINT = /(change\s*password|update\s*password|current\s*password|修改密码|更改密码|更新密码|原密码|旧密码|修\s*改\s*密\s*码)/i;
  var LOGIN_HINT = /(sign\s*in|log\s*in|login|登\s*录|登\s*入)/i;

  function winOf(el) {
    return el && el.ownerDocument ? el.ownerDocument.defaultView : null;
  }

  function textOf(el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
  }

  function isOffscreen(el, win) {
    var style = el.style || {};
    if (style.position === 'absolute' || style.position === 'fixed') {
      var left = parseFloat(style.left || '0');
      var top = parseFloat(style.top || '0');
      if (left <= -1000 || top <= -1000) return true;
    }
    if (win && !win.__LV_NO_LAYOUT__ && el.getBoundingClientRect) {
      var r = el.getBoundingClientRect();
      if (r.right < 0 || r.bottom < 0) return true;
    }
    return false;
  }

  function isVisible(el, win) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest && el.closest('[aria-hidden="true"]')) return false;
    if (el.tagName === 'INPUT' && el.type === 'hidden') return false;

    // 祖先链上的 display:none / visibility:hidden / aria-hidden 也要排除。
    // 浏览器里可以用布局判断，但 jsdom 没有布局，必须显式检查。
    var p = el;
    while (p && p.nodeType === 1) {
      if (p.hidden) return false;
      if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return false;
      var ps = p.style;
      if (ps && (ps.display === 'none' || ps.visibility === 'hidden')) return false;
      p = p.parentElement;
    }

    var cs = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
    if (cs) {
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
    }
    var style = el.style || {};
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity !== '' && parseFloat(style.opacity) === 0) return false;

    if (win && win.__LV_NO_LAYOUT__) return !isOffscreen(el, win);
    if (el.getClientRects && el.getClientRects().length === 0) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    return !isOffscreen(el, win);
  }

  function looksLikeHoneypot(el, win) {
    var sig = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.className || '')).toLowerCase();
    if (/(honeypot|hp_password|trap|decoy|dummy|fake)/.test(sig)) return true;
    if (isOffscreen(el, win)) return true;
    return false;
  }

  function labelText(el) {
    if (el.labels && el.labels.length) {
      var parts = [];
      for (var i = 0; i < el.labels.length; i++) parts.push(textOf(el.labels[i]));
      return parts.join(' ');
    }
    if (el.id) {
      var doc = el.ownerDocument;
      var label = doc.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
      if (label) return textOf(label);
    }
    var parent = el.closest ? el.closest('label') : null;
    return parent ? textOf(parent) : '';
  }

  function cssPath(el) {
    if (!el) return '';
    if (el.id) return '#' + el.id;
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      var part = node.tagName.toLowerCase();
      if (node.name) part += '[name="' + String(node.name).replace(/"/g, '\\"') + '"]';
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function collectRoots(doc) {
    var roots = [];
    var seen = new Set();
    function add(root) {
      if (!root || seen.has(root)) return;
      seen.add(root);
      roots.push(root);
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) add(all[i].shadowRoot);
      }
    }
    add(doc);
    return roots;
  }

  function fieldInfo(el, win) {
    var type = (el.getAttribute('type') || el.type || 'text').toLowerCase();
    var visible = isVisible(el, win);
    var honeypot = looksLikeHoneypot(el, win);
    var info = {
      selector: cssPath(el),
      name: el.name || '',
      id: el.id || '',
      type: type,
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      placeholder: el.getAttribute('placeholder') || '',
      label: labelText(el),
      visible: visible,
      honeypot: honeypot,
      disabled: !!el.disabled,
      readOnly: !!el.readOnly,
      fillable: visible && !el.disabled && !el.readOnly && !honeypot,
    };
    try {
      Object.defineProperty(info, '_el', { value: el, enumerable: false });
    } catch (e) {
      // ignore
    }
    return info;
  }

  function containerFor(el) {
    if (el.form) return el.form;
    var form = el.closest ? el.closest('form') : null;
    if (form) return form;
    var parent = el.parentElement;
    while (parent && parent !== el.ownerDocument.body) {
      if (parent.querySelectorAll && parent.querySelectorAll('input').length >= 2) return parent;
      parent = parent.parentElement;
    }
    return el.parentElement;
  }

  function isBefore(a, b) {
    // DOM 常量：DOCUMENT_POSITION_FOLLOWING = 4；不要依赖全局 Node（jsdom 里没有全局 Node）。
    return !!(a.compareDocumentPosition(b) & 4);
  }

  function findUsername(passwordEl, container, win) {
    if (!container || !container.querySelectorAll) return null;
    var inputs = container.querySelectorAll('input');
    var best = null;
    var bestScore = 0;
    var candidates = 0;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var type = (el.getAttribute('type') || el.type || 'text').toLowerCase();
      if (['text', 'email', 'tel', 'number'].indexOf(type) < 0) continue;
      if (!isVisible(el, win) || el.disabled || el.readOnly || looksLikeHoneypot(el, win)) continue;
      candidates += 1;

      var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      var hint = [
        el.name || '',
        el.id || '',
        el.getAttribute('placeholder') || '',
        labelText(el),
        el.getAttribute('aria-label') || '',
      ].join(' ').toLowerCase();

      var score = 0;
      if (ac.indexOf('username') >= 0 || ac.indexOf('email') >= 0) score += 6;
      if (type === 'email') score += 3;
      if (type === 'tel') score += 1;
      if (USER_HINT.test(hint)) score += 3;
      if (USER_BAD.test(hint)) score -= 4;
      if (isBefore(el, passwordEl)) score += 2;
      if (el.form && passwordEl.form && el.form === passwordEl.form) score += 1;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (bestScore >= 3) return best;
    // 兜底：容器里**只有一个**候选文本框、且它就在密码框上方 → 基本只能是账号框。
    // 现实里像搜狐这类站，账号框既没有 name 也没 placeholder，只靠「在密码框之前」
    // 拿到 2 分；差这一分就会出现「密码填了、账号没填」——比不填更坑用户。
    if (bestScore >= 2 && candidates === 1 && best && isBefore(best, passwordEl)) return best;
    return null;
  }

  // ---- 短信/邮箱验证码登录（无密码框）：账号框 + 验证码框配对 ----
  // 与密码表单互不干扰：这条路径只在「没有密码框可填」的容器里生效。

  var SEARCH_HINT = /(search|query|keyword|关键字|搜\s*索|sousuo)/i;
  var OTP_HINT = /(验证码|校验码|动态码|短信码|otp|vcode|smscode|sms.?code|one.?time|captcha|verify.?code)/i;
  var ACCOUNT_HINT = /(手机|邮箱|账号|帐号|账户|email|e-mail|phone|mobile|tel|user)/i;
  var OTP_SEND_HINT = /(获取验证码|发送验证码|获取动态码|获取短信|重新获取|发送短信|send\s*code|get\s*code|resend)/i;

  function hintOf(el) {
    return [
      el.name || '', el.id || '', el.getAttribute('placeholder') || '',
      labelText(el), el.getAttribute('aria-label') || '',
      el.getAttribute('autocomplete') || '',
    ].join(' ').toLowerCase();
  }

  function isOtpLike(el, win, hasSendBtn) {
    var type = (el.getAttribute('type') || el.type || 'text').toLowerCase();
    if (['password', 'hidden', 'checkbox', 'radio', 'submit', 'button'].indexOf(type) >= 0) return false;
    if (!isVisible(el, win) || el.disabled || el.readOnly || looksLikeHoneypot(el, win)) return false;
    var max = parseInt(el.getAttribute('maxlength') || '0', 10);
    if (max > 0 && (max < 4 || max > 8)) return false; // 验证码通常 4-8 位
    if (OTP_HINT.test(hintOf(el))) return true;
    // 弱 hint（如英文站只写 "Code"）：容器里有「获取验证码」类按钮时也认可
    return !!hasSendBtn && !SEARCH_HINT.test(hintOf(el));
  }

  function findAccountInput(codeEl, container, win) {
    if (!container || !container.querySelectorAll) return null;
    var inputs = container.querySelectorAll('input');
    var best = null;
    var bestScore = 0;
    var textInputs = 0; // 容器内可见文本框总数（含验证码框自身候选外的）
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var t0 = (el.getAttribute('type') || el.type || 'text').toLowerCase();
      if (['text', 'email', 'tel', 'number'].indexOf(t0) >= 0 && isVisible(el, win)) textInputs++;
    }
    for (var j = 0; j < inputs.length; j++) {
      var el2 = inputs[j];
      if (el2 === codeEl) continue;
      var type = (el2.getAttribute('type') || el2.type || 'text').toLowerCase();
      if (['text', 'email', 'tel', 'number'].indexOf(type) < 0) continue;
      if (!isVisible(el2, win) || el2.disabled || el2.readOnly || looksLikeHoneypot(el2, win)) continue;
      if (isOtpLike(el2, win)) continue; // 别把另一个验证码框当账号
      var hint = hintOf(el2);
      var score = 0;
      if (ACCOUNT_HINT.test(hint)) score += 3;
      if (type === 'tel' || type === 'email') score += 3;
      if (/username|email|tel/.test((el2.getAttribute('autocomplete') || '').toLowerCase())) score += 2;
      if (isBefore(el2, codeEl)) score += 2;
      // 容器里除了验证码框就只有这一个文本框：位置就算反着也大概率是账号框
      if (textInputs <= 2 && !SEARCH_HINT.test(hint)) score += 2;
      if (score > bestScore) { bestScore = score; best = el2; }
    }
    return bestScore >= 3 ? best : null;
  }

  function detectOtpForms(doc, win, roots, takenContainers) {
    var out = [];
    for (var r = 0; r < roots.length; r++) {
      var inputs = roots[r].querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        var codeEl = inputs[i];
        // 先粗判：容器文本里有「获取验证码」类按钮 → 放宽框本身的 hint 要求（英文站常只写 Code）
        var container0 = containerFor(codeEl);
        var sendHint = container0
          ? OTP_SEND_HINT.test(String(container0.textContent || '').slice(0, 400)) : false;
        if (!isOtpLike(codeEl, win, sendHint)) continue;
        var container = containerFor(codeEl);
        if (!container || takenContainers.has(container)) continue;
        var accountEl = findAccountInput(codeEl, container, win);
        if (!accountEl) continue;
        var text = String(container.innerText || container.textContent || '').slice(0, 400);
        var sendBtn = OTP_SEND_HINT.test(text);
        var strong = /(验证码|校验码|动态码|短信|otp|vcode|sms|one.?time)/i.test(hintOf(codeEl));
        // 弱信号（只写了 code）又没有「获取验证码」按钮 → 不认，避免把邮编/优惠码当验证码
        if (!strong && !sendBtn) continue;
        var confidence = 0.62 + (sendBtn ? 0.16 : 0) + (isBefore(accountEl, codeEl) ? 0.06 : 0);
        out.push({
          type: 'otp',
          confidence: Math.min(0.92, Math.round(confidence * 100) / 100),
          container: cssPath(container),
          username: fieldInfo(accountEl, win),
          password: null,
          passwords: [],
          otp: fieldInfo(codeEl, win),
          reasons: [
            '手机号/邮箱 + 验证码（无密码框）',
            sendBtn ? '含「获取验证码」按钮' : '账号框与验证码框在同一容器',
          ],
        });
        takenContainers.add(container);
      }
    }
    return out;
  }

  // ---- 账号先行（email-first）登录：第一屏只有账号框 + 「下一步」，密码在下一屏 ----
  // Microsoft / Notion / Zoom / Atlassian / Slack / WordPress 等都在用这个形态。
  // 这类页面**没有密码框可填**，但账号框是明确可填的，不给入口等于整站失效。
  // 严格设卡避免把搜索框、订阅框当账号框：必须命中账号语义 + 容器内有「下一步/继续/登录」类按钮。
  var ACCOUNT_ONLY_BTN = /(下一步|下 一 步|继续|下一步骤|next|continue|forward|登\s*录|登\s*入|sign\s*in|log\s*in)/i;
  var ACCOUNT_ONLY_STRONG_BTN = /(下一步|继续|next|continue)/i;

  function visibleButtonText(container, win) {
    var btns = container.querySelectorAll(
      'button, input[type="submit"], [role="button"], a.btn, a[class*="btn"], a[class*="button"]'
    );
    var text = '';
    for (var i = 0; i < btns.length; i++) {
      if (!isVisible(btns[i], win)) continue;
      var t = (btns[i].value || textOf(btns[i]) || '').trim();
      if (t) text += ' ' + t;
    }
    return text;
  }

  function detectAccountOnlyForms(doc, win, roots, takenContainers) {
    var out = [];
    for (var r = 0; r < roots.length; r++) {
      var inputs = roots[r].querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        var type = (el.getAttribute('type') || el.type || 'text').toLowerCase();
        if (['text', 'email', 'tel'].indexOf(type) < 0) continue;
        if (!isVisible(el, win) || el.disabled || el.readOnly || looksLikeHoneypot(el, win)) continue;

        var hint = hintOf(el);
        if (SEARCH_HINT.test(hint)) continue;

        var container = containerFor(el);
        if (!container || !container.querySelectorAll) continue;
        if (takenContainers.has(container)) continue;
        if (container.getAttribute && container.getAttribute('role') === 'search') continue;

        // 容器里有密码框（哪怕隐藏）→ 那是密码表单的活，别抢。
        // 这条刻意从严：水合过程中的半成品表单、display:none 的密码框都不该被
        // 当成「账号先行」入口，否则会出现图标乱挂和 hidden.html 那类误报。
        if (container.querySelector('input[type="password"]')) continue;

        // 容器里已有验证码框 → 走 otp 路径
        var otpTaken = false;
        var allInputs = container.querySelectorAll('input');
        var visibleTextInputs = 0;
        for (var k = 0; k < allInputs.length; k++) {
          if (isOtpLike(allInputs[k], win)) { otpTaken = true; break; }
          var t2 = (allInputs[k].getAttribute('type') || allInputs[k].type || 'text').toLowerCase();
          if (['text', 'email', 'tel'].indexOf(t2) >= 0 && isVisible(allInputs[k], win)) visibleTextInputs++;
        }
        if (otpTaken) continue;
        // 最多容忍两个可见文本框（有的站是「手机号 + 图形码」或「账号 + 记住我」结构）；
        // 三个以上基本是「账号 + 优惠码 + 邮编」那类混合表单，宁可不出图标也不能误填。
        if (visibleTextInputs < 1 || visibleTextInputs > 2) continue;

        // 账号语义判定：hint 命中 → 直接算；hint 取不到（很多站 label 没绑 for、
        // 或用兄弟 div 当标题）时，退一步看容器自身文案，但要求容器里只有这一个文本框。
        var strongHint = type === 'email' || ACCOUNT_HINT.test(hint);
        if (!strongHint) {
          if (visibleTextInputs !== 1) continue;
          var ctx = String(container.textContent || '').slice(0, 160);
          if (!/(邮箱|手机|账号|帐号|账户|登录|登入|sign\s*in|log\s*in|email|phone)/i.test(ctx)) continue;
          if (SEARCH_HINT.test(ctx)) continue;
        }

        // 按钮：先在容器内找「下一步/继续/登录」，找不到再往上找 2~3 层
        // （不少站把按钮放在 form 外的兄弟节点里）。向上找时只认强信号，
        // 避免把页头的「登录」导航链接当成本表单的提交按钮。
        var btnText = visibleButtonText(container, win);
        var strongBtn = ACCOUNT_ONLY_STRONG_BTN.test(btnText);
        if (!btnText || !ACCOUNT_ONLY_BTN.test(btnText)) {
          var up = container.parentElement;
          for (var d = 0; up && d < 3 && !strongBtn; d++) {
            var t3 = visibleButtonText(up, win);
            if (ACCOUNT_ONLY_STRONG_BTN.test(t3)) { strongBtn = true; btnText = t3; }
            up = up.parentElement;
          }
          if (!strongBtn) continue;
        }

        var confidence = 0.54 + (type === 'email' ? 0.06 : 0) + (strongBtn ? 0.05 : 0) + (strongHint ? 0.03 : 0);
        out.push({
          type: 'username-only',
          confidence: Math.round(confidence * 100) / 100,
          container: cssPath(container),
          username: fieldInfo(el, win),
          password: null,
          passwords: [],
          otp: null,
          reasons: [
            '账号先行登录：本屏只有账号框，密码在下一屏',
            strongBtn ? '附近有「下一步/继续」按钮' : '容器内有「登录」类按钮',
            strongHint ? '账号框语义明确' : '按容器文案推断为账号框',
          ],
        });
        takenContainers.add(container);
        break; // 一个容器只出一条
      }
    }
    return out;
  }

  var URL_SIGNUP_HINT = /(register|signup|sign-up|regist|join|createaccount|create-account|zhuce)/i;

  function classify(container, infos, url) {
    var fillable = infos.filter(function (i) { return i.fillable; });
    // 12306 / 淘宝这类站点的提交按钮是 <a class="btn">，不是 <button>，
    // 所以要把常见按钮样式的链接也算进按钮文案。
    var buttons = container.querySelectorAll(
      'button, input[type="submit"], [role="button"], a.btn, a[class*="btn"], a[class*="button"]'
    );
    var buttonText = '';
    for (var i = 0; i < buttons.length; i++) {
      buttonText += ' ' + (buttons[i].value || textOf(buttons[i]));
    }
    var pageText = textOf(container);
    var count = fillable.length;
    var hasNew = infos.some(function (i) { return i.autocomplete.indexOf('new-password') >= 0; });
    var looksLikeLogin = LOGIN_HINT.test(buttonText);

    if (count >= 3 || (CHANGE_HINT.test(pageText) && count >= 2)) return 'change';
    // 两个密码框（密码 + 确认）是最可靠的注册信号；不看整页文案，
    // 因为几乎每个登录页都有「免费注册」链接。
    if (count >= 2) return 'signup';
    // URL 强信号：register.u.sdo.com 这类注册专页，路径/域名里带注册词，
    // 即使单密码框且按钮文案取不到（按钮被 JS 包装），也应判注册。
    var urlHint = url ? URL_SIGNUP_HINT.test(url) : false;
    if (urlHint && !looksLikeLogin) return 'signup';
    if (looksLikeLogin) return 'login';
    // 单密码框：autocomplete=new-password 只在按钮没说「登录」时才算注册证据
    // （12306 登录页就把密码框错标成 new-password）。
    if (hasNew) return 'signup';
    if (SIGNUP_HINT.test(buttonText)) return 'signup';
    if (urlHint) return 'signup'; // URL 说注册、按钮不置可否 → 相信 URL
    return 'login';
  }

  function confidenceOf(container, infos, username, type) {
    var score = 0.5;
    if (infos.some(function (i) { return i.fillable; })) score += 0.15;
    if (username) score += 0.15;
    if (container && container.tagName === 'FORM') score += 0.05;
    if (infos.some(function (i) { return /current-password|new-password/.test(i.autocomplete); })) score += 0.1;
    var text = textOf(container);
    if (SIGNUP_HINT.test(text) || LOGIN_HINT.test(text) || CHANGE_HINT.test(text)) score += 0.05;
    if (type !== 'login') score += 0.02;
    return Math.min(0.99, Math.round(score * 100) / 100);
  }

  function detectDocument(doc, win) {
    win = win || (doc && doc.defaultView);
    var roots = collectRoots(doc);
    var passwordInputs = [];
    for (var r = 0; r < roots.length; r++) {
      var found = roots[r].querySelectorAll('input[type="password"]');
      for (var p = 0; p < found.length; p++) passwordInputs.push(found[p]);
    }

    var groups = new Map();
    for (var i = 0; i < passwordInputs.length; i++) {
      var container = containerFor(passwordInputs[i]);
      if (!groups.has(container)) groups.set(container, []);
      groups.get(container).push(passwordInputs[i]);
    }

    var forms = [];
    var stats = {
      passwordInputs: passwordInputs.length,
      visiblePasswords: 0,
      hiddenPasswords: 0,
      honeypots: 0,
      shadowRoots: roots.length - 1,
    };

    groups.forEach(function (elements, container) {
      var entries = elements.map(function (el) {
        return { el: el, info: fieldInfo(el, win) };
      });
      var infos = entries.map(function (e) { return e.info; });
      var fillable = entries.filter(function (e) { return e.info.fillable; });

      infos.forEach(function (info) {
        if (info.visible) stats.visiblePasswords += 1;
        else stats.hiddenPasswords += 1;
        if (info.honeypot) stats.honeypots += 1;
      });

      if (!fillable.length) return;

      var type = classify(container, infos, (doc.location && doc.location.href) || '');
      var usernameEl = findUsername(fillable[0].el, container, win);
      var username = usernameEl ? fieldInfo(usernameEl, win) : null;
      var honeypotCount = infos.filter(function (x) { return x.honeypot; }).length;

      var reasons = [];
      reasons.push(fillable.length + ' 个可填充密码框');
      reasons.push(username ? '用户名已配对' : '未找到用户名（可能只需密码）');
      if (type === 'signup') reasons.push('两个及以上密码框 / new-password / 提交按钮为注册 → 注册');
      if (type === 'change') reasons.push('三个密码框或"修改密码"文案 → 改密');
      if (type === 'login') reasons.push('单密码框且无注册/改密信号 → 登录');
      if (honeypotCount) reasons.push('已排除 ' + honeypotCount + ' 个蜜罐/隐藏字段');

      forms.push({
        type: type,
        confidence: confidenceOf(container, infos, username, type),
        container: cssPath(container),
        username: username,
        password: fillable[0].info,
        passwords: infos,
        reasons: reasons,
      });
    });

    // 无密码的「手机号/邮箱 + 验证码」登录：单独一路识别，追加后统一排序
    var takenContainers = new Set(groups.keys());
    detectOtpForms(doc, win, roots, takenContainers).forEach(function (f) { forms.push(f); });

    // 账号先行（第一屏只有账号框，密码在下一屏）：同样单独一路，最后兜底
    detectAccountOnlyForms(doc, win, roots, takenContainers).forEach(function (f) { forms.push(f); });

    forms.sort(function (a, b) { return b.confidence - a.confidence; });

    return {
      url: doc.location ? doc.location.href : '',
      title: doc.title || '',
      forms: forms,
      stats: stats,
      detectedAt: new Date().toISOString(),
    };
  }

  return {
    detectDocument: detectDocument,
    _internals: {
      isVisible: isVisible,
      looksLikeHoneypot: looksLikeHoneypot,
      findUsername: findUsername,
      collectRoots: collectRoots,
      cssPath: cssPath,
    },
  };
});