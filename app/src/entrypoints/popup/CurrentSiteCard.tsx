/**
 * 「当前网站」卡片（弹窗里最上面的区域）：
 * 显示当前标签页识别到的登录框 + 匹配到的账号，一键填充。
 * 填充 = 发消息给内容脚本（点击才填原则不变；这里也是用户显式点击）。
 */
import { useEffect, useState } from 'react';
import { send } from '../../lib/messaging';

interface FormReport {
  url: string;
  origin: string;
  forms: Array<{ type: string; confidence: number; hasUsername: boolean; passwordCount: number }>;
  isTop: boolean;
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] ?? null));
  });
}

function tabMessage<T>(tabId: number, msg: Record<string, unknown>): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res: T) => {
      void chrome.runtime.lastError;
      resolve(res ?? null);
    });
  });
}

export function CurrentSiteCard() {
  const [site, setSite] = useState<{ origin: string; forms: FormReport['forms'] } | null>(null);
  const [match, setMatch] = useState<{ username: string; title: string } | null>(null);
  const [filling, setFilling] = useState(false);
  const [filled, setFilled] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      const tab = await activeTab();
      if (!tab?.id || !tab.url?.startsWith('http')) return;
      const res = await send<{ origin: string; forms: FormReport['forms'] } | null>('get-tab-forms', { tabId: tab.id });
      if (!res.ok || !res.data) {
        setNote('此页面未识别到登录框（可能还没打开登录表单）');
        return;
      }
      setSite({ origin: res.data.origin, forms: res.data.forms });
      const cred = await send<{ username: string; title: string } | null>('get-credentials', { url: tab.url });
      if (cred.ok && cred.data) setMatch(cred.data);
    })();
  }, []);

  const fill = async () => {
    const tab = await activeTab();
    if (!tab?.id) return;
    setFilling(true);
    const res = await tabMessage<{ ok: boolean; error?: string }>(tab.id, { type: 'lv-fill-now' });
    setFilling(false);
    if (res?.ok) {
      setFilled(true);
      setTimeout(() => setFilled(false), 1500);
    } else {
      setNote('填充失败：' + (res?.error ?? '页面未响应'));
    }
  };

  if (note) {
    return (
      <div className="card" style={{ fontSize: 11, color: 'var(--sub)' }}>
        {note}
      </div>
    );
  }
  if (!site) return null;

  const form = site.forms[0];
  const typeLabel = form?.type === 'signup' ? '注册框'
    : form?.type === 'change' ? '改密框'
    : form?.type === 'otp' ? '验证码登录框'
    : form?.type === 'username-only' ? '账号先行登录框（密码在下一屏）'
    : '登录框';

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 12.5 }}>
            {match ? match.title || '已匹配账号' : '检测到' + typeLabel}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {site.origin}
            {form ? ` · ${Math.round(form.confidence * 100)}%` : ''}
          </div>
        </div>
        <button
          className="primary"
          style={{ flex: 'none', padding: '8px 14px' }}
          disabled={filling || filled}
          onClick={() => void fill()}
        >
          {filled ? '✓ 已填充' : filling ? '填充中…' : '填充'}
        </button>
      </div>
      {match && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--sub)' }}>
          账号：{match.username}
        </div>
      )}
      {!match && (
        <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--tert)' }}>
          本站还没有保存的账号 · 下方列表新增一条并填入本站网址即可
        </div>
      )}
      <div className="hint">填充后仍由你点击站点的登录按钮（LocalVault 不会自动提交）。</div>
    </div>
  );
}