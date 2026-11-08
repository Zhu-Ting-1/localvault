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