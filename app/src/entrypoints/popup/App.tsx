import { useCallback, useEffect, useState } from 'react';
import { send, type StatusData } from '../../lib/messaging';
import type { VaultEntry } from '../../lib/vault';
import { EntryList } from './EntryList';
import { Onboarding } from './Onboarding';
import { Unlock } from './Unlock';

type Screen = 'loading' | 'onboarding' | 'locked' | 'unlocked';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [status, setStatus] = useState<StatusData | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [error, setError] = useState('');
  const [helloLegacy, setHelloLegacy] = useState(false);
  const [helloBusy, setHelloBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await send<StatusData>('status');
    if (!res.ok) {
      setError(res.message);
      setScreen('locked');
      return;
    }
    setStatus(res.data);
    setError('');
    if (res.data.state === 'no-vault') setScreen('onboarding');
    else if (res.data.state === 'locked') setScreen('locked');
    else {
      const e = await send<{ entries: VaultEntry[] }>('entries');
      if (e.ok) {
        setEntries(e.data.entries);
        setScreen('unlocked');
      } else {
        setError(e.message);
        setScreen('locked');
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 解锁态才谈得上重设 Hello（包裹 DEK 需要钥匙在手）
  useEffect(() => {
    if (screen !== 'unlocked') return;
    void (async () => {
      const r = await send<{ legacy?: boolean }>('tpm-status');
      if (r.ok) setHelloLegacy(!!r.data?.legacy);
    })();
  }, [screen]);

  const reEnableHello = async () => {
    setHelloBusy(true);
    setError('');
    const r = await send('tpm-enable');
    setHelloBusy(false);
    if (r.ok) setHelloLegacy(false);
    else setError(r.message ?? '重新开启失败');
  };

  const dotClass =
    screen === 'unlocked' ? 'ok' : screen === 'locked' ? 'locked' : screen === 'onboarding' ? '' : 'bad';

  return (
    <>
      <header className="head">
        <div className="brand">
          <div className="appicon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2 4.5 5.2v5.6c0 4.4 3.1 8.4 7.5 9.6 4.4-1.2 7.5-5.2 7.5-9.6V5.2L12 2Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8.8 12.1 11 14.3l4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="title">LocalVault</div>
            <div className="sub">
              {screen === 'unlocked' ? '已解锁' : screen === 'locked' ? '已锁定' : screen === 'onboarding' ? '未初始化' : '连接中…'}
            </div>
          </div>
        </div>
        <span className={'dot ' + dotClass} />
      </header>

      {error && <div className="error">{error}</div>}

      {screen === 'loading' && <div className="card">连接中…</div>}

      {screen === 'onboarding' && <Onboarding onDone={refresh} />}

      {screen === 'locked' && <Unlock onUnlocked={refresh} status={status} />}

      {screen === 'unlocked' && helloLegacy && (
        <div className="card">
          <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            Windows Hello 的旧配置不会要求指纹/PIN，已停用。重新开启会弹一次系统确认框，
            本窗口可能自动关闭，确认后重新打开即可。
          </div>
          <button
            className="primary full"
            style={{ marginTop: 8 }}
            disabled={helloBusy}
            onClick={() => void reEnableHello()}
          >
            {helloBusy ? '等待系统确认…' : '重新开启 Windows Hello'}
          </button>
          <button
            className="full"
            style={{ marginTop: 6 }}
            disabled={helloBusy}
            onClick={() => setHelloLegacy(false)}
          >
            以后再说
          </button>
        </div>
      )}

      {screen === 'unlocked' && (
        <EntryList
          entries={entries}
          onChanged={refresh}
          onLock={async () => {
            await send('lock');
            await refresh();
          }}
        />
      )}
    </>
  );
}