/**
 * 设置 / 诊断页（options）。
 *
 * 三件事：
 *  1. 诊断：host 版本、保险库路径与大小、revision、最后写入、备份列表、目录可写性、剩余空间
 *  2. 备份：把加密保险库原样导出成文件；从文件导入（覆盖当前库，需输入该文件的主密码校验）
 *  3. 安全选项：记住解锁开关
 *
 * 这一页不联网，只跟 background 说话；导出的文件是**整份密文**，不含明文。
 */
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { send, type StatusData } from '../../lib/messaging';
import type { DiagInfo } from '../../lib/host';
import './options.css';

interface DiagPayload {
  host: DiagInfo | { error: string };
  state: StatusData['state'];
  entryCount: number | null;
  rememberEnabled: boolean;
}

function isHostInfo(h: DiagPayload['host']): h is DiagInfo {
  return !!h && typeof (h as DiagInfo).vaultPath === 'string';
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function stateLabel(s: DiagPayload['state']): { text: string; cls: string } {
  if (s === 'unlocked') return { text: '已解锁', cls: 'ok' };
  if (s === 'locked') return { text: '已锁定', cls: 'warn' };
  return { text: '未创建保险库', cls: 'bad' };
}

function App() {
  const [diag, setDiag] = useState<DiagPayload | null>(null);
  const [hostMissing, setHostMissing] = useState(false);
  const [importPwd, setImportPwd] = useState('');
  const [importFile, setImportFile] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [plainAck, setPlainAck] = useState(false);
  const [plainBusy, setPlainBusy] = useState(false);
  const [tpmEnabled, setTpmEnabled] = useState(false);
  const [tpmBusy, setTpmBusy] = useState(false);
  const [tpmSupported, setTpmSupported] = useState<boolean | null>(null);
  const [tpmMethod, setTpmMethod] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<'host' | 'none' | 'strict'>('host');
  const [exportBusy, setExportBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await send<DiagPayload>('diag');
    if (!res.ok) {
      setHostMissing(true);
      setDiag(null);
      return;
    }
    setHostMissing(!isHostInfo(res.data.host));
    setDiag(res.data);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void loadTpm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diag?.state, diag]);
  useEffect(() => {
    if (diag) setTpmEnabled(!!(diag.host as { tpmEnabled?: boolean })?.tpmEnabled);
  }, [diag]);

  const doExport = async () => {
    setBusy(true); setMsg(null);
    const res = await send<{ envelope: unknown }>('export-envelope');
    setBusy(false);
    if (!res.ok) { setMsg({ kind: 'err', text: res.message }); return; }
    const blob = new Blob([JSON.stringify(res.data.envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    a.href = url;
    a.download = `localvault-backup-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMsg({ kind: 'ok', text: '已导出加密备份（里面只有密文，没有明文密码）' });
  };

  /** 明文 CSV：绕过一切加密，只给"迁移到别的工具"或"纸质备份"用 */
  /** TPM 状态加载：可用性来自 tpm-status，开关状态来自 diag.tpmEnabled */
  const loadTpm = async () => {
    const st = await send<{ available: boolean; method?: string }>('tpm-status');
    if (st.ok) {
      setTpmSupported(st.data?.available ?? false);
      setTpmMethod(st.data?.method ?? null);
    }
    if (diag) setTpmEnabled(!!(diag.host as { tpmEnabled?: boolean })?.tpmEnabled);
    const em = await send<{ mode: 'host' | 'none' | 'strict' }>('get-export-mode');
    if (em.ok && em.data?.mode) setExportMode(em.data.mode);
  };
  const setMode = async (mode: 'host' | 'none' | 'strict') => {
    if (mode === exportMode || exportBusy) return;
    setExportBusy(true);
    const r = await send<{ mode: string }>('set-export-mode', { mode });
    setExportBusy(false);
    if (r.ok) {
      setExportMode(mode);
      setMsg({ kind: 'ok', text: '加密程度已更新' });
      await refresh();
    } else {
      setMsg({ kind: 'err', text: r.message });
    }
  };

  const setHello = async (on: boolean) => {
    if (tpmBusy) return;
    setTpmBusy(true);
    setMsg(null);
    const r = on ? await send('tpm-enable') : await send('tpm-disable');
    setTpmBusy(false);
    if (r.ok) {
      setMsg({ kind: 'ok', text: on ? '已开启 Windows Hello 解锁' : '已关闭 Windows Hello 解锁' });
      await refresh();
      await loadTpm();
    } else {
      setMsg({ kind: 'err', text: r.message ?? '操作失败' });
    }
  };

  const doExportPlain = async () => {
    setPlainBusy(true); setMsg(null);
    const res = await send<{ exportedAt: string; rows: Array<Record<string, string>> }>('export-plaintext');
    setPlainBusy(false);
    if (!res.ok) { setMsg({ kind: 'err', text: res.message }); return; }

    const cols = ['title', 'username', 'password', 'urls', 'notes', 'createdAt', 'updatedAt'];
    const header = ['标题', '账号', '密码', '网址', '备注', '创建时间', '更新时间'];
    const esc = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [header.map(esc).join(',')];
    for (const r of res.data.rows) lines.push(cols.map((c) => esc(r[c])).join(','));

    // BOM：Excel 直接打开不乱码
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    a.href = url;
    a.download = `localvault-plain-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMsg({ kind: 'ok', text: `已导出 ${res.data.rows.length} 条明文记录。用完请立刻删除文件（并清空回收站）。` });
  };

  const doImport = async () => {
    if (!importFile) { setMsg({ kind: 'err', text: '先选择备份文件' }); return; }
    if (!importPwd) { setMsg({ kind: 'err', text: '输入这个备份文件的主密码' }); return; }
    setBusy(true); setMsg(null);
    let envelope: unknown;
    try {
      envelope = JSON.parse(importFile);
    } catch {
      setBusy(false);
      setMsg({ kind: 'err', text: '文件不是合法的 JSON' });
      return;
    }
    const res = await send('import-envelope', { envelope, verifyPassword: importPwd });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: 'err', text: res.code === 'wrong-password' ? '主密码不对，或文件已损坏' : res.message });
      return;
    }
    setImportPwd(''); setImportFile(null);
    setMsg({ kind: 'ok', text: '导入完成，当前保险库已被这份备份覆盖' });
    void refresh();
  };

  const toggleRemember = async (enabled: boolean) => {
    const res = await send('set-remember', { enabled });
    if (!res.ok) { setMsg({ kind: 'err', text: res.message }); return; }
    setMsg({ kind: 'ok', text: enabled ? '已开启：浏览器启动后自动解锁' : '已关闭：每次启动都要输主密码' });
    void refresh();
  };

  const host = diag?.host;
  const hostOk = !!host && isHostInfo(host);
  const st = diag ? stateLabel(diag.state) : { text: '读取中', cls: '' };

  return (
    <div className="wrap">
      <div className="head">
        <div className="logo">
          <svg viewBox="0 0 24 24" style={{ width: 20, height: 20 }} aria-hidden="true">
            <path d="M12 2 4.5 5.2v5.6c0 4.4 3.1 8.4 7.5 9.6 4.4-1.2 7.5-5.2 7.5-9.6V5.2L12 2Z"
              fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M8.8 12.1 11 14.3l4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div className="title">LocalVault 设置与诊断</div>
          <div className="sub">密码只在本机；这一页不联网</div>
        </div>
        <span className={'pill ' + st.cls}><span className="dot" />{st.text}</span>
      </div>

      {hostMissing && (
        <div className="card">
          <h2>连接不上本地助手</h2>
          {host && !isHostInfo(host) && host.error && (
            <div className="msg err">host 返回：{host.error}（若是 “unknown op”，说明装的是旧版 host，重跑安装脚本即可）</div>
          )}
          <div className="hint">
            扩展需要本机的 <code>vault-host.exe</code> 才能读写保险库。按顺序试：
          </div>
          <ol className="hint" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
            <li>运行仓库里的 <code>installer\install.cmd</code>（或用安装包里的）</li>
            <li>完全退出浏览器（不是关窗口，是退出进程）再打开</li>
            <li>仍不行就跑 <code>installer\diagnose.cmd</code> 看报告</li>
          </ol>
          <div className="acts"><button onClick={() => void refresh()}>重新检测</button></div>
        </div>
      )}

      <div className="card">
        <h2>保险库</h2>
        <div className="row"><div className="k">条目数</div><div className="v">{diag?.entryCount ?? '（锁定中，解锁后可见）'}</div></div>
        <div className="row"><div className="k">文件路径</div><div className="v">{hostOk ? host.vaultPath : '—'}</div></div>
        <div className="row"><div className="k">大小</div><div className="v">{hostOk ? fmtBytes(host.bytes) : '—'}</div></div>
        <div className="row"><div className="k">修订号（revision）</div><div className="v">{hostOk ? host.revision : '—'}</div></div>
        <div className="row"><div className="k">最后写入</div><div className="v">{hostOk ? fmtTime(host.updatedAt) : '—'}</div></div>
        <div className="row">
          <div className="k">目录可写</div>
          <div className="v">
            {hostOk
              ? (host.writable
                ? <span className="pill ok"><span className="dot" />可写，剩余 {fmtBytes(host.freeBytes)}</span>
                : <span className="pill bad"><span className="dot" />不可写：{host.writeError ?? '只读或权限不足'}</span>)
              : '—'}
          </div>
        </div>
        <div className="row"><div className="k">本地助手版本</div><div className="v">{hostOk ? host.version : '未连接'}</div></div>
        {hostOk && host.recoveredFromBackup && (
          <div className="msg err">注意：上次是从 <code>.bak</code> 备份恢复的，说明主文件曾损坏。建议现在导出一次备份。</div>
        )}
      </div>

      <div className="card">
        <h2>备份（{hostOk ? host.backupCount : '—'}）</h2>
        {hostOk && host.backups.length > 0 ? (
          <table>
            <thead><tr><th>文件</th><th>时间</th><th style={{ textAlign: 'right' }}>大小</th></tr></thead>
            <tbody>
              {host.backups.slice(0, 5).map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{fmtTime(b.utc)}</td>
                  <td className="num">{fmtBytes(b.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="hint">还没有每日备份（第一次写入保险库后才会生成）。</div>
        )}
        <div className="acts">
          <button className="primary" disabled={busy || !hostOk} onClick={() => void doExport()}>
            {busy ? '处理中…' : '导出加密备份'}
          </button>
          <button onClick={() => void refresh()}>刷新</button>
        </div>
        <div className="hint">备份文件是整份密文，可以用同一个主密码在任意一台电脑上导入恢复。</div>
      </div>

      <div className="card">
        <h2>导出明文（危险）</h2>
        <div className="hint" style={{ marginTop: 0 }}>
          导出的 CSV 里密码是<strong>明文</strong>，拿到文件的任何人都能直接读。
          只用于迁移到别的密码管理器，或做纸质备份。
        </div>
        <label className="toggle" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={plainAck}
            onChange={(e) => setPlainAck(e.target.checked)}
            disabled={diag?.state !== 'unlocked'}
          />
          我明白这会把全部密码以明文写进文件
        </label>
        <div className="acts">
          <button
            className="primary"
            disabled={!plainAck || plainBusy || diag?.state !== 'unlocked'}
            onClick={() => void doExportPlain()}
          >
            {plainBusy ? '导出中…' : '导出明文 CSV'}
          </button>
        </div>
        <div className="hint">
          建议：导入目标工具后立即删除该文件，并清空回收站（Windows 的删除只是移进回收站）。
        </div>
      </div>

      <div className="card">
        <h2>从备份恢复</h2>
        <div className="hint" style={{ marginTop: 0 }}>
          导入会<strong>覆盖当前保险库</strong>。文件必须是用它自己的主密码加密的。
        </div>
        <div className="acts" style={{ alignItems: 'center' }}>
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setImportFile(f ? await f.text() : null);
              setMsg(null);
            }}
          />
          <input
            type="password"
            placeholder="该备份的主密码"
            value={importPwd}
            onChange={(e) => setImportPwd(e.target.value)}
            style={{ width: 180 }}
          />
          <button disabled={busy || !importFile || !importPwd} onClick={() => void doImport()}>
            {busy ? '导入中…' : '导入并覆盖'}
          </button>
        </div>
        <div className="hint">{importFile ? '已读取文件，等待校验' : '只接受本工具导出的 .json 备份文件'}</div>
      </div>

      <div className="card">
        <h2>安全选项</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={!!diag?.rememberEnabled}
            onChange={(e) => void toggleRemember(e.target.checked)}
            disabled={diag?.state !== 'unlocked'}
          />
          记住解锁（浏览器启动后自动解锁）
        </label>
        <div className="hint">
          开启后会把解密密钥存在本机存储里：安全边界从「主密码」降为「Windows 登录」。
          共用电脑不建议开。手动锁定或空闲锁定时会自动清除。
        </div>

        <div style={{ borderTop: '1px solid var(--line)', margin: '12px 0' }} />

        <div style={{ fontWeight: 650, fontSize: 12.5, marginBottom: 4 }}>加密程度</div>
        <div className="hint" style={{ marginTop: 0 }}>
          三档都保证：条目逐条 AES-256-GCM 加密、磁盘上永远没有明文、抗离线暴力破解（Argon2id）。
          区别只在「额外那层本机钥匙壳」怎么处理。
        </div>
        {([
          { id: 'host', name: '标准（推荐）', desc:
            '解锁后把钥匙经本机 DPAPI 包裹写进会话槽：后台进程被回收后不用重输主密码。槽只在本机、只有当前 Windows 用户解得开。' },
          { id: 'none', name: '仅主密码', desc:
            '不写会话槽：后台进程每次重启都要重新输主密码。适合经常把备份文件带到别的电脑的人。' },
          { id: 'strict', name: '最严', desc:
            '不写会话槽 + 空闲后立刻清空内存钥匙：磁盘与内存暴露都最小，代价是后台被回收后要重输主密码。' },
        ] as const).map((opt) => (
          <label key={opt.id} className="toggle" style={{ alignItems: 'flex-start', marginTop: 8 }}>
            <input
              type="radio"
              name="export-mode"
              checked={exportMode === opt.id}
              onChange={() => void setMode(opt.id)}
              disabled={diag?.state !== 'unlocked' || exportBusy}
              style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{opt.name}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--sub)', whiteSpace: 'normal' }}>{opt.desc}</span>
            </span>
          </label>
        ))}
        <div style={{ borderTop: '1px solid var(--line)', margin: '14px 0 10px' }} />

        <div style={{ fontWeight: 650, fontSize: 12.5, marginBottom: 4 }}>Windows Hello 解锁</div>
        <div className="hint" style={{ marginTop: 0 }}>
          开启后，钥匙交给一把「每次使用都要确认」的系统密钥：开启时弹一次确认框，之后每次用它解锁再确认一次
          （配了指纹/PIN 的机器要验一次）。如果这台电脑不强制确认，程序会拒绝开启，不会给你一个假开关。
        </div>
        <label className="toggle" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={tpmEnabled}
            disabled={diag?.state !== 'unlocked' || tpmBusy || tpmSupported === false}
            onChange={(e) => void setHello(e.target.checked)}
          />
          {tpmBusy ? '处理中…（可能会弹系统确认框）' : '启用 Windows Hello 解锁'}
        </label>
        {tpmSupported === false && (
          <div className="hint">本机没有可用的密钥保护提供程序，这一项不可开启。</div>
        )}
        {tpmEnabled && (
          <div className="hint">
            当前密钥位置：{tpmMethod === 'tpm' ? 'TPM 硬件' : tpmMethod === 'software' ? '软件密钥存储（仍绑定当前用户）' : '—'}。
            主密码仍可随时解锁。
          </div>
        )}
      </div>

      {msg && <div className={'msg ' + msg.kind}>{msg.text}</div>}

      <div className="hint" style={{ textAlign: 'center', marginTop: 20 }}>
        {hostOk ? <>数据目录 {host.root} · 日志 {host.logPath}</> : '本机数据不会上传到任何地方'}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
