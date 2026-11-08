import { useState } from 'react';
import { copySecret } from '../../lib/clipboard';
import { send } from '../../lib/messaging';
import { passwordStrength } from '../../lib/generator';

const STEPS = { create: 0, recovery: 1, done: 2 } as const;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<number>(STEPS.create);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [acked, setAcked] = useState(false);

  const strength = passwordStrength(pw1);

  const create = async () => {
    if (pw1.length < 8) return setError('主密码至少 8 位');
    if (pw1 !== pw2) return setError('两次输入的密码不一致');
    setBusy(true);
    setError('');
    const res = await send<{ recoveryKey: string }>('create-vault', { masterPassword: pw1 });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setRecoveryKey(res.data.recoveryKey);
    setStep(STEPS.recovery);
  };

  const copyKey = async () => {
    await copySecret(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (step === STEPS.recovery) {
    return (
      <div className="card">
        <div style={{ fontWeight: 650, fontSize: 14 }}>第 2 步 · 保存恢复密钥</div>
        <div style={{ fontSize: 11, color: 'var(--sub)', margin: '6px 0 10px' }}>
          如果忘记主密码，只能用这串恢复密钥重设。<b>它只显示这一次</b>，请抄写到纸面或打印保存。
        </div>
        <div
          className="mono"
          style={{
            background: 'var(--card-2)',
            border: '1px dashed var(--line)',
            borderRadius: 9,
            padding: '10px 12px',
            textAlign: 'center',
            fontSize: 13,
            letterSpacing: 1,
            userSelect: 'all',
          }}
        >
          {recoveryKey}
        </div>
        <button className="full" style={{ marginTop: 8 }} onClick={() => void copyKey()}>
          {copied ? '✓ 已复制' : '复制恢复密钥'}
        </button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={acked}
            onChange={(e) => setAcked(e.target.checked)}
          />
          我已离线保存好恢复密钥，并理解丢失主密码和恢复密钥将无法找回数据
        </label>
        <button className="primary full" style={{ marginTop: 10 }} disabled={!acked} onClick={onDone}>
          完成，进入保险库
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 650, fontSize: 14 }}>创建你的保险库</div>
      <div style={{ fontSize: 11, color: 'var(--sub)', margin: '6px 0 2px' }}>
        数据只存在这台电脑上（加密后的 vault.db），绝不联网。主密码用于加密，我们无法帮你找回。
      </div>

      <label>主密码（至少 8 位）</label>
      <input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} autoFocus />
      {pw1 && (
        <div style={{ marginTop: 6, fontSize: 10.5, color: strength.score >= 3 ? 'var(--green)' : 'var(--orange)' }}>
          强度：{strength.label}
        </div>
      )}

      <label>再输一遍</label>
      <input
        type="password"
        value={pw2}
        onChange={(e) => setPw2(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void create()}
      />

      {error && (
        <div className="error" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <button className="primary full" style={{ marginTop: 12 }} disabled={busy} onClick={() => void create()}>
        {busy ? '生成密钥中…' : '创建保险库'}
      </button>
      <div className="hint">下一步会显示恢复密钥（用于忘记主密码时重设）。</div>
    </div>
  );
}