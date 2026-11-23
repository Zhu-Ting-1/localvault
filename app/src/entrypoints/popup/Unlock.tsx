import { useState } from 'react';
import { send, type StatusData } from '../../lib/messaging';

export function Unlock({ onUnlocked, status }: { onUnlocked: () => void; status: StatusData | null }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [tpmBusy, setTpmBusy] = useState(false);

  /** 本机是否开启过 TPM 解锁：host 侧有 tpm.wrapping 才显示按钮。
   *  探测方式：unlock-tpm 失败码区分「未配置」（不显示）和其他（显示）。 */
  const tryTpm = async () => {
    if (tpmBusy) return;
    setTpmBusy(true);
    setError('');
    const res = await send<{ entries: number; method: string }>('unlock-tpm');
    setTpmBusy(false);
    if (res.ok) {
      onUnlocked();
      return;
    }
    // 未配置 → 隐藏按钮（后续不再尝试）；取消/过期等 → 显示错误
    if (res.code === 'tpm-not-configured') {
      setShowTpm(false);
      return;
    }
    // 旧版 Hello 包裹（无使用确认）已停用：主密码解锁后弹窗里会直接给出重新开启入口
    if (res.code === 'tpm-legacy') {
      setError('旧版 Hello 解锁不会要求指纹/PIN，已停用。用主密码解锁后，这里会出现「重新开启」按钮。');
      return;
    }
    // 旧库（v1）在 TPM 路径无法自动迁移（DEK 不出 host）：明确引导用主密码升级一次
    if (res.code === 'need-migrate') {
      setError('检测到旧版保险库。请在上方主密码框输入一次主密码完成升级，之后 Windows Hello 解锁可继续使用。');
      return;
    }
    setError(res.message);
  };

  const [showTpm, setShowTpm] = useState(true);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    const res = await send('unlock', { password });
    setBusy(false);
    if (res.ok) {
      onUnlocked();
    } else {
      setError(res.message);
      if (res.retryAfterMs) {
        setCooldown(Math.ceil(res.retryAfterMs / 1000));
        const t = setInterval(() => {
          setCooldown((c) => {
            if (c <= 1) clearInterval(t);
            return c - 1;
          });
        }, 1000);
      }
    }
  };

  return (
    <div className="card">
      <div style={{ fontWeight: 650, fontSize: 14, marginBottom: 4 }}>输入主密码解锁</div>
      <div style={{ fontSize: 11, color: 'var(--sub)', marginBottom: 10 }}>
        保险库在本机加密存储，主密码不会离开这台电脑。
      </div>

      <input
        type="password"
        placeholder="主密码"
        value={password}
        autoFocus
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />

      {cooldown > 0 && (
        <div className="error" style={{ marginTop: 10 }}>
          尝试过于频繁，{cooldown} 秒后可重试
        </div>
      )}
      {error && cooldown === 0 && (
        <div className="error" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <button className="primary full" style={{ marginTop: 10 }} disabled={busy || cooldown > 0} onClick={() => void submit()}>
        {busy ? '解密中…' : '解锁'}
      </button>

      {showTpm && (
        <button
          className="full"
          style={{ marginTop: 8 }}
          disabled={tpmBusy || cooldown > 0}
          onClick={() => void tryTpm()}
        >
          {tpmBusy ? '等待 Windows Hello…' : '用 Windows Hello 解锁'}
        </button>
      )}

      <div className="hint">
        {status?.hostOk ? '本地助手已连接' : '⚠ 本地助手未连接（vault-host.exe）'} · 忘记密码可用恢复密钥重设
      </div>
    </div>
  );
}
