// 管理后台单页 HTML（内嵌在 host 里 serve）。
// 独立于扩展 UI：单文件、原生 JS、无构建步骤。视觉沿用「玻璃轻蓝」。
// 功能：解锁 → 条目列表（含站点中文名/描述）→ 查看/编辑/新增/删除 → 设置（加密程度/记住解锁）→ 审计日志
using System;

internal static partial class VaultHost
{
    // 注意：C# 字符串里不能有未转义的 " 冲突——HTML 用单引号属性 + JS 模板字符串。
    internal static string Page = @"<!doctype html>
<html lang='zh-CN'>
<head>
<meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>LocalVault 管理后台</title>
<link rel='icon' type='image/svg+xml' href='/favicon.svg'>
<style>
  :root { --bg:#eef3f8; --card:rgba(255,255,255,.86); --line:rgba(20,90,170,.12);
          --sub:#71839a; --ink:#16202e; --accent:#2f95ff; --ok:#1a9e5c; --err:#d4452c; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:linear-gradient(160deg,#e8f0f9,#f4f7fb 55%,#eef3f8);
         color:var(--ink); font:14px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',system-ui,sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--sub); font-size: 12px; margin-bottom: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
          padding: 16px 18px; margin-bottom: 16px;
          box-shadow: 0 10px 26px rgba(30,90,170,.10); backdrop-filter: blur(14px); }
  h2 { font-size: 13.5px; margin: 0 0 10px; }
  input, select, textarea { width: 100%; padding: 9px 11px; border: 1px solid var(--line);
         border-radius: 9px; background: rgba(255,255,255,.9); font: inherit; color: var(--ink); }
  button { padding: 8px 14px; border: 1px solid var(--line); border-radius: 9px;
           background: rgba(255,255,255,.85); cursor: pointer; font: inherit; }
  button.primary { background: var(--ink); color: #fff; border-color: var(--ink); }
  button.danger { color: var(--err); border-color: rgba(212,69,44,.4); }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 8px; align-items: center; }
  .entry { display: flex; align-items: center; gap: 12px; padding: 10px 0;
           border-bottom: 1px solid var(--line); }
  .entry:last-child { border-bottom: 0; }
  .favicon { width: 32px; height: 32px; border-radius: 8px; background: #fff;
             border: 1px solid var(--line); flex: none; display: flex; align-items: center;
             justify-content: center; font-size: 15px; }
  .meta { flex: 1; min-width: 0; }
  .meta .site { font-weight: 600; font-size: 13.5px; }
  .meta .site .zh { color: var(--accent); margin-left: 6px; font-weight: 650; }
  .meta .url { font-size: 11.5px; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta .user { font-size: 12px; color: var(--ink); opacity: .8; }
  .msg { padding: 8px 12px; border-radius: 9px; margin: 10px 0; font-size: 12.5px; display: none; }
  .msg.ok { display: block; background: rgba(26,158,92,.12); color: var(--ok); }
  .msg.err { display: block; background: rgba(212,69,44,.10); color: var(--err); }
  .hint { font-size: 11.5px; color: var(--sub); margin-top: 6px; }
  .log { font: 11.5px/1.7 Consolas,monospace; max-height: 320px; overflow: auto;
         background: rgba(22,32,46,.04); border-radius: 8px; padding: 10px; white-space: pre-wrap; }
  .tag { font-size: 10.5px; padding: 1px 7px; border-radius: 20px; border: 1px solid var(--line);
         color: var(--sub); margin-left: 6px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 14px; }
  .tabs button { border-radius: 20px; padding: 6px 14px; }
  .tabs button.on { background: var(--ink); color: #fff; border-color: var(--ink); }
  label { display: block; font-size: 12px; color: var(--sub); margin: 10px 0 4px; }
  dialog { border: 0; border-radius: 14px; box-shadow: 0 24px 60px rgba(20,40,70,.25);
           padding: 18px; width: 420px; max-width: 92vw; }
  dialog::backdrop { background: rgba(20,40,70,.25); backdrop-filter: blur(3px); }
  .pw { font-family: Consolas,monospace; letter-spacing: .5px; }
  .statsgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:8px; margin-top:10px; }
  .statcard { background:rgba(47,149,255,.06); border:1px solid var(--line); border-radius:10px; padding:9px 11px; }
  .statcard b { display:block; font-size:19px; line-height:1.25; }
  .statcard span { display:block; font-size:11.5px; color:var(--sub); }
  .statcard small { display:block; font-size:10px; color:var(--sub); margin-top:2px; }
  .statcard.wide { grid-column:1 / -1; }
  .statcard.wide b { font-size:12.5px; }
  .logtable { max-height:360px; overflow:auto; font:11.5px/1.5 Consolas,monospace;
              background:rgba(22,32,46,.04); border-radius:8px; padding:6px; }
  .logtable table { border-collapse:collapse; width:100%; }
  .logtable td { padding:3px 6px; border-bottom:1px solid var(--line); vertical-align:top;
                 white-space:pre-wrap; word-break:break-all; }
  .logtable td.ts { color:var(--sub); white-space:nowrap; }
  .logtable td.src { color:var(--accent); white-space:nowrap; }
  .logtable td.act { font-weight:650; white-space:nowrap; }
  /* ---- 设置页：加密档位卡片 + 本机信息键值面板 ---- */
  .mode-card { display:flex; gap:12px; align-items:flex-start; padding:12px 14px;
    border:1px solid var(--line); border-radius:10px; background:rgba(255,255,255,.72);
    cursor:pointer; margin-top:10px; transition:border-color .15s, background .15s; }
  .mode-card:hover { border-color: rgba(47,149,255,.45); }
  .mode-card.on { border-color: var(--accent); background: rgba(47,149,255,.07); }
  .mode-card.off { opacity:.55; cursor:not-allowed; }
  .mode-card input { margin-top:2px; accent-color: var(--accent); width:15px; height:15px; flex:none; }
  .mode-card .mtx { display:block; min-width:0; }
  .mode-card .mt { font-size:13px; font-weight:600; color:var(--ink); }
  .mode-card .mtag { display:inline-block; font-size:10px; padding:1px 8px; border-radius:99px;
    margin-left:8px; background:rgba(47,149,255,.12); color:var(--accent); vertical-align:1px; }
  .mode-card .md { font-size:11.5px; color:var(--sub); margin-top:3px; line-height:1.55; }
  .kvlist .kvrow { display:flex; gap:12px; padding:7px 0; border-bottom:1px dashed var(--line); font-size:12px; }
  .kvlist .kvrow:last-child { border-bottom:0; }
  .kvlist .kvk { flex:none; width:110px; color:var(--sub); }
  .kvlist .kvv { color:var(--ink); word-break:break-all; }

  /* ---- 审计日志：筛选栏 / 数据表 / 分页 / 日分布 ---- */
  .scope { font-size:11.5px; color:var(--sub); padding:2px 9px; border-radius:99px;
           border:1px solid var(--line); background:rgba(255,255,255,.72); margin-right:8px; }
  .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-top:12px; }
  .fld { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--sub); margin:0; }
  .fld input, .fld select { padding:7px 9px; font-size:12px; }
  .fld input[type=date] { width:136px; }
  .fld select { width:132px; }
  .fld.q { flex:1 1 220px; }
  .fld.q input { width:100%; }
  .presets { display:flex; gap:4px; }
  .presets button { padding:7px 11px; font-size:11.5px; border-radius:8px; }
  .presets button.on { background:rgba(47,149,255,.12); border-color:var(--accent); color:var(--accent); }
  .chk { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--sub);
         margin:0; padding-bottom:7px; }
  .chk input { width:14px; height:14px; accent-color:var(--accent); }
  .datatable { margin-top:10px; border:1px solid var(--line); border-radius:10px;
               overflow:hidden; background:rgba(255,255,255,.6); }
  .datatable .scroll { max-height:460px; overflow:auto; }
  .datatable table { width:100%; border-collapse:collapse; font-size:12px; }
  .datatable th { position:sticky; top:0; z-index:1; background:#f2f7fd; text-align:left;
    font-size:11px; font-weight:600; color:var(--sub); padding:8px 10px;
    border-bottom:1px solid var(--line); white-space:nowrap; }
  .datatable th.sortable { cursor:pointer; user-select:none; }
  .datatable th.sortable:hover { color:var(--accent); }
  .datatable td { padding:7px 10px; border-bottom:1px solid rgba(20,90,170,.07); vertical-align:top; }
  .datatable tr:last-child td { border-bottom:0; }
  .datatable tbody tr:hover { background:rgba(47,149,255,.05); }
  .datatable td.ts { color:var(--sub); white-space:nowrap; font-variant-numeric:tabular-nums; }
  .datatable td.act { white-space:nowrap; font-weight:600; }
  .badge { display:inline-block; font-size:10.5px; padding:1px 8px; border-radius:99px;
    border:1px solid var(--line); color:var(--sub); background:rgba(22,32,46,.04); }
  .badge.ext { color:var(--accent); border-color:rgba(47,149,255,.3); background:rgba(47,149,255,.10); }
  .badge.host { color:#5c6b7d; background:rgba(22,32,46,.06); }
  .datatable td.act.sens { color:var(--accent); }
  .chips { display:flex; flex-wrap:wrap; gap:4px; }
  .chip { font-size:11px; padding:1px 7px; border-radius:6px; background:rgba(22,32,46,.05);
          color:var(--ink); white-space:nowrap; max-width:100%; overflow:hidden;
          text-overflow:ellipsis; }
  .chip b { color:var(--sub); font-weight:600; margin-right:3px; }
  .chip.fail { background:rgba(212,69,44,.10); color:var(--err); }
  .pager { display:flex; align-items:center; gap:8px; margin-top:10px; font-size:12px; color:var(--sub); }
  .pager button { padding:5px 11px; font-size:12px; }
  .empty { padding:26px 10px; text-align:center; color:var(--sub); font-size:12.5px; }
  .daybars { display:flex; align-items:flex-end; gap:4px; height:46px; margin-top:12px; }
  .daybars .bar { flex:1; min-width:6px; background:rgba(47,149,255,.30);
                  border-radius:3px 3px 0 0; transition:background .15s; }
  .daybars .bar:hover { background:var(--accent); }
</style>
</head>
<body>
<div class='wrap'>
  <h1>LocalVault 管理后台</h1>
  <div class='sub' id='sub'>本机服务 · <span id='hostinfo'></span></div>

  <div id='lockcard' class='card'>
    <h2>解锁保险库</h2>
    <input type='password' id='pw' placeholder='主密码' autofocus>
    <div class='row' style='margin-top:10px'>
      <button class='primary' id='unlockbtn' style='flex:1'>解锁</button>
    </div>
    <div class='msg' id='lockmsg'></div>
    <div class='hint'>后台与浏览器扩展共享同一份保险库和解锁状态。免密解锁（Windows Hello）只在浏览器扩展里提供。</div>
  </div>

  <div id='main' style='display:none'>
    <div class='tabs'>
      <button data-tab='entries' class='on'>条目</button>
      <button data-tab='audit'>审计日志</button>
      <button data-tab='export'>导出</button>
      <button data-tab='settings'>设置</button>
      <span style='flex:1'></span>
      <button id='locknow'>锁定</button>
    </div>

    <div id='tab-entries'>
      <div class='card'>
        <div class='row'>
          <input id='q' placeholder='搜索标题 / 账号 / 网址 / 描述…' style='flex:1'>
          <button id='autonames' style='flex:none'>自动识别名称</button>
          <button class='primary' id='addbtn' style='flex:none'>＋ 新增</button>
        </div>
        <div class='msg' id='autonamesmsg'></div>
      </div>
      <div class='card' id='list'></div>
    </div>

    <div id='tab-audit' style='display:none'>
      <div class='card'>
        <div class='row'>
          <h2 style='flex:1;margin:0'>使用统计</h2>
          <span class='scope' id='auditscope'>全部时间</span>
          <button id='reloadaudit'>刷新</button>
        </div>
        <div id='auditstats' class='statsgrid'></div>
        <div id='auditdays' class='daybars'></div>
        <div class='hint' id='auditdayshint' style='display:none'>柱状图 = 最近 14 个有记录的日子（悬停看日期与条数）。</div>
        <div class='hint'>以上统计只算当前筛选范围；「失败操作」是返回错误的请求数。</div>
      </div>
      <div class='card'>
        <div class='row' style='flex-wrap:wrap;gap:8px'>
          <h2 style='flex:1;margin:0;min-width:140px'>详细日志</h2>
          <button id='auditcsv'>导出筛选结果 CSV</button>
          <button id='rawlog'>下载完整日志</button>
        </div>
        <div class='filters'>
          <label class='fld'>从<input type='date' id='af-from'></label>
          <label class='fld'>到<input type='date' id='af-to'></label>
          <div class='presets'>
            <button data-preset='today'>今天</button>
            <button data-preset='7'>近 7 天</button>
            <button data-preset='30'>近 30 天</button>
            <button data-preset='all' class='on'>全部</button>
          </div>
          <span style='flex:1'></span>
          <label class='fld'>每页<select id='af-size'>
            <option value='50'>50 条</option>
            <option value='100' selected>100 条</option>
            <option value='200'>200 条</option>
          </select></label>
        </div>
        <div class='filters' style='margin-top:8px'>
          <label class='fld'>动作<select id='af-action'>
            <option value=''>全部</option>
            <option value='read-secret'>读取密码</option>
            <option value='fill'>填充</option>
            <option value='upsert'>新增 / 修改</option>
            <option value='delete'>删除</option>
            <option value='site-name'>补全站点名</option>
            <option value='unlock'>解锁</option>
            <option value='lock'>锁定</option>
            <option value='tpm-'>TPM / Hello</option>
            <option value='auto-clear-dek'>空闲自动清零</option>
            <option value='ui:'>后台请求（全部）</option>
          </select></label>
          <label class='fld'>来源<select id='af-source'>
            <option value=''>全部</option>
            <option value='ext'>浏览器扩展</option>
            <option value='ui'>本地后台</option>
            <option value='host'>后台内部</option>
          </select></label>
          <label class='fld q'>关键词<input id='af-q' placeholder='站点 / 账号 / 动作'></label>
          <label class='chk'><input type='checkbox' id='af-routine'> 显示后台轮询流水</label>
          <label class='chk'><input type='checkbox' id='af-fail'> 只看失败（ok=0）</label>
        </div>
        <div id='auditsummary' class='hint' style='margin:10px 0 0'></div>
        <div id='auditrows' class='datatable'></div>
        <div class='pager' id='auditpager'></div>
        <div class='hint'>时间为本机时区；明细按「键=值」分片展示。日志绝不含明文密码，超过 2MB 自动归档为 audit-*.log。</div>
      </div>
    </div>
    <div id='tab-export' style='display:none'>
      <div class='card'>
        <h2>导出与备份</h2>
        <div class='hint' style='margin-top:0'>文件保存到浏览器默认下载目录。明文导出不加密，用完请及时删除。</div>
        <div class='row' style='margin-top:12px;flex-wrap:wrap'>
          <button class='primary' id='exp-encrypted'>下载加密备份（.json）</button>
          <button id='exp-json'>导出明文 JSON</button>
          <button id='exp-csv'>导出 CSV</button>
        </div>
        <div class='msg' id='expmsg'></div>
        <div class='hint'>加密备份与 vault.db 内容一致，导入时用主密码解开；「仅主密码」档换电脑导入最省事。明文导出会逐条读取密码，这些读取都会记进审计日志。</div>
      </div>
    </div>

    <div id='tab-settings' style='display:none'>
      <div class='card'>
        <h2>加密程度</h2>
        <div class='hint' style='margin-top:0'>三档都保证：逐条 AES-256-GCM 加密、磁盘无明文、抗离线暴力破解。区别在「本机钥匙壳」。</div>
        <div id='modes'></div>
      </div>
      <div class='card'>
        <h2>本机信息</h2>
        <div id='diag' class='kvlist'></div>
      </div>
    </div>
  </div>
</div>

<dialog id='dlg'>
  <h2 id='dlgtitle' style='margin-top:0'>编辑条目</h2>
  <label>名称（站点名，可自动识别）</label>
  <div class='row'>
    <input id='f-title' placeholder='如：京东 / GitHub / 招商银行' style='flex:1'>
    <button id='f-autoname' style='flex:none;padding:8px 10px'>自动识别</button>
  </div>
  <label>网址</label>
  <input id='f-urls' placeholder='https://…（多个用空格分隔）'>
  <label>账号</label>
  <input id='f-user'>
  <label>密码</label>
  <input id='f-pass' class='pw'>
  <label>备注</label>
  <textarea id='f-notes' rows='2'></textarea>
  <div class='msg' id='dlgmsg'></div>
  <div class='row' style='margin-top:14px'>
    <button class='primary' id='dlgsave' style='flex:1'>保存</button>
    <button id='dlgcancel'>取消</button>
  </div>
</dialog>

<script src='/argon2.js'></script>
<script>
'use strict';
const $ = (s) => document.querySelector(s);
let STATE = { unlocked: false, entries: [], mode: 'host', tpm: null, editingId: null, audit: { rows: [], stats: {}, text: '', matched: 0, total: 0 } };

// 令牌：由 host 打开的地址带 ?t=…；刷新页面时从 sessionStorage 取回来。
// 读到手就把它从地址栏抹掉，避免留在浏览历史里。
const UI_TOKEN = (() => {
  const q = new URLSearchParams(location.search).get('t');
  if (q) {
    try { sessionStorage.setItem('lv:uiToken', q); } catch { /* 隐私模式 */ }
    try { history.replaceState(null, '', location.pathname); } catch { /* 忽略 */ }
    return q;
  }
  try { return sessionStorage.getItem('lv:uiToken') || ''; } catch { return ''; }
})();

async function api(op, body) {
  const res = await fetch('/api/' + op, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LV-Token': UI_TOKEN },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) {
    return { ok: false, message: '后台会话未授权：请从桌面快捷方式或扩展重新打开本地后台' };
  }
  return res.json();
}

function msg(id, text, kind) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg' + (text ? ' ' + (kind || 'err') : '');
}

