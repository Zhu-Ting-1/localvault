/**
 * 双浏览器并发
 *
 * 两个**独立的浏览器实例**（各自 profile、各自扩展进程）指向同一个保险库根目录，
 * 也就是同一份 vault.db —— 等价于「Chrome 与 Edge 同时开着」。
 *
 * 验证：
 *   1. A 新增条目 → B 重开弹窗（status）后可见；
 *   2. A、B 同时新增不同条目 → 两条都在；
 *   3. A、B 同时改同一条 → 后写生效，被覆盖的密码进历史（不静默丢失）。
 *
 * 全程使用临时 LOCALVAULT_ROOT，绝不碰真实保险库；凭据为假数据。
 */
import { mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extDir = join(root, 'dist', 'chrome-mv3');

const MASTER = ['dual', 'browser', 'master', 'pw'].join('-');
const vaultRoot = mkdtempSync(join(tmpdir(), 'lv-dual-vault-'));
process.env.LOCALVAULT_ROOT = vaultRoot; // 两个实例继承同一 root

let passed = 0; const failures = [];
const ok = (c, m, d) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failures.push(m); console.log('  × ' + m + (d ? ' — ' + d : '')); } };

async function launch(tag) {
  const profile = mkdtempSync(join(tmpdir(), 'lv-dual-' + tag + '-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: false,
    viewport: { width: 1100, height: 760 },
    locale: 'zh-CN',
    env: { ...process.env },
    args: ['--no-first-run', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const getSw = async () => {
    // MV3 SW 会被回收；打到死 SW 上 evaluate 会抛。重取当前活跃的那个。
    const cur = ctx.serviceWorkers().at(-1);
    if (cur) sw = cur;
    return sw;
  };
  const bg = async (req) => {
    for (let i = 0; i < 2; i++) {
      try {
        const w = await getSw();
        return await w.evaluate(async (r) => {
          try { return await globalThis.__lvRoute(r, { tab: { id: 1 } }); }
          catch (e) { return { ok: false, code: 'sw-throw', message: String(e?.message ?? e), stack: String(e?.stack ?? '').split('\n').slice(0, 4).join(' | ') }; }
        }, req);
      } catch (e) {
        if (i === 1) return { ok: false, code: 'sw-dead', message: String(e?.message ?? e) };
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  };
  return { ctx, bg };
}

const entry = (id, username, password) => ({
  id, title: '站点 ' + id, username, password,
  urls: ['https://' + id + '.test'], notes: '',
  createdAt: '', updatedAt: '', passwordHistory: [],
});

console.log('保险库根目录: ' + vaultRoot);
console.log('\n[setup] 启动两个浏览器实例（同一份 vault.db）');
const A = await launch('a');
const B = await launch('b');
console.log('  两个实例已就绪');

// A 建库并写第一条
const created = await A.bg({ type: 'create-vault', masterPassword: MASTER });
ok(created.ok === true, 'A 创建保险库');
await A.bg({ type: 'save-entry', entry: entry('one', 'a-one@test.local', 'PassOne-1!') });

// ---------- 另一浏览器重开弹窗后可见 ----------
console.log('\n[case] A 写入，B 可见');
{
  const st = await B.bg({ type: 'status' });
  console.log('    [diag] B status:', JSON.stringify(st.data));
  ok(st.ok && st.data.state === 'locked', 'B 首次看到的是「已锁定」（同库、未解锁）');
  await B.bg({ type: 'status' });
  const un = await B.bg({ type: 'unlock', password: MASTER });
  if (!un.ok) console.log('    [diag] B unlock err:', JSON.stringify(un));
  ok(un.ok === true, 'B 用同一主密码解锁同一个库', JSON.stringify(un).slice(0, 160));
  const list = await B.bg({ type: 'entries' });
  const found = (list.data?.entries ?? []).find((e) => e.id === 'one');
  ok(!!found && found.username === 'a-one@test.local', 'B 解到 A 写的条目');

  // A 再写一条，B 只调 status（= 重开弹窗）就应该同步过来
  await A.bg({ type: 'save-entry', entry: entry('two', 'a-two@test.local', 'PassTwo-2!') });
  await B.bg({ type: 'status' });
  const list2 = await B.bg({ type: 'entries' });
  ok((list2.data?.entries ?? []).some((e) => e.id === 'two'), 'A 新增后，B 重开弹窗即可见（无需重启浏览器）');
}

// ---------- 同时新增不同条目 ----------
console.log('\n[case] 同时新增不同条目');
{
  const [r1, r2] = await Promise.all([
    A.bg({ type: 'save-entry', entry: entry('fromA', 'a@test.local', 'PassA-111!') }),
    B.bg({ type: 'save-entry', entry: entry('fromB', 'b@test.local', 'PassB-222!') }),
  ]);
  ok(r1.ok && r2.ok, '两侧写入都返回成功', JSON.stringify([r1.code, r2.code]));

  await A.bg({ type: 'status' });
  await B.bg({ type: 'status' });
  const aIds = ((await A.bg({ type: 'entries' })).data?.entries ?? []).map((e) => e.id).sort();
  const bIds = ((await B.bg({ type: 'entries' })).data?.entries ?? []).map((e) => e.id).sort();
  ok(aIds.includes('fromA') && aIds.includes('fromB'), 'A 侧两条都在', aIds.join(','));
  ok(bIds.includes('fromA') && bIds.includes('fromB'), 'B 侧两条都在', bIds.join(','));
}

// ---------- 同时改同一条，后写生效 ----------
console.log('\n[case] 同时改同一条');
{
  const target = entry('shared', 'shared@test.local', 'Origin-000!');
  await A.bg({ type: 'save-entry', entry: target });
  await B.bg({ type: 'status' });

  const [x, y] = await Promise.all([
    A.bg({ type: 'save-entry', entry: { ...target, password: 'Change-AAA!' } }),
    B.bg({ type: 'save-entry', entry: { ...target, password: 'Change-BBB!' } }),
  ]);
  ok(x.ok && y.ok, '两条并发修改都成功（冲突已被重放消化）', JSON.stringify([x.code, y.code]));

  await A.bg({ type: 'status' });
  const list = await A.bg({ type: 'entries' });
  const e = (list.data?.entries ?? []).find((it) => it.id === 'shared');
  ok(!!e, '条目仍在（没有被并发写搞丢）');
  // v2：最终态（密码+历史）走 get-entry-secret；entries 只有 head
  const fin = await A.bg({ type: 'get-entry-secret', id: 'shared' });
  ok(fin.ok && ['Change-AAA!', 'Change-BBB!'].includes(fin.data.password), '最终密码是其中一次写入（后写生效）', fin.data?.password);
  const hist = (fin.data?.passwordHistory ?? []).map((h) => h.password);
  ok(hist.includes('Origin-000!'), '原始密码进了历史（没被静默丢弃）', JSON.stringify(hist));
  ok(hist.length >= 1, '历史里有被覆盖的那次改动');
}

await A.ctx.close();
await B.ctx.close();

console.log('\n' + (failures.length === 0
  ? '✅ 双浏览器并发：' + passed + ' 项全部通过'
  : '❌ ' + failures.length + ' 项失败，' + passed + ' 项通过'));
if (failures.length) process.exitCode = 1;
