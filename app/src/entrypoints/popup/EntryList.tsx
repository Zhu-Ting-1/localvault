import { useEffect, useMemo, useState } from 'react';
import { copySecret } from '../../lib/clipboard';
import { displaySiteName, formatCredentialCopy } from '../../lib/site-name';
import { send } from '../../lib/messaging';
import type { VaultEntry } from '../../lib/vault';
import { EntryEditor } from './EntryEditor';
import { Generator } from './Generator';
import { CurrentSiteCard } from './CurrentSiteCard';
import { IdentityManager } from './IdentityManager';

function newEntry(): VaultEntry {
  return {
    id: crypto.randomUUID(),
    title: '',
    username: '',
    password: '',
    urls: [],
    notes: '',
    createdAt: '',
    updatedAt: '',
    passwordHistory: [],
  };
}

export function EntryList({
  entries,
  onChanged,
  onLock,
}: {
  entries: VaultEntry[];
  onChanged: () => void;
  onLock: () => void;
}) {
  const [editing, setEditing] = useState<VaultEntry | null>(null);
  const [showGen, setShowGen] = useState(false);
  const [copiedId, setCopiedId] = useState('');
  const [remember, setRemember] = useState<boolean | null>(null); // null = 未加载
  const [savePrompt, setSavePrompt] = useState<{ username: string; password: string; url: string } | null>(null);
  const [showIdentities, setShowIdentities] = useState(false);
  const [uiMsg, setUiMsg] = useState('');

  // 扩展只看最近 2 条；完整列表、设置、导出、审计日志已迁到本地管理后台。
  const recent = useMemo(
    () => [...entries]
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
      .slice(0, 2),
    [entries],
  );

  const openUi = async () => {
    const r = await send('open-ui');
    if (!r.ok) setUiMsg(r.message ?? '本地后台未启动');
  };

  // 一次复制账号 + 密码：账号一行、密码一行（粘贴到表单才不会粘成一串）。
  // 密码不在 head 里，必须按条现取；取不到就只复制账号。
  const copy = async (e: VaultEntry) => {
    let password = '';
    try {
      const r = await send<{ password: string }>('get-entry-secret', { id: e.id });
      if (r.ok) password = r.data.password ?? '';
    } catch { /* 取密码失败：至少把账号复制出去 */ }
    const text = formatCredentialCopy(e.username ?? '', password);
    if (!text) { setUiMsg('这条没有账号和密码'); return; }
    await copySecret(text);
    setCopiedId(e.id);
    setTimeout(() => setCopiedId(''), 1500);
  };

  // 加载「记住解锁」当前状态 + 检查是否有刚提交的登录（保存提示）
  useEffect(() => {
    void send<{ rememberEnabled: boolean }>('status').then((r) => {
      if (r.ok) setRemember(r.data.rememberEnabled);
    });
    void (async () => {
      const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] ?? null));
      });
      if (!tab?.id) return;
      const r = await send<{ username: string; password: string; url: string } | null>('lv-take-last-submit', { tabId: tab.id });
      if (r.ok && r.data) setSavePrompt(r.data);
    })();
  }, []);

  const saveSubmitted = async () => {
    if (!savePrompt) return;
    let promptUrl: URL | null = null;
    try { promptUrl = new URL(savePrompt.url); } catch { /* 非法 URL 不合并 */ }
    const existing = entries.find(
      (e) => e.username === savePrompt.username && promptUrl != null &&
        e.urls.some((u) => {
          try { return new URL(u.startsWith('http') ? u : 'https://' + u).origin === promptUrl!.origin; }
          catch { return false; }
        }),
    );
    if (existing) {
      // 更新：密码变更会自动归档历史（background save-entry 逻辑）
      await send('save-entry', {
        entry: { ...existing, password: savePrompt.password, urls: [...new Set([...existing.urls, savePrompt.url])] },
      });
    } else {
      await send('save-entry', {
        entry: {
          id: crypto.randomUUID(),
          title: savePrompt.url.replace(/^https?:\/\//, ''),
          username: savePrompt.username,
          password: savePrompt.password,
          urls: [savePrompt.url],
          notes: '',
          createdAt: '', updatedAt: '', passwordHistory: [],
        },
      });
    }
    setSavePrompt(null);
    onChanged();
  };

  const toggleRemember = async () => {
    const next = !(remember ?? false);
    const r = await send('set-remember', { enabled: next });
    if (r.ok) setRemember(next);
  };

  const del = async (e: VaultEntry) => {
    if (!confirm(`删除「${e.title}」？此操作不可撤销。`)) return;
    await send('delete-entry', { id: e.id });
    onChanged();
  };

  if (editing) {
    return (
      <EntryEditor
        entry={editing}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          onChanged();
        }}
      />
    );
  }

  return (
    <>
      {savePrompt && (
        <div className="card" style={{ borderColor: 'var(--blue)', background: 'var(--blue-tint)' }}>
          <div style={{ fontWeight: 650, fontSize: 12.5 }}>保存这个登录信息？</div>
          <div style={{ fontSize: 11, color: 'var(--sub)', margin: '4px 0 8px' }}>
            {savePrompt.url.replace(/^https?:\/\//, '')} · {savePrompt.username || '（用户名为空）'}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="primary" style={{ padding: '7px 12px' }} onClick={() => void saveSubmitted()}>
              保存
            </button>
            <button style={{ padding: '7px 12px' }} onClick={() => setSavePrompt(null)}>
              本次不保存
            </button>
          </div>
        </div>
      )}

      <CurrentSiteCard />

      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 12.5 }}>全部条目与设置 · 本地管理后台</div>
          <div className="hint" style={{ marginTop: 2 }}>
            共 {entries.length} 条。完整列表、加密程度、导出、详细审计日志都在后台，条目多时不用在这里翻。
          </div>
        </div>
        <button className="primary" style={{ flex: 'none', padding: '8px 12px' }} onClick={() => void openUi()}>
          打开后台
        </button>
      </div>
      {uiMsg && <div className="error">{uiMsg}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 2px' }}>
        <span style={{ fontSize: 11, fontWeight: 650, color: 'var(--sub)' }}>最近使用</span>
        <span style={{ fontSize: 10.5, color: 'var(--tert)' }}>只显示最近 2 条</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {recent.length === 0 && (
          <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--sub)', fontSize: 11.5 }}>
            还没有条目，点下方「新增」开始。
          </div>
        )}
        {recent.map((e, i) => (
          <div
            key={e.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 12px',
              borderTop: i === 0 ? 'none' : '1px solid var(--line)',
              // 大库（几百上千条）时让浏览器跳过视口外行的渲染，滚动才不卡
              contentVisibility: 'auto',
              containIntrinsicSize: '58px',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {displaySiteName(e.title, e.urls)}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--sub)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.username}
              </div>
            </div>
            <button style={{ padding: '5px 8px', fontSize: 10.5 }} onClick={() => void copy(e)}>
              {copiedId === e.id ? '✓ 已复制' : '复制'}
            </button>
            <button style={{ padding: '5px 8px', fontSize: 10.5 }} onClick={() => setEditing(e)}>
              编辑
            </button>
            <span className="sr-only" role="status" aria-live="polite">
              {copiedId === e.id ? '账号和密码已复制（两行），30 秒后自动清空剪贴板' : ''}
            </span>
            <button className="danger" style={{ padding: '5px 8px', fontSize: 10.5 }} onClick={() => void del(e)}>
              删
            </button>
          </div>
        ))}
      </div>

      {showGen && <Generator />}
      {showIdentities && <IdentityManager />}

      <div style={{ display: 'flex', gap: 6 }}>
        <button className="primary" onClick={() => setEditing(newEntry())}>
          ＋ 新增
        </button>
        <button onClick={() => setShowGen((v) => !v)}>{showGen ? '收起生成器' : '生成密码'}</button>
        <button onClick={() => setShowIdentities((v) => !v)}>身份</button>
        <button onClick={onLock}>锁定</button>
      </div>

      {remember !== null && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            style={{ width: 'auto', marginTop: 2 }}
            checked={remember}
            onChange={() => void toggleRemember()}
          />
          <span style={{ fontSize: 10.5, color: 'var(--sub)' }}>
            记住解锁（开机后免输主密码）
            <br />
            <span style={{ color: 'var(--tert)' }}>
              代价：能读本机文件的程序即可解密；手动锁定会取消记忆
            </span>
          </span>
        </label>
      )}
      <div className="hint">数据加密存于本机 vault.db · 完整列表请打开本地管理后台 · 空闲 15 分钟自动锁定</div>
    </>
  );
}