// ---------- 解锁：浏览器侧 Argon2id 派生 KEK → 解出 DEK → 交给 host ----------
// 与 app/src/lib/vault.ts 的 openVault 完全同构。主密码与 KEK 都不离开这个页面，
// host 只收到 DEK（和扩展的解锁路径一模一样），因此无需在 host 里实现 Argon2。
function unb64(s) {
  const bin = atob((s || '').replace(/[^A-Za-z0-9+/=]/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function b64(u) {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
const TE = new TextEncoder();
async function importAes(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}
async function gcmDecrypt(key, nonce, ct, aad) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: TE.encode(aad), tagLength: 128 },
    key, ct));
}
async function unlockWithPassword(pw) {
  if (!window.hashwasm || !window.hashwasm.argon2id) throw new Error('Argon2 模块未加载，请刷新页面');
  const r = await api('unlock-info');
  if (!r.ok || !r.data || !r.data.exists) throw new Error('保险库不存在或读取失败');
  const env = r.data;
  if (!env.kdf || env.kdf.alg !== 'argon2id' || !env.authVerify) throw new Error('不支持的保险库格式');
  const kek = new Uint8Array(await window.hashwasm.argon2id({
    password: pw,
    salt: unb64(env.kdf.salt),
    parallelism: env.kdf.parallelism || 1,
    iterations: env.kdf.iterations || 3,
    memorySize: env.kdf.memoryKiB || 65536,
    hashLength: 32,
    outputType: 'binary',
  }));
  const aesKek = await importAes(kek);
  try {
    await gcmDecrypt(aesKek, unb64(env.authVerify.nonce), unb64(env.authVerify.ct), 'localvault-auth/v1');
  } catch { kek.fill(0); throw new Error('主密码错误'); }
  const w = (env.wrappers || []).find((x) => x.id === 'master');
  if (!w) { kek.fill(0); throw new Error('保险库缺少主密码包裹'); }
  let dek;
  try { dek = await gcmDecrypt(aesKek, unb64(w.nonce), unb64(w.ct), 'localvault-wrap/' + w.id); }
  catch { kek.fill(0); throw new Error('无法解出数据密钥（文件可能损坏）'); }
  kek.fill(0);
  const res = await api('unlock', { dek: b64(dek) });
  dek.fill(0);
  if (!res.ok) {
    if (res.error === 'need-migrate') {
      throw new Error('这个保险库还是旧版格式。请先在浏览器扩展里解锁一次（点浏览器工具栏的 LocalVault 图标 → 输入主密码），扩展会自动完成升级；升级完成后再回到这里就能正常使用了。');
    }
    throw new Error(res.message || '解锁失败');
  }
  return res;
}

