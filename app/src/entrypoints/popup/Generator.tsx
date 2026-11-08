import { useState } from 'react';
import { generatePassword, passwordStrength } from '../../lib/generator';
import { copySecret } from '../../lib/clipboard';

export function Generator() {
  const [length, setLength] = useState(20);
  const [symbols, setSymbols] = useState(true);
  const [pwd, setPwd] = useState(() => generatePassword({ length: 20 }));
  const [copied, setCopied] = useState(false);

  const regen = (len = length, sym = symbols) => {
    setPwd(generatePassword({ length: len, symbols: sym }));
    setCopied(false);
  };
  const strength = passwordStrength(pwd);

  return (
    <div className="card">
      <div style={{ fontWeight: 650, fontSize: 13 }}>密码生成器</div>
      <div
        className="mono"
        style={{
          margin: '8px 0',
          padding: '8px 10px',
          background: 'var(--card-2)',
          border: '1px solid var(--line)',
          borderRadius: 9,
          fontSize: 12.5,
          userSelect: 'all',
          wordBreak: 'break-all',
        }}
      >
        {pwd}
      </div>
      <div style={{ fontSize: 10.5, color: strength.score >= 3 ? 'var(--green)' : 'var(--orange)' }}>
        强度：{strength.label}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        长度 {length}
        <input
          type="range"
          min={8}
          max={64}
          value={length}
          style={{ flex: 1, padding: 0 }}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLength(v);
            regen(v);
          }}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={symbols}
          onChange={(e) => {
            setSymbols(e.target.checked);
            regen(length, e.target.checked);
          }}
        />
        包含符号（!@#$…）
      </label>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="primary" onClick={() => regen()}>
          重新生成
        </button>
        <button
          onClick={async () => {
            await copySecret(pwd);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
    </div>
  );
}