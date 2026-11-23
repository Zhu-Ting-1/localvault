import { useState } from 'react';
import { send } from '../../lib/messaging';
import type { VaultEntry } from '../../lib/vault';
import { generatePassword, passwordStrength } from '../../lib/generator';

export function EntryEditor({
  entry,
  onSaved,
  onCancel,
}: {
  entry: VaultEntry;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<VaultEntry>(entry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isNew = !entry.createdAt;

  const strength = passwordStrength(draft.password);
  const set = (patch: Partial<VaultEntry>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (!draft.title.trim()) return setError('标题不能为空');
    setBusy(true);
    setError('');
    const res = await send('save-entry', { entry: draft });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onSaved();
  };

  return (
    <div className="card">
      <div style={{ fontWeight: 650, fontSize: 14, marginBottom: 6 }}>
        {isNew ? '新增条目' : '编辑条目'}
      </div>

      <label>名称 *</label>
      <input value={draft.title} onChange={(e) => set({ title: e.target.value })} autoFocus />

      <label>用户名 / 邮箱 / 手机号</label>
      <input value={draft.username} onChange={(e) => set({ username: e.target.value })} />

      <label>密码</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="password"
          value={draft.password}
          onChange={(e) => set({ password: e.target.value })}
          style={{ flex: 1 }}
        />
        <button style={{ flex: 'none' }} onClick={() => set({ password: generatePassword() })}>
          生成
        </button>
      </div>
      {draft.password && (
        <div style={{ marginTop: 5, fontSize: 10.5, color: strength.score >= 3 ? 'var(--green)' : 'var(--orange)' }}>
          强度：{strength.label}
        </div>
      )}

      <label>网址（每行一个，可选）</label>
      <textarea
        rows={2}
        value={draft.urls.join('\n')}
        onChange={(e) => set({ urls: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
      />

      <label>备注（可选）</label>
      <textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />

      {error && (
        <div className="error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button onClick={onCancel}>取消</button>
      </div>
      {!isNew && draft.passwordHistory.length > 0 && (
        <div className="hint">此条目有 {draft.passwordHistory.length} 条历史密码（改密时自动归档）。</div>
      )}
    </div>
  );
}