async function refreshState() {
  const st = await api('status');
  STATE.unlocked = st.ok && st.data && st.data.state === 'unlocked';
  $('#lockcard').style.display = STATE.unlocked ? 'none' : '';
  $('#main').style.display = STATE.unlocked ? '' : 'none';
  $('#hostinfo').textContent = 'v' + (st.data?.version || '?') +
    (st.data?.buildAt ? '（界面 ' + st.data.buildAt + '）' : '') +
    ' · 本机端口 ' + (st.data?.uiPort || '?') +
    (st.data?.vaultPath ? ' · ' + st.data.vaultPath : '');
  if (STATE.unlocked) { await loadEntries(); await loadModes(); }
}

$('#unlockbtn').onclick = async () => {
  const pw = $('#pw').value;
  if (!pw) return;
  msg('#lockmsg', '正在派生密钥…', 'ok');
  try {
    await unlockWithPassword(pw);
    $('#pw').value = '';
    msg('#lockmsg');
    await refreshState();
  } catch (e) {
    msg('#lockmsg', e.message || '解锁失败');
  }
};
$('#pw').addEventListener('keydown', (e) => e.key === 'Enter' && $('#unlockbtn').click());
$('#locknow').onclick = async () => { await api('lock'); STATE.unlocked = false; await refreshState(); };

