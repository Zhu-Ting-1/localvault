/**
 * 身份管理：注册页「备选账号」的来源（手机号/常用邮箱）。
 * 存 storage.local（与「记住解锁」同级保护），注册菜单里点选即填。
 *
 * 列表按隐私打码显示（132****2398 / oc***t@example.com），
 * 填充时仍使用完整值；按住眼睛按钮可临时查看，松开即恢复。
 */
import { useEffect, useState } from 'react';
import { send } from '../../lib/messaging';
import { maskValue } from '../../lib/mask';

interface Identity {
  id: string;
  label: string;
  value: string;
}

const EYE = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12Z" />
    <circle cx="12" cy="12" r="3.1" />
  </svg>
);

export function IdentityManager() {
  const [list, setList] = useState<Identity[]>([]);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [peekId, setPeekId] = useState('');

  const reload = async () => {
    const r = await send<{ identities: Identity[] }>('get-identities');
    if (r.ok) setList(r.data.identities);
  };

  useEffect(() => {
    void reload();
  }, []);

  const add = async () => {
    if (!label.trim() || !value.trim()) return;
    await send('set-identities', {
      identities: [...list, { id: crypto.randomUUID(), label: label.trim(), value: value.trim() }],
    });
    setLabel('');
    setValue('');
    void reload();
  };

  const del = async (id: string) => {
    await send('set-identities', { identities: list.filter((x) => x.id !== id) });
    void reload();
  };

  return (
    <div className="card">
      <div style={{ fontWeight: 650, fontSize: 13 }}>常用身份</div>
      <div style={{ fontSize: 10.5, color: 'var(--sub)', margin: '4px 0 8px' }}>
        注册页点 LocalVault 图标时，可直接从这些身份里选一个当账号填充。
        <br />
        列表按隐私打码显示，填充时使用完整值；按住眼睛可临时查看。
      </div>

      {list.map((id) => (
        <div key={id.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--sub)', flex: 'none', width: 52 }}>{id.label}</span>
          <span
            style={{
              fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
            }}
          >
            {peekId === id.id ? id.value : maskValue(id.value)}
          </span>
          <button
            type="button"
            title="按住查看完整值"
            aria-label="按住查看完整值"
            onPointerDown={() => setPeekId(id.id)}
            onPointerUp={() => setPeekId('')}
            onPointerLeave={() => setPeekId('')}
            onPointerCancel={() => setPeekId('')}
            style={{
              flex: 'none', padding: '4px 7px', fontSize: 10.5, color: 'var(--sub)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {EYE}
          </button>
          <button className="danger" style={{ padding: '4px 8px', fontSize: 10.5 }} onClick={() => void del(id.id)}>
            删
          </button>
        </div>
      ))}
      {list.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--tert)', padding: '4px 0' }}>还没有添加。</div>
      )}

      <div style={{ marginTop: 10 }}>
        <input
          placeholder="名称（手机 / QQ邮箱）"
          value={label}
          style={{ marginBottom: 5 }}
          onChange={(e) => setLabel(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 5 }}>
          <input
            placeholder="手机号或邮箱"
            value={value}
            style={{ flex: 1 }}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button style={{ flex: 'none' }} onClick={() => void add()}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
