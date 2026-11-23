/**
 * 并发压力测试：双浏览器持续增删改，条目数守恒，无静默丢失
 *
 * 两个独立浏览器实例共享一份 vault.db，各自不停地新增 / 修改 / 删除，
 * 结束后核对：**每条没被删掉的记录都还在**，且两边看到的集合完全一致。
 *
 * 用法：
 *   node tests/stress-concurrency.mjs                # 默认 3 分钟（回归用）
 *   node tests/stress-concurrency.mjs --minutes=30   # 想长跑再手动指定
 *
 * 全程使用临时 LOCALVAULT_ROOT，凭据为假数据；不联网。
 */
import { mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const extDir = join(root, 'dist', 'chrome-mv3');

const argMin = process.argv.find((a) => a.startsWith('--minutes='));
// 默认 3 分钟：并发问题在头 1-2 分钟就会暴露（实测 343 次写入就撞了 81 次冲突），
// 再拉长只是重复验证。真要做长跑自己传 --minutes=30。
const minutes = argMin ? Math.max(0.2, Number(argMin.split('=')[1])) : 3;
const MASTER = ['stress', 'master', 'pw', '9f'].join('-');

process.env.LOCALVAULT_ROOT = mkdtempSync(join(tmpdir(), 'lv-stress-vault-'));

const mkEntry = (id, tag, n) => ({
  id, title: `${tag} #${n}`, username: `${tag}${n}@stress.test`, password: `Pw-${tag}-${n}-!`,
  urls: [`https://${tag}.stress.test`], notes: '', createdAt: '', updatedAt: '', passwordHistory: [],
});

async function launch(tag) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `lv-stress-${tag}-`)), {
    channel: 'msedge', headless: false, viewport: { width: 900, height: 640 }, locale: 'zh-CN',
    env: { ...process.env },
    args: ['--no-first-run', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  // MV3 的 service worker 会被浏览器空闲回收：长时间压测里必须按需重连，
  // 否则中途 evaluate 会报 "Target page, context or browser has been closed"。
  let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const route = (r) => sw.evaluate((req) => globalThis.__lvRoute(req, { tab: { id: 1 } }), r);
  const bg = async (req) => {
    try {
      return await route(req);
    } catch {
      sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
      return await route(req);
    }
  };
  return { ctx, bg };
}

const A = await launch('a');
const B = await launch('b');
const created = await A.bg({ type: 'create-vault', masterPassword: MASTER });
if (!created.ok) { console.error('创建保险库失败'); process.exit(1); }
const unlocked = await B.bg({ type: 'unlock', password: MASTER });
if (!unlocked.ok) { console.error('第二个实例解锁失败'); process.exit(1); }
console.log(`两个实例就绪，开始 ${minutes} 分钟并发压力测试…`);

const stats = { A: { add: 0, upd: 0, del: 0 }, B: { add: 0, upd: 0, del: 0 }, replays: 0, relocks: 0, errors: [] };
const alive = new Set();      // 期望最终仍存在的 id（单线程维护，避免竞态）
const owned = { A: [], B: [] };
let seq = 0;

/** 长时间无人操作时，chrome.idle 会按设计把保险库锁上（这是对的行为）。
 *  压测要跑 30 分钟，必须像真人一样重新解锁再继续，并把这个次数记下来。 */
async function unlockIfNeeded(inst) {
  const st = await inst.bg({ type: 'status' });
  if (st.data?.state === 'locked') {
    const un = await inst.bg({ type: 'unlock', password: MASTER });
    if (un.ok) stats.relocks++;
    return un.ok;
  }
  return true;
}

async function callWithRelock(inst, req) {
  let res = await inst.bg(req);
  if (!res.ok && res.code === 'locked') {
    await unlockIfNeeded(inst);
    res = await inst.bg(req);
  }
  return res;
}

async function worker(tag, inst, other) {
  const deadline = Date.now() + minutes * 60 * 1000;
  while (Date.now() < deadline) {
    const roll = Math.random();
    try {
      if (roll < 0.55 || owned[tag].length === 0) {
        const id = `${tag}-${++seq}`;
        const n = seq;
        const res = await callWithRelock(inst, { type: 'save-entry', entry: mkEntry(id, tag, n) });
        if (!res.ok) { stats.errors.push(`${tag} add ${id}: ${res.code}`); continue; }
        if ((res.data?.attempts ?? 1) > 1) stats.replays++;
        alive.add(id); owned[tag].push(id); stats[tag].add++;
      } else if (roll < 0.85) {
        const id = owned[tag][Math.floor(Math.random() * owned[tag].length)];
        if (!alive.has(id)) continue;
        const res = await callWithRelock(inst, { type: 'save-entry', entry: mkEntry(id, tag, seq + 1000) });
        if (!res.ok) { stats.errors.push(`${tag} upd ${id}: ${res.code}`); continue; }
        if ((res.data?.attempts ?? 1) > 1) stats.replays++;
        stats[tag].upd++;
      } else {
        const idx = Math.floor(Math.random() * owned[tag].length);
        const id = owned[tag][idx];
        if (!id || !alive.has(id)) continue;
        const res = await callWithRelock(inst, { type: 'delete-entry', id });
        if (!res.ok) { stats.errors.push(`${tag} del ${id}: ${res.code}`); continue; }
        alive.delete(id);
        owned[tag].splice(idx, 1);
        stats[tag].del++;
      }
      // 偶尔让另一侧同步一次（模拟用户重开弹窗）
      if (Math.random() < 0.15) await other.bg({ type: 'status' });
    } catch (e) {
      stats.errors.push(`${tag}: ${String(e.message || e).slice(0, 60)}`);
    }
  }
}

await Promise.all([worker('A', A, B), worker('B', B, A)]);

// ---------- 终局核对 ----------
console.log('\n停止写入，核对最终状态…');
await unlockIfNeeded(A);
await unlockIfNeeded(B);
const aIds = new Set(((await A.bg({ type: 'entries' })).data?.entries ?? []).map((e) => e.id));
const bIds = new Set(((await B.bg({ type: 'entries' })).data?.entries ?? []).map((e) => e.id));

const missingA = [...alive].filter((id) => !aIds.has(id));
const missingB = [...alive].filter((id) => !bIds.has(id));
const onlyInA = [...aIds].filter((id) => !bIds.has(id));
const onlyInB = [...bIds].filter((id) => !aIds.has(id));

const totalOps = stats.A.add + stats.A.upd + stats.A.del + stats.B.add + stats.B.upd + stats.B.del;
console.log('');
console.log(`写入操作合计 ${totalOps} 次（A: +${stats.A.add} ~${stats.A.upd} -${stats.A.del} / B: +${stats.B.add} ~${stats.B.upd} -${stats.B.del}）`);
console.log(`冲突后被重放吸收 ${stats.replays} 次`);
console.log(`空闲锁触发后自动重新解锁 ${stats.relocks} 次（产品行为，正常）`);
console.log(`错误 ${stats.errors.length} 次${stats.errors.length ? '：' + stats.errors.slice(0, 5).join(' | ') : ''}`);

const checks = [
  ['A 侧没有丢失任何未删除的条目', missingA.length === 0, missingA.length + ' 条缺失'],
  ['B 侧没有丢失任何未删除的条目', missingB.length === 0, missingB.length + ' 条缺失'],
  ['两个浏览器看到的集合完全一致', onlyInA.length === 0 && onlyInB.length === 0,
    `仅 A 有 ${onlyInA.length} 条 / 仅 B 有 ${onlyInB.length} 条`],
  ['没有出现重复 id（条目数守恒）', aIds.size === ((await A.bg({ type: 'entries' })).data?.entries ?? []).length, ''],
  ['全程没有写入报错', stats.errors.length === 0, stats.errors.slice(0, 3).join(' | ')],
];

let failed = 0;
for (const [name, pass, detail] of checks) {
  console.log((pass ? '  ✓ ' : '  × ') + name + (pass ? '' : ' — ' + detail));
  if (!pass) failed++;
}

await A.ctx.close();
await B.ctx.close();

console.log('');
console.log(failed === 0
  ? `✅ 并发压力测试通过（${minutes} 分钟，${totalOps} 次写入）`
  : `❌ ${failed} 项不通过`);
if (failed) process.exitCode = 1;