// ---------- 条目 ----------
const NAME_TRIED = new Set();
async function loadEntries() {
  const r = await api('list');
  STATE.entries = r.ok ? (r.data.entries || []) : [];
  renderList();
  // 名字还是域名/URL 的：自动识别一次并写回（不挡渲染，识别完再刷新一次）
  const pending = STATE.entries.some((e) => {
    const host = hostOf((e.urls || [])[0] || '');
    return host && isHostLike(e.title, host) && !NAME_TRIED.has(e.id);
  });
  if (pending) {
    autoNamePass(false).then(async (n) => {
      if (!n) return;
      await loadEntries();
      msg('#autonamesmsg', '已自动识别 ' + n + ' 个站点名称', 'ok');
    });
  }
}
/** 把「名字 = 域名」的条目换成真实站点名。force=true 时连之前失败过的也重试。 */
async function autoNamePass(force) {
  if (force) NAME_TRIED.clear();
  const targets = STATE.entries.filter((e) => {
    const host = hostOf((e.urls || [])[0] || '');
    if (!host) return false;
    if (!isHostLike(e.title, host)) return false;
    return force ? true : !NAME_TRIED.has(e.id);
  });
  let n = 0;
  for (const e of targets) {
    NAME_TRIED.add(e.id);
    const url = (e.urls || [])[0];
    const info = await recognizeSite(url);
    if (!info || !info.name) continue;
    if (isHostLike(info.name, hostOf(url))) continue;   // 识别出来还是域名，不写
    const r = await api('set-site-name', { id: e.id, name: info.name, description: e.description || '' });
    if (r.ok) n++;
  }
  return n;
}

// 站点中文名：内置常见站点映射 + favicon 服务兜底（f1。Google s2 是公开 favicon 接口，只带域名）
const ZH_SITES = {
  'github.com': 'GitHub 代码托管', 'google.com': '谷歌搜索', 'youtube.com': 'YouTube 视频',
  'jd.com': '京东商城', 'taobao.com': '淘宝', 'tmall.com': '天猫', 'pinduoduo.com': '拼多多',
  'bilibili.com': '哔哩哔哩', 'weibo.com': '微博', 'zhihu.com': '知乎',
  'qq.com': '腾讯 QQ', '163.com': '网易', '126.com': '网易邮箱', 'aliyun.com': '阿里云',
  'baidu.com': '百度', 'douyin.com': '抖音', 'xiaomi.com': '小米', 'mi.com': '小米',
  'apple.com': '苹果', 'microsoft.com': '微软', 'office.com': 'Office 365', 'live.com': '微软账户',
  'ccb.com': '建设银行', 'icbc.com': '工商银行', 'cmbchina.com': '招商银行', 'boc.cn': '中国银行',
  'alipay.com': '支付宝', 'tenpay.com': '财付通', 'cloud.tencent.com': '腾讯云',
  'steamcommunity.com': 'Steam 社区', 'steampowered.com': 'Steam 游戏', 'epicgames.com': 'Epic 游戏',
  'notion.so': 'Notion 笔记', 'figma.com': 'Figma 设计', 'vercel.com': 'Vercel 托管',
  'cloudflare.com': 'Cloudflare', 'amazon.com': '亚马逊', 'netflix.com': '网飞',
  'chat.openai.com': 'ChatGPT', 'openai.com': 'OpenAI', 'anthropic.com': 'Anthropic',
};

function hostOf(url) {
  try { return new URL(url.startsWith('http') ? url : 'https://' + url).hostname; } catch { return url || ''; }
}
function rootDomain(host) {
  const parts = (host || '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1].toLowerCase();
  const sl = parts[parts.length - 2].toLowerCase();
  // 只有 ccTLD 才可能是 co.uk / com.cn 这种两段后缀；.com 的子域不能取三段
  const twoLevel = ['com','org','net','gov','edu','co','ac'];
  if (tld.length === 2 && twoLevel.includes(sl)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
function isHostLike(title, host) {
  const t = (title || '').trim().toLowerCase();
  if (!t) return true;
  if (/^https?:\/\//.test(t)) return true;
  if (/^(?:4\d\d|5\d\d|error|not\s*found|forbidden|access\s*denied|unauthorized|just\s*a\s*moment|attention\s*required|sign\s*in|log\s*in|login|loading|redirecting|页面不存在|页面未找到|访问受限|请登录|登录|错误)/i.test(t)) return true;
  if (!host) return false;
  const h = host.toLowerCase(), root = rootDomain(host).toLowerCase();
  return t === h || t === root || t === 'www.' + root;
}
function isIpHost(host) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(host || ''); }
function prettyHost(host) {
  if (isIpHost(host)) return '';
  const root = rootDomain(host || '');
  const base = (root || '').split('.')[0] || '';
  if (!base) return '';
  return base.length <= 3 ? base.toUpperCase() : base.charAt(0).toUpperCase() + base.slice(1);
}
function siteName(e) {
  const host = hostOf((e.urls && e.urls[0]) || '');
  const root = rootDomain(host);
  if (ZH_SITES[root]) return ZH_SITES[root];
  if (ZH_SITES[host]) return ZH_SITES[host];
  const t = (e.title || '').trim();
  if (t && !isHostLike(t, host)) return t; // 用户自己起的名字优先
  return prettyHost(host) || t || '（无标题）';
}
function isZh(s) { return /[\u4e00-\u9fff]/.test(s || ''); }

function renderList() {
  const q = ($('#q').value || '').toLowerCase();
  const list = STATE.entries.filter((e) => {
    if (!q) return true;
    const zh = siteName(e);
    return [e.title, e.username, (e.urls || []).join(' '), zh].join(' ').toLowerCase().includes(q);
  });
  const el = $('#list');
  if (!list.length) { el.innerHTML = '<div class=""hint"">' + (q ? '没有匹配的条目' : '还没有条目——在浏览器里登录一次网站，点保存浮窗即可入库') + '</div>'; return; }
  el.innerHTML = '';
  for (const e of list) {
    const host = hostOf((e.urls && e.urls[0]) || '');
    const root = rootDomain(host);
    const zh = siteName(e);
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML =
      // favicon 一律本地生成首字母：绝不把条目域名发给任何外部服务
      '<div class=""favicon"">' + escapeHtml(zh[0] || '?') + '</div>' +
      '<div class=""meta"">' +
        '<div class=""site"">' + escapeHtml(zh) + (isZh(zh) ? '' : '') +
          (host ? '<span class=""tag"">' + escapeHtml(host) + '</span>' : '') + '</div>' +
        '<div class=""user"">' + escapeHtml(e.username || '（无账号）') + '</div>' +
        '<div class=""url"">' + escapeHtml((e.urls || []).join(' · ')) + '</div>' +
        (e.description ? '<div class=""url"">' + escapeHtml(e.description) + '</div>' : '') +
      '</div>';
    const copyBtn = document.createElement('button'); copyBtn.textContent = '复制';
    copyBtn.onclick = () => copyEntry(e);
    const show = document.createElement('button'); show.textContent = '查看';
    show.onclick = () => viewSecret(e.id);
    const edit = document.createElement('button'); edit.textContent = '编辑';
    edit.onclick = () => openEdit(e.id);
    const del = document.createElement('button'); del.className = 'danger'; del.textContent = '删除';
    del.onclick = () => removeEntry(e.id, zh);
    div.append(copyBtn, show, edit, del);
    el.appendChild(div);
  }
}
function escapeHtml(s) { return (s || '').replace(/[&<>""']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','""':'&quot;',""'"":'&#39;'}[c])); }
$('#q').addEventListener('input', renderList);

async function viewSecret(id) {
  const r = await api('get-secret', { id });
  const e = STATE.entries.find((x) => x.id === id);
  const zh = e ? siteName(e) : '';
  if (r.ok) {
    alert(zh + '\n\n账号：' + (e?.username || '—') + '\n密码：' + r.data.password + (r.data.notes ? '\n\n备注：' + r.data.notes : ''));
  } else if (r.error === 'locked') { await refreshState(); }
  else alert('读取失败：' + r.message);
}

// ---------- 编辑弹窗 ----------
function openEdit(id) {
  const e = id ? STATE.entries.find((x) => x.id === id) : null;
  STATE.editingId = id || null;
  $('#dlgtitle').textContent = e ? '编辑：' + siteName(e) : '新增条目';
  $('#f-title').value = e?.title || '';
  $('#f-urls').value = (e?.urls || []).join(' ');
  $('#f-pass').value = '';
  $('#f-notes').value = '';
  // 账号要现取（list 里没有）
  if (e) { api('get-secret', { id }).then((r) => {
    $('#f-user').value = r.ok ? (r.data.username ?? e.username) : (e.username || '');
    if (r.ok) $('#f-notes').value = r.data.notes || '';
    if (r.ok && !$('#f-pass').value) $('#f-pass').placeholder = '留空 = 不改';
  }); }
  else $('#f-user').value = '';
  $('#dlgmsg').textContent = '';
  $('#dlg').showModal();
}
$('#addbtn').onclick = () => openEdit(null);
$('#dlgcancel').onclick = () => $('#dlg').close();
$('#dlgsave').onclick = async () => {
  const id = STATE.editingId || ('ui-' + Date.now().toString(36));
  const old = STATE.editingId ? STATE.entries.find((x) => x.id === id) : null;
  const entry = {
    id, title: $('#f-title').value.trim(),
    username: $('#f-user').value.trim(),
    urls: $('#f-urls').value.split(/\s+/).filter(Boolean),
    password: $('#f-pass').value,
    notes: $('#f-notes').value,
    createdAt: old?.createdAt || new Date().toISOString(),
    passwordHistory: [],
  };
  if (!entry.title && entry.urls[0]) {
    msg('#dlgmsg', '正在识别网站…', 'ok');
    const info = await recognizeSite(entry.urls[0]);
    entry.title = info ? info.name : hostOf(entry.urls[0]);
    if (info && info.description && !entry.notes) entry.notes = info.description;
  }
  if (!entry.title) { msg('#dlgmsg', '标题和网址至少填一个'); return; }
  const r = await api('upsert', { entry });
  if (r.ok) { $('#dlg').close(); await loadEntries(); }
  else msg('#dlgmsg', r.message);
};

async function removeEntry(id, zh) {
  if (!confirm('删除「' + zh + '」？密码历史一并删除，不可恢复（除非有备份）。')) return;
  await api('delete', { id });
  await loadEntries();
}

// ---------- 审计日志：筛选 + 数据表 + 分页 ----------
const AUDIT_PAGE = { page: 1, size: 100, sort: 'desc' };
const ACTION_LABEL = {
  'read-secret': '读取密码', 'fill': '填充', 'upsert': '新增 / 修改', 'delete': '删除',
  'unlock': '解锁', 'lock': '锁定', 'site-name': '补全站点名', 'ui-start': '后台启动',
  'auto-clear-dek': '空闲自动清零', 'backup-before-migrate': '迁移前备份',
  'tpm-enable': '开启 Hello 解锁', 'tpm-disable': '关闭 Hello 解锁',
};
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const localDate = (ts) => {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};
const localTime = (ts) => {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts || '');
  return localDate(ts) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
};
const isoDayStart = (s) => new Date(s + 'T00:00:00').toISOString();
const isoDayEnd = (s) => new Date(s + 'T23:59:59.999').toISOString();
function actionLabel(a) {
  const k = a || '';
  if (ACTION_LABEL[k]) return ACTION_LABEL[k];
  if (k.indexOf('ui:') === 0) return '后台 · ' + k.slice(3);
  return k;
}
function ctxText() {
  const from = $('#af-from').value, to = $('#af-to').value;
  if (!from && !to) return '全部时间';
  if (from && to && from === to) return from;
  return (from || '最早') + ' → ' + (to || '至今');
}
async function loadAudit() {
  const body = { lines: 5000 };
  const from = $('#af-from').value, to = $('#af-to').value;
  if (from) body.since = isoDayStart(from);
  if (to) body.until = isoDayEnd(to);
  const act = $('#af-action').value; if (act) body.action = act;
  const src = $('#af-source').value; if (src) body.src = src;
  const q = $('#af-q').value.trim(); if (q) body.q = q;
  if (!$('#af-routine').checked) body.hideRoutine = '1';
  if ($('#af-fail').checked) body.fail = '1';
  const r = await api('audit-tail', body);
  STATE.audit = r.ok ? r.data : { rows: [], stats: {}, text: '', matched: 0, total: 0 };
  AUDIT_PAGE.page = 1;
  $('#auditscope').textContent = ctxText();
  renderStats();
  renderAuditRows();
}
function renderStats() {
  const st = STATE.audit.stats || {};
  const cards = [
    [st.fills || 0, '填充次数', '点了多少次填充按钮'],
    [st.reads || 0, '密码读取', '密码被取出多少次'],
    [st.writes || 0, '新增 / 修改', '条目写入'],
    [st.deletes || 0, '删除', '条目删除'],
    [st.unlocks || 0, '解锁', '解锁次数'],
    [st.fails || 0, '失败操作', '返回错误的请求'],
  ];
  let html = '';
  for (const c of cards) {
    html += '<div class=""statcard""><b>' + c[0] + '</b><span>' + c[1] + '</span><small>' + c[2] + '</small></div>';
  }
  const by = st.bySource || {};
  const srcs = Object.keys(by).map((k) => k + ' x ' + by[k]).join('  ·  ') || '暂无记录';
  const first = st.firstAt ? localTime(st.firstAt) : '—';
  html += '<div class=""statcard wide""><b>来源分布</b><span>' + escapeHtml(srcs) +
    '</span><small>ext = 浏览器扩展　·　ui = 本地后台　·　host = 内部事件　·　最早一条 ' +
    escapeHtml(first) + '</small></div>';
  $('#auditstats').innerHTML = html;
}
function renderDayBars() {
  const counts = {};
  for (const r of (STATE.audit.rows || [])) {
    const d = localDate(r.ts);
    if (d) counts[d] = (counts[d] || 0) + 1;
  }
  const days = Object.keys(counts).sort();
  const el = $('#auditdays');
  $('#auditdayshint').style.display = days.length > 1 ? '' : 'none';
  if (days.length < 2) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  const show = days.slice(-14);
  const max = Math.max.apply(null, show.map((d) => counts[d]));
  el.innerHTML = show.map((d) => {
    const h = Math.max(3, Math.round(counts[d] / max * 42));
    return '<div class=""bar"" style=""height:' + h + 'px"" title=""' + d + ' · ' + counts[d] + ' 条""></div>';
  }).join('');
}
function auditSorted() {
  const rows = (STATE.audit.rows || []).slice();
  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  if (AUDIT_PAGE.sort === 'desc') rows.reverse();
  return rows;
}
function detailChips(detail) {
  const s = String(detail || '').trim();
  if (!s) return '<span class=""chip"">—</span>';
  const toks = [];
  for (const p of s.split(/\s+/)) {
    const i = p.indexOf('=');
    if (i > 0) toks.push([p.slice(0, i), p.slice(i + 1)]);
    else if (toks.length) toks[toks.length - 1][1] += ' ' + p;
    else toks.push(['', p]);
  }
  return '<div class=""chips"">' + toks.map((t) => {
    const fail = (t[0] === 'ok' && t[1] === '0');
    return '<span class=""chip' + (fail ? ' fail' : '') + '"">' +
      (t[0] ? '<b>' + escapeHtml(t[0]) + '</b>' : '') + escapeHtml(t[1]) + '</span>';
  }).join('') + '</div>';
}
function renderAuditRows() {
  const all = auditSorted();
  const size = AUDIT_PAGE.size;
  const pages = Math.max(1, Math.ceil(all.length / size));
  if (AUDIT_PAGE.page > pages) AUDIT_PAGE.page = pages;
  const start = (AUDIT_PAGE.page - 1) * size;
  const page = all.slice(start, start + size);
  const matched = STATE.audit.matched == null ? all.length : STATE.audit.matched;
  $('#auditsummary').textContent = '匹配 ' + matched + ' 条' +
    (matched > all.length ? '（表格仅载入最近 ' + all.length + ' 条）' : '') +
    ' · 日志共 ' + (STATE.audit.total || 0) + ' 行';
  renderDayBars();
  if (!page.length) {
    $('#auditrows').innerHTML = '<div class=""empty"">没有匹配的记录。试试放宽日期范围，或取消「只看失败」。</div>';
    $('#auditpager').innerHTML = '';
    return;
  }
  let h = '<div class=""scroll""><table><thead><tr>' +
    '<th class=""sortable"" data-sort=""1"">时间 ' + (AUDIT_PAGE.sort === 'desc' ? '↓' : '↑') + '</th>' +
    '<th style=""width:84px"">来源</th><th style=""width:150px"">动作</th><th>明细</th></tr></thead><tbody>';
  for (const r of page) {
    const src = r.source || '';
    h += '<tr><td class=""ts"">' + escapeHtml(localTime(r.ts)) + '</td>' +
      '<td><span class=""badge' + (src === 'ext' ? ' ext' : (src === 'host' ? ' host' : '')) + '"">' +
        escapeHtml(src || '—') + '</span></td>' +
      '<td class=""act' + (r.action === 'read-secret' || r.action === 'fill' ? ' sens' : '') + '"">' +
        escapeHtml(actionLabel(r.action)) + '</td>' +
      '<td>' + detailChips(r.detail) + '</td></tr>';
  }
  $('#auditrows').innerHTML = h + '</tbody></table></div>';
  const firstRow = all.length ? start + 1 : 0;
  $('#auditpager').innerHTML =
    '<button data-pg=""prev""' + (AUDIT_PAGE.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
    '<span>第 ' + AUDIT_PAGE.page + ' / ' + pages + ' 页</span>' +
    '<button data-pg=""next""' + (AUDIT_PAGE.page >= pages ? ' disabled' : '') + '>下一页</button>' +
    '<span style=""flex:1""></span>' +
    '<span>显示 ' + firstRow + '-' + (start + page.length) + ' / 共 ' + all.length + ' 条</span>';
}
let auditTimer = null;
const auditSoon = () => { clearTimeout(auditTimer); auditTimer = setTimeout(loadAudit, 250); };
function syncPreset() {
  document.querySelectorAll('.presets button').forEach((b) => b.classList.remove('on'));
}
$('#reloadaudit').onclick = () => loadAudit();
$('#af-from').onchange = () => { syncPreset(); loadAudit(); };
$('#af-to').onchange = () => { syncPreset(); loadAudit(); };
$('#af-action').onchange = () => loadAudit();
$('#af-source').onchange = () => loadAudit();
$('#af-routine').onchange = () => loadAudit();
$('#af-fail').onchange = () => loadAudit();
$('#af-q').oninput = auditSoon;
$('#af-size').onchange = () => {
  AUDIT_PAGE.size = Number($('#af-size').value) || 100;
  AUDIT_PAGE.page = 1;
  renderAuditRows();
};
$('#auditpager').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  AUDIT_PAGE.page += b.dataset.pg === 'next' ? 1 : -1;
  if (AUDIT_PAGE.page < 1) AUDIT_PAGE.page = 1;
  renderAuditRows();
};
$('#auditrows').onclick = (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  AUDIT_PAGE.sort = AUDIT_PAGE.sort === 'desc' ? 'asc' : 'desc';
  renderAuditRows();
};
document.querySelectorAll('.presets button').forEach((b) => {
  b.onclick = () => {
    const p = b.dataset.preset;
    const now = new Date();
    const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (p === 'all') { $('#af-from').value = ''; $('#af-to').value = ''; }
    else if (p === 'today') { $('#af-from').value = ymd(now); $('#af-to').value = ymd(now); }
    else {
      const d0 = new Date(now);
      d0.setDate(d0.getDate() - (Number(p) - 1));
      $('#af-from').value = ymd(d0);
      $('#af-to').value = ymd(now);
    }
    document.querySelectorAll('.presets button').forEach((x) => x.classList.toggle('on', x === b));
    loadAudit();
  };
});
$('#auditcsv').onclick = () => {
  const rows = auditSorted();
  const head = ['时间（本机）', '来源', '动作', '明细'];
  const out = [head.map(csvCell).join(',')];
  for (const r of rows) {
    out.push([localTime(r.ts), r.source || '', actionLabel(r.action), r.detail || ''].map(csvCell).join(','));
  }
  download('localvault-audit-' + stamp() + '.csv', '\ufeff' + out.join('\r\n'), 'text/csv;charset=utf-8');
};
$('#rawlog').onclick = async () => {
  const r = await api('audit-raw');
  if (!r.ok) { alert(r.message || '读取日志失败'); return; }
  download('localvault-audit-full-' + stamp() + '.log', r.data.text || '', 'text/plain;charset=utf-8');
};


// ---------- 复制：账号一行、密码一行 ----------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }
}
async function copyEntry(e) {
  const r = await api('get-secret', { id: e.id });
  if (!r.ok) { msg('#autonamesmsg', '复制失败：' + (r.message || '保险库已锁定'), 'err'); return; }
  const user = String(r.data.username || e.username || '').trim();
  const pass = String(r.data.password || '');
  const text = user && pass ? user + '\n' + pass : (user || pass);
  if (!text) { msg('#autonamesmsg', '这条没有账号和密码', 'err'); return; }
  if (!await copyText(text)) {
    msg('#autonamesmsg', '浏览器拒绝了剪贴板写入，请点「查看」手动复制', 'err');
    return;
  }
  msg('#autonamesmsg', '已复制「' + siteName(e) + '」：账号一行、密码一行（30 秒后自动清空）', 'ok');
  setTimeout(() => { copyText(' '); }, 30000);
}

// ---------- 站点名识别（零联网：内置映射 + 后台「记住的页面标题」）----------
async function recognizeSite(url, title) {
  const r = await api('fetch-site-info', { url, title: title || '' });
  return (r.ok && r.data && r.data.name) ? r.data : null;
}
$('#f-autoname').onclick = async () => {
  const url = $('#f-urls').value.split(/\s+/).filter(Boolean)[0];
  if (!url) { msg('#dlgmsg', '先填网址再识别'); return; }
  msg('#dlgmsg', '正在识别…', 'ok');
  const info = await recognizeSite(url);
  if (info) {
    $('#f-title').value = info.name;
    msg('#dlgmsg', '已识别：' + info.name + '（内置站点库）', 'ok');
  } else msg('#dlgmsg', '内置站点库没收录这个域名，请手动填一个名称（扩展保存时会自动带页面标题）');
};
$('#autonames').onclick = async () => {
  msg('#autonamesmsg', '正在识别站点名称…', 'ok');
  const n = await autoNamePass(true);
  await loadEntries();
  msg('#autonamesmsg', n ? ('已识别并写回 ' + n + ' 个条目') : '没有新的可识别条目（网页打不开，或标题本身就是域名）', n ? 'ok' : 'err');
};

// ---------- 导出 / 备份 ----------
function download(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

$('#exp-encrypted').onclick = async () => {
  const r = await api('export-encrypted');
  if (!r.ok || !r.data || !r.data.ciphertext) { msg('#expmsg', '读取失败：' + (r.message || '保险库不存在')); return; }
  download('localvault-backup-' + stamp() + '.json', r.data.ciphertext, 'application/json;charset=utf-8');
  msg('#expmsg', '已下载加密备份（与 vault.db 内容一致，导入时用主密码解开）', 'ok');
};

async function collectFullEntries() {
  const out = [];
  for (const e of STATE.entries) {
    const r = await api('get-secret', { id: e.id });
    if (!r.ok) continue;
    out.push({
      id: e.id, title: e.title, siteName: siteName(e), username: e.username,
      password: r.data.password, urls: e.urls || [], notes: r.data.notes || '',
      description: e.description || '', createdAt: e.createdAt, updatedAt: e.updatedAt,
    });
  }
  return out;
}
const Q = String.fromCharCode(34);
const csvCell = (v) => {
  let s = String(v == null ? '' : v);
  if (/^[=+@\-]/.test(s)) s = String.fromCharCode(39) + s; // 防 Excel/Sheets 公式注入
  return Q + s.split(Q).join(Q + Q) + Q;
};

$('#exp-json').onclick = async () => {
  msg('#expmsg', '正在逐条读取密码…', 'ok');
  const all = await collectFullEntries();
  download('localvault-plain-' + stamp() + '.json', JSON.stringify(all, null, 2), 'application/json;charset=utf-8');
  msg('#expmsg', '已导出 ' + all.length + ' 条（明文，用完请删除）', 'ok');
};
$('#exp-csv').onclick = async () => {
  msg('#expmsg', '正在逐条读取密码…', 'ok');
  const all = await collectFullEntries();
  const head = ['站点中文名', '标题', '网址', '账号', '密码', '备注', '描述'];
  const lines = [head.map(csvCell).join(',')];
  for (const e of all) {
    lines.push([e.siteName, e.title, (e.urls || []).join(' '), e.username,
      e.password, e.notes, e.description].map(csvCell).join(','));
  }
  download('localvault-plain-' + stamp() + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  msg('#expmsg', '已导出 ' + all.length + ' 条 CSV（明文，用完请删除）', 'ok');
};

// ---------- 设置 ----------
async function loadModes() {
  const st = await api('tpm-status');
  STATE.tpm = st.ok ? st.data : { available: false };
  const m = await api('get-export-mode');
  STATE.mode = m.ok ? m.data.mode : 'host';
  renderModes();
}
function renderModes() {
  const el = $('#modes');
  const opts = [
    ['host', '标准', '推荐', '解锁后把钥匙经本机 DPAPI 包裹写进会话槽：后台进程被浏览器回收后不用重输主密码。槽只在本机、只有当前 Windows 用户解得开。'],
    ['none', '仅主密码', '', '不写会话槽：后台进程每次重启都要重新输主密码。适合经常把备份带到别的电脑导入的人。'],
    ['strict', '最严', '', '不写会话槽，且空闲后立刻清空内存里的钥匙：磁盘与内存暴露都最小；代价是后台被回收后要重输主密码。'],
  ];
  el.innerHTML = '';
  for (const [id, name, tag, desc] of opts) {
    const off = false; // 三档都不依赖 TPM：TPM/Hello 是独立的解锁开关
    const lbl = document.createElement('label');
    lbl.className = 'mode-card' + (STATE.mode === id ? ' on' : '') + (off ? ' off' : '');
    lbl.innerHTML = '<input type=""radio"" name=""mode"" ' + (STATE.mode === id ? 'checked' : '') + (off ? ' disabled' : '') + '>' +
      '<span class=""mtx""><span class=""mt"">' + escapeHtml(name) +
      (tag ? '<span class=""mtag"">' + escapeHtml(tag) + '</span>' : '') + '</span>' +
      '<div class=""md"">' + escapeHtml(desc) + '</div></span>';
    if (!off) {
      lbl.querySelector('input').onchange = async () => {
        const r = await api('set-export-mode', { mode: id });
        if (r.ok) { STATE.mode = id; renderModes(); await refreshState(); } else alert(r.message);
      };
    }
    el.appendChild(lbl);
  }
  renderHostInfo();
}
async function renderHostInfo() {
  const d = await api('status');
  if (!d.ok) return;
  const s = d.data || {};
  const rows = [
    ['本地服务', 'v' + (s.version || '?') + '（协议 v' + s.proto + '）'],
    ['后台地址', 'http://127.0.0.1:' + (s.uiPort || '?') + ' · 仅本机可访问'],
    ['保险库位置', s.vaultPath || '—'],
    ['保险库格式', s.payloadFormat === 'localvault/v2' ? 'v2 · 逐条加密（AAD 绑定）'
      : (s.payloadFormat === 'localvault/v1' ? 'v1 整包 · 需要升级' : '未解锁，暂不可见')],
    ['TPM/Hello 包裹', s.tpmEnabled ? '已开启' : '未开启'],
    ['保险库状态', s.exists ? '正常 · revision ' + s.revision : '尚未创建'],
    ['最近写入', (s.updatedAt || '—').replace('T', ' ').slice(0, 19).replace('Z', ' UTC')],
  ];
  $('#diag').innerHTML = rows.map((r) =>
    '<div class=""kvrow""><span class=""kvk"">' + escapeHtml(r[0]) + '</span>' +
    '<span class=""kvv"">' + escapeHtml(String(r[1])) + '</span></div>').join('');
}

// ---------- 标签页 ----------
document.querySelectorAll('.tabs button[data-tab]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    for (const t of ['entries', 'audit', 'export', 'settings']) $('#tab-' + t).style.display = b.dataset.tab === t ? '' : 'none';
    if (b.dataset.tab === 'audit') loadAudit();
    if (b.dataset.tab === 'settings') loadModes();
  };
});

refreshState();
</script>
</body>
</html>";
}
