import { HostClient, browserSendFn, type ConflictInfo, type HostHead } from '../lib/host';
import {
  createVault, openVault, changeMasterPassword, resetWithRecovery,
  parseEnvelope, type Envelope, type VaultData, type VaultEntry, VaultError,
} from '../lib/vault';
import { decryptWithDek, encryptPayloadWithDek } from '../lib/payload';
import { commitOps, type VaultOp, type VaultStore, type CommitResult } from '../lib/commit';
import { buildPayloadV2, readAllV2, type PayloadV2 } from '../lib/vault-v2';
import * as hv from '../lib/host-vault';
import { isHostLikeTitle } from '../lib/site-name';
import {
  saveUnlockedState, loadSessionEnvelope, loadSessionDek, setCachedData,
  getCachedData, lock, currentLockState, setupIdleLock, setVaultExistsProbe, setLockExecutor,
  markHostUnlocked, markHostLocked, isHostUnlockedFlag,
  getSessionRevision, markUnlocked, isRememberEnabled, shouldAttemptBootRestore,
  recordFailedAttempt, resetFailedAttempts, lockoutRemainingMs,
  setRememberUnlock, getRememberedDek, setRememberHost,
  getIdentities, clearLegacyIdentities,
  getIdleLockMinutes, setIdleLockMinutes,
} from '../lib/session';

const VERSION = '0.3.3';
const host = new HostClient(browserSendFn());
// 会话模块包钥匙必须用这一个客户端：connectNative 每次都拉新进程，新进程里没有 DEK
setRememberHost(host);

/** 「记住解锁」最近一次放钥匙失败的原因（便于界面提示，不含密钥） */
let rememberKeyError: string | null = null;

/** 菜单要用的常用身份。v2 起身份存在保险库里；只有旧版（≤0.2）在 storage.local
 *  留一份，读到就顺手搬进保险库并清掉，避免两套来源各说各话。 */
async function identitiesForFill(): Promise<Array<{ id: string; label: string; value: string }>> {
  const current = await host.getIdentities().catch(() => ({ identities: [] as Array<{ id: string; label: string; value: string }> }));
  if (current.identities.length) return current.identities;
  const legacy = await getIdentities();
  if (!legacy.length) return [];
  try {
    await host.setIdentities(legacy);
    await clearLegacyIdentities();
  } catch { /* 锁定态：先照常返回旧值，解锁后再搬 */ }
  return legacy;
}

export default defineBackground(() => {
  setupIdleLock();
  // v2：解锁态存 storage.session（跨 SW 回收），session 触发的锁定（空闲/锁屏/绝对超时）
  // 也要同步清掉 host 进程的钥匙
  setLockExecutor(async () => {
    await host.hostLock().catch(() => undefined);
    hv.resetState();
  });
  // 磁盘上有没有保险库由 host 说了算（session 重启即清空，不能作为存在性依据）
  setVaultExistsProbe(async () => {
    const r = await host.read().catch(() => null);
    return !!r && parseEnvelope(r.ciphertext) !== null;
  });

  // 闹钟：绝对超时强制上锁 + 到点清空剪贴板里的密码。
  // 用闹钟而不是 setTimeout：service worker 会被回收，定时器跟着死。
  try {
    chrome.alarms?.onAlarm?.addListener((alarm) => {
      if (alarm.name === 'lv:absolute-lock') void lockAll();
      if (alarm.name === 'lv:clip-clear') void clearClipboard();
    });
  } catch { /* 构建期预执行没有 alarms */ }
});

/** 清空剪贴板：SW 没有剪贴板权限，要靠一个 offscreen 文档代劳。 */
async function clearClipboard(): Promise<void> {
  try {
    const off = chrome.offscreen;
    if (!off?.createDocument) return;
    if (!(await off.hasDocument())) {
      await off.createDocument({
        url: 'offscreen.html',
        reasons: [off.Reason.CLIPBOARD],
        justification: '到点清空复制过的密码，避免留在系统剪贴板里',
      });
    }
    await chrome.runtime.sendMessage({ type: 'lv-clear-clipboard' });
    setTimeout(() => { void off.closeDocument().catch(() => undefined); }, 1500);
  } catch { /* 清不掉也不能影响别的功能 */ }
}

// E2E 后门：SW 自发 sendMessage 不会触发自身 onMessage（MV3 行为），
// 自动化测试经 sw.evaluate 调用这个全局函数来驱动 background 逻辑。
// 生产无影响：外部页面无法访问 SW 作用域。
declare global {
  // eslint-disable-next-line no-var
  var __lvRoute: ((req: Req, sender: chrome.runtime.MessageSender) => Promise<Record<string, unknown>>) | undefined;
}
globalThis.__lvRoute = route;

// ---------- 内部工具 ----------

interface VaultFileState {
  envelope: Envelope | null;
  revision: number;
}

/** 读当前 vault 文件 → envelope + revision。
 *  损坏内容经 parseEnvelope 判 null，按「无库」处理（见其注释）。 */
async function readVaultFile(): Promise<VaultFileState> {
  const r = await host.read();
  return { envelope: parseEnvelope(r.ciphertext), revision: r.revision };
}

/** CAS 写 envelope，conflict 时重读重试一次。 */
async function writeVaultFile(envelope: Envelope, baseRevision: number): Promise<number> {
  try {
    const w = await host.write(JSON.stringify(envelope), baseRevision);
    return w.revision;
  } catch (e) {
    if ((e as { code?: string }).code === 'conflict') {
      const cur = await readVaultFile();
      if (!cur.envelope) throw e;
      const w = await host.write(JSON.stringify(envelope), cur.revision);
      return w.revision;
    }
    throw e;
  }
}

function errPayload(e: unknown): { ok: false; code: string; message: string; retryAfterMs?: number } {  if (e instanceof VaultError) {
    return { ok: false, code: e.code, message: e.message };
  }
  const he = e as { code?: string; message?: string };
  const out: { ok: false; code: string; message: string; retryAfterMs?: number } = {
    ok: false,
    code: he.code ?? 'internal',
    message: he.message ?? String(e),
  };
  return out;
}

// ---------- 消息路由 ----------

type Req = Record<string, unknown> & { type: string };

/** 明文 HTTP 页面不返回任何凭据。localhost 例外，本地开发要用。
 *  content script 侧也拦了一次——这里是权威判定，页面里的脚本改不了。 */
function isInsecureUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return !(h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost'));
  } catch {
    return false; // 解析失败交给原逻辑（按无匹配处理）
  }
}

const INSECURE_ERR = {
  ok: false as const,
  code: 'insecure-http',
  message: '此页面使用 HTTP 明文传输，为安全起见不填充凭据',
};

// 内容脚本的每标签页状态：表单识别上报 / 提交捕获
const formReports = new Map<number, { url: string; origin: string; forms: Array<Record<string, unknown>>; isTop: boolean; at: number }>();
const lastSubmits = new Map<number, Record<string, unknown>>();

chrome.tabs.onRemoved.addListener((tabId) => { formReports.delete(tabId); lastSubmits.delete(tabId); });

chrome.runtime.onMessage.addListener((req: Req, sender, sendResponse) => {
  void (async () => {
    try {
      sendResponse(await route(req, sender));
    } catch (e) {
      sendResponse(errPayload(e));
    }
  })();
  return true; // async response
});

/** 内容脚本按「站点密码规则」算好的生成参数；页面输入不可信，后台再 clamp 一次 */
function genParamsFrom(req: Req): { length?: number; symbols?: boolean } {
  const raw = req.genOpts as { length?: unknown; symbols?: unknown } | undefined;
  if (!raw || typeof raw !== 'object') return {};
  const n = Number(raw.length);
  const length = Number.isFinite(n) && n > 0 ? Math.max(4, Math.min(64, Math.round(n))) : undefined;
  const symbols = typeof raw.symbols === 'boolean' ? raw.symbols : undefined;
  return { length, symbols };
}

async function route(req: Req, sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  switch (req.type) {
    // ---- 状态 ----
    case 'status': {
      // SW 回收后的会话恢复：session 标志说"已解锁"但 hv 内存是空的（SW 刚冷启动）
      // → host 从密钥槽把 DEK 拿回来。失败（槽过期/换库）则清标志，回到真锁定。
      if ((await isHostUnlockedFlag()) && !hv.isUnlocked()) {
        const resumed = await hv.resumeWithHost(host);
        if (!resumed) await markHostLocked();
      }
      // 「记住解锁」：SW/浏览器冷启动时自动恢复会话（用户显式开启过才生效）
      // 每个浏览器会话只尝试一次自动恢复：空闲锁刚删掉钥匙后，别再被 status 自动解开
      if ((await currentLockState()) === 'locked'
          && await isRememberEnabled()
          && await shouldAttemptBootRestore()) {
        const remembered = await getRememberedDek();
        const file = await readVaultFile();
        if (remembered && file.envelope) {
          try {
            await unlockViaHost(remembered);
          } catch {
            // 记住的 DEK 与磁盘库不匹配（改过主密码/文件被动过）：作废记忆
            await setRememberUnlock(false);
          }
        }
      }
      const state = await currentLockState();
      // v2 版的 syncFromDisk：解锁态下重开弹窗（status）即刷新 heads 缓存，
      // 另一浏览器刚写的条目立即可见
      if (state === 'unlocked' && !hv.isUnlocked()) {
        await hv.resumeWithHost(host).catch(() => false);
      } else if (state === 'unlocked') {
        await hv.refreshHeads(host).catch(() => undefined);
      }
      const hello = await host.hello().catch(() => null);
      return {
        ok: true,
        data: {
          state,
          hostOk: !!hello,
          vaultPath: hello?.vaultPath ?? null,
          lockoutMs: lockoutRemainingMs(),
          rememberEnabled: await isRememberEnabled(),
          rememberKeyError,
          failedAttempts: 0, // 不外泄具体次数，只给退避时间
        },
      };
    }

    // ---- 诊断（设置页用）：host 侧的路径/版本/备份 + 会话状态 ----
    case 'diag': {
      const hostInfo = await host.diag().catch((e) => ({
        error: (e as { message?: string }).message ?? String(e),
      }));
      return {
        ok: true,
        data: {
          host: hostInfo,
          state: await currentLockState(),
          entryCount: hv.isUnlocked() ? hv.getHeads().length : null,
          rememberEnabled: await isRememberEnabled(),
          idleMinutes: await getIdleLockMinutes(),
        },
      };
    }

    // ---- 自动锁定时间 ----
    case 'set-idle': {
      const min = Number(req.minutes);
      if (![0, 5, 15, 30, 60].includes(min)) {
        return { ok: false, code: 'bad-request', message: '不支持的锁定时长' };
      }
      await setIdleLockMinutes(min);
      return { ok: true, data: { minutes: min } };
    }

    // ---- 记住解锁开关 ----
    // rememberKeyError 只用于诊断提示（为什么开关开着却没有自动解锁），不含密钥材料
    case 'set-remember': {
      const enabled = !!req.enabled;
      if (enabled) {
        if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '先解锁再开启' };
        try {
          await setRememberUnlock(true);
        } catch {
          return {
            ok: false,
            code: 'host-unavailable',
            message: '本机助手未连接，暂时不能记住解锁（不会把密钥明文写盘）',
          };
        }
      } else {
        await setRememberUnlock(false);
      }
      return { ok: true };
    }

    // ---- 创建 ----
    case 'create-vault': {
      const masterPassword = String(req.masterPassword);
      if (masterPassword.length < 8) {
        return { ok: false, code: 'weak-password', message: '主密码至少 8 位' };
      }
      const { envelope, dek, recoveryKey } = await createVault(masterPassword, VERSION);
      const file = await readVaultFile();
      if (file.envelope) {
        return { ok: false, code: 'vault-exists', message: '本机已有保险库；如需重建请先在设置里删除或导出' };
      }
      // v2：建库时 payload 段里直接装 v2 payload
      const payloadV2 = await buildPayloadV2(dek, { entries: [], meta: { createdAt: new Date().toISOString(), generatorVersion: VERSION } });
      const envelopeNext = await encryptPayloadWithDek(envelope, dek, payloadV2 as unknown as VaultData);
      const rev = await writeVaultFile(envelopeNext, file.revision);
      void rev;
      await unlockViaHost(dek); // 统一走 hv 层：host 持钥匙 + 扩展解锁状态置位
      await markUnlocked();
      resetFailedAttempts();
      return { ok: true, data: { recoveryKey } };
    }

    // ---- 解锁 ----
    case 'unlock': {
      const wait = lockoutRemainingMs();
      if (wait > 0) {
        return { ok: false, code: 'lockout', message: `尝试过于频繁，${Math.ceil(wait / 1000)} 秒后重试`, retryAfterMs: wait };
      }
      const file = await readVaultFile();
      if (!file.envelope) return { ok: false, code: 'no-vault', message: '尚未创建保险库' };
      try {
        const { dek } = await openVault(file.envelope, String(req.password));
        let r;
        try { r = await unlockViaHost(dek); }
        catch (inner) { const ie = inner as Error & { code?: string }; throw Object.assign(new Error('unlockViaHost: ' + ie.message), { code: 'inner-' + (ie.code ?? '?'), cause: inner }); }
        await markUnlocked();
        // 开着「记住解锁」的话，这次解锁顺手把钥匙放回去，下次开机能自动解锁。
        // 包不上（host 不在）就跳过：绝不明文落盘，也不能让解锁本身失败
        if (await isRememberEnabled()) {
          try { await setRememberUnlock(true, dek); rememberKeyError = null; }
          catch (e) { rememberKeyError = (e as Error)?.message ?? 'wrap-failed'; }
        }
        resetFailedAttempts();
        return { ok: true, data: { entries: r.entries, migrated: r.migrated } };
      } catch (e) {
        if (e instanceof VaultError && e.code === 'wrong-password') {
          const backoff = recordFailedAttempt();
          return {
            ok: false,
            code: 'wrong-password',
            message: '密码错误',
            retryAfterMs: backoff,
          };
        }
        if ((e as { code?: string }).code === 'migrate-verify') {
          return errPayload(e);
        }
        throw e;
      }
    }

    // ---- 填充审计上报（内容脚本填充完成后调；只记元数据，绝不含密码）----
    case 'report-fill': {
      try {
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
        await host.reportFill({
          site: String(req.site ?? ''),
          tab: String(req.tab ?? ''),
          method: String(req.method ?? 'click'),
          entryId: String(req.entryId ?? ''),
          app: /Edg\//.test(ua) ? 'Microsoft Edge'
            : /OPR\//.test(ua) ? 'Opera'
            : /Chrome\//.test(ua) ? 'Google Chrome' : '浏览器扩展',
        });
      } catch { /* 审计失败绝不影响填充本身 */ }
      return { ok: true };
    }

    // ---- 站点中文名自动补全 ----
    case 'fetch-site-info': {
      try {
        const r = await host.fetchSiteInfo(String(req.url ?? ''), String(req.title ?? ''));
        return { ok: true, data: r };
      } catch (e) {
        return errPayload(e);
      }
    }

    // ---- 打开本地管理后台 ----
    case 'open-ui': {
      try {
        // 后台 API 要令牌；扩展是唯一能经 native messaging 拿到它的地方。
        const tk = await host.uiToken();
        const port = Number(tk?.port);
        if (port > 0 && tk?.token) {
          await chrome.tabs.create({ url: `http://127.0.0.1:${port}/?t=${encodeURIComponent(tk.token)}` });
          return { ok: true };
        }
      } catch { /* 落到下面的提示 */ }
      return { ok: false, message: '本地后台未就绪：请先打开扩展（host 由扩展拉起），或双击 vault-ui.cmd' };
    }

    // ---- 内容脚本：请求凭据（点击才填，绝不自动）----
    // signup 表单：总是生成新密码（注册场景要的是新账号，即使同站已有旧账号）；
    //   落库延迟到注册提交后的「保存提示」确认。
    // login 表单：有匹配填已存；无匹配返回 null（由 popup 引导）。
    case 'get-or-generate': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      const url = String(req.url ?? '');
      const formType = String(req.formType ?? 'login');
      if (isInsecureUrl(url)) return INSECURE_ERR;

      if (formType === 'signup') {
        const { generatePassword } = await import('../lib/generator');
        return { ok: true, data: { username: '', password: generatePassword(genParamsFrom(req)), generated: true } };
      }

      const credRes = (await route({ type: 'get-credentials', url } as Req, sender)) as {
        ok: boolean;
        data?: { username: string; password: string; matches?: Array<{ id: string; title: string; username: string; password: string }> } | null;
      };
      if (credRes.ok && credRes.data) return { ok: true, data: credRes.data };
      // login 表单无匹配：给出生成密码 + 身份列表，由内容脚本弹菜单（第二层保险，
      // 覆盖识别器把注册页误判为 login 的场景——用户永远有生成出路）
      const { generatePassword } = await import('../lib/generator');
      return { ok: true, data: { username: '', password: generatePassword(genParamsFrom(req)), generated: true, identities: await identitiesForFill() } };
    }

    // ---- 内容脚本：请求当前站点凭据（同 get-or-generate 的 login 分支）----
    case 'get-credentials': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      const url = String(req.url ?? '');
      if (isInsecureUrl(url)) return INSECURE_ERR;
      let origin = '';
      let hostName = '';
      try {
        const u = new URL(url);
        origin = u.origin;
        hostName = u.hostname;
      } catch {
        return { ok: true, data: null };
      }

      // 域匹配（只碰 head，不碰密码）：条目任一 URL 与当前页同源，或主机名后缀匹配
      const matches = hv.getHeads().filter((h) =>
        (h.urls ?? []).some((raw) => {
          try {
            const entryUrl = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
            if (entryUrl.origin === origin) return true;
            const eh = entryUrl.hostname;
            // 只允许条目域及其子域：去掉反向 endsWith，
            // 否则「条目 a.b.com 会被 b.com 下任意子域命中」这类过宽匹配成立
            return hostName === eh || hostName.endsWith('.' + eh);
          } catch { return false; }
        }),
      );
      if (matches.length === 0) return { ok: true, data: null };

      // 单条直接带密码；多条把全部 head 带上——内容脚本要用它弹「选哪个账号」，
      // 但**密码只在用户选定后**才按条取（get-secret），列表里绝不放密码
      const m = matches[0]!;
      const secret = await hv.getEntrySecret(host, m.id);
      return {
        ok: true,
        data: {
          username: m.username,
          password: secret.password,
          title: m.title,
          matchCount: matches.length,
          matches: matches.map((x) => ({
            id: x.id, title: x.title, username: x.username, password: '' as string,
          })),
        },
      };
    }

    // ---- 内容脚本：表单识别上报（保存提示与 popup「当前网站」卡片用）----
    case 'lv-forms-report': {
      const tab = sender.tab?.id;
      if (typeof tab !== 'number') return { ok: false, code: 'no-tab', message: '无法识别来源标签页' };
      formReports.set(tab, {
        url: String(req.url ?? ''),
        origin: String(req.origin ?? ''),
        forms: (req.forms as Array<Record<string, unknown>>) ?? [],
        isTop: req.isTop !== false,
        at: Date.now(),
      });
      return { ok: true };
    }

    case 'get-tab-forms': {
      // content script 只能查自己所在标签页；popup/options（无 sender.tab）可指定
      const tab = sender.tab?.id ?? Number(req.tabId);
      return { ok: true, data: { forms: formReports.get(tab)?.forms ?? [] } };
    }

    // ---- 页面内提交捕获（save float 与 popup 共用）----
    case 'lv-store-last-submit': {
      const tab = sender.tab?.id;
      if (typeof tab === 'number') {
        lastSubmits.set(tab, { ...((req.submit as Record<string, unknown>) ?? {}), _at: Date.now(), _from: String((req.submit as { _from?: string })?._from ?? '') });
      }
      return { ok: true };
    }
    case 'lv-take-last-submit': {
      // lastSubmit 里是捕获到的表单提交（含密码），绝不允许跨标签读取
      const tab = sender.tab?.id ?? Number(req.tabId);
      const v = lastSubmits.get(tab) ?? null;
      lastSubmits.delete(tab);
      return { ok: true, data: v };
    }
    case 'lv-clear-last-submit': {
      const tab = sender.tab?.id ?? Number(req.tabId);
      lastSubmits.delete(tab);
      return { ok: true };
    }
    case 'lv-peek-last-submit': {
      // 真实调用来自 content script：以 sender.tab.id 为准；e2e 直驱时用 req.tabId
      const tab = sender?.tab?.id ?? Number(req.tabId);
      return { ok: true, data: lastSubmits.get(tab) ?? null };
    }

    // ---- 常用身份：现在由 host 读写（payload meta 段，与条目同等加密强度）----
    case 'get-identities': {
      if (!hv.isUnlocked()) return { ok: true, data: { identities: [] } }; // 锁定态给空（UI 展示用）
      const r = await host.getIdentities();
      return { ok: true, data: { identities: r.identities } };
    }

    case 'set-identities': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      await host.setIdentities((req.identities as hvHostIdentity[]) ?? []);
      return { ok: true };
    }

    case 'get-signup-options': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      const { generatePassword } = await import('../lib/generator');
      return {
        ok: true,
        data: {
          password: generatePassword(genParamsFrom(req)),
          identities: (await host.getIdentities()).identities,
        },
      };
    }

    // ---- 页面内浮窗确认保存（提交捕获 → 用户点「保存」）----
    case 'save-from-float': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      const c = req.candidate as { username: string; password: string; url: string; title?: string };
      if (!c?.password) return { ok: false, code: 'no-password', message: '没有可保存的密码' };

      // 同站同名账号 → 更新（密码历史由 host 记？v2 由扩展组装后 upsert）
      // 覆盖判定改为解析 URL 后同源比较：
      // 字符串 includes 会被 "https://evil.com/?ref=https://bank.com" 这类 URL 骗过，
      // 导致攻击者页面的保存覆盖用户 bank.com 的真实条目。
      let candidateUrl: URL | null = null;
      try { candidateUrl = new URL(c.url); } catch { /* 非法 URL 时不做覆盖合并 */ }
      const existing = hv.getHeads().find(
        (h) => c.username && h.username === c.username && candidateUrl != null &&
          (h.urls ?? []).some((u) => {
            try { return new URL(u.startsWith('http') ? u : 'https://' + u).origin === candidateUrl!.origin; }
            catch { return false; }
          }),
      );
      if (existing) {
        // 历史由 host 锁内合并；只补 URL 与新密码
        await host.upsert({
          id: existing.id,
          title: existing.title,
          username: existing.username,
          urls: [...new Set([...(existing.urls ?? []), c.url])],
          createdAt: existing.createdAt,
          password: c.password,
          notes: '',
          passwordHistory: [],
        });
        await hv.refreshHeads(host);
        return { ok: true, data: { action: 'updated' } };
      }
      // 名称：内置映射 → 页面标题 → 域名（全程零联网）
      let newTitle = '';
      try {
        const info = await host.fetchSiteInfo(c.url, c.title ?? '');
        newTitle = info?.name ?? '';
      } catch { /* 识别失败不影响保存 */ }
      await host.upsert({
        id: crypto.randomUUID(),
        title: newTitle || (c.url.replace(/^https?:\/\//, '').split('/')[0] ?? c.url),
        username: c.username,
        password: c.password,
        urls: [c.url],
        notes: '', createdAt: '', updatedAt: '', passwordHistory: [],
      });
      await hv.refreshHeads(host);
      return { ok: true, data: { action: 'created' } };
    }

    case 'reset-with-recovery': {
      const file = await readVaultFile();
      if (!file.envelope) return { ok: false, code: 'no-vault', message: '尚未创建保险库' };
      const { envelope: next, dek } = await resetWithRecovery(
        file.envelope, String(req.recoveryKey), String(req.newPassword),
      );
      await host.write(JSON.stringify(next), file.revision);
      await unlockViaHost(dek); // v2：host 持钥匙 + 扩展解锁状态置位（老库会自动迁移）
      resetFailedAttempts();
      return { ok: true };
    }

    // ---- TPM / Windows Hello ----
    // ---- 加密程度（导出包裹模式）----
    case 'get-export-mode': {
      try {
        const r = await host.getExportMode();
        return { ok: true, data: r };
      } catch (e) {
        return errPayload(e);
      }
    }

    case 'set-export-mode': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '先解锁再调整' };
      try {
        const r = await host.setExportMode(String(req.mode) as 'host' | 'none' | 'strict');
        return { ok: true, data: r };
      } catch (e) {
        return errPayload(e);
      }
    }

    case 'tpm-status': {
      const r = await host.tpmStatus().catch(() => ({ available: false }));
      return { ok: true, data: r };
    }

    case 'tpm-enable': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '先解锁再开启' };
      try {
        const r = await host.tpmEnable();
        return { ok: true, data: r };
      } catch (e) {
        return errPayload(e);
      }
    }

    case 'tpm-disable': {
      try {
        const r = await host.tpmDisable();
        return { ok: true, data: r };
      } catch (e) {
        return errPayload(e);
      }
    }

    case 'unlock-tpm': {
      try {
        const r = await host.unlockTpm();
        await hv.setHeadsForResume(host);
        await markHostUnlocked();
        resetFailedAttempts();
        return { ok: true, data: { entries: r.entries, method: r.method } };
      } catch (e) {
        return errPayload(e); // tpm-cancelled / tpm-not-configured / tpm-stale / wrong… 原样透传
      }
    }

    // ---- 锁定 ----
    // 复制密码后安排一次清空（具体清空由 offscreen 文档执行）
    case 'schedule-clipboard-clear': {
      const seconds = Math.max(5, Math.min(300, Number(req.seconds ?? 30)));
      try {
        chrome.alarms?.create('lv:clip-clear', { delayInMinutes: seconds / 60 });
      } catch { /* 没有 alarms 就退化为不清，不影响复制本身 */ }
      return { ok: true, data: { seconds } };
    }

    case 'lock': {
      await lockAll();
      return { ok: true };
    }

    // ---- 条目 CRUD（要求已解锁；head 常驻，secret 按需）----
    case 'entries': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      return { ok: true, data: { entries: hv.headsAsEntries() } };
    }

    case 'get-entry-secret': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      const secret = await hv.getEntrySecret(host, String(req.id));
      return { ok: true, data: secret };
    }

    case 'save-entry': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      const entry = req.entry as VaultEntry;
      // 保存时零延迟补上站点名（内置映射 + 页面标题，全程零联网）。
      const firstUrl = (entry.urls ?? [])[0];
      if (firstUrl && !/[\u4e00-\u9fff]/.test(entry.title ?? '')) {
        try {
          const info = await host.fetchSiteInfo(firstUrl, String(req.title ?? ''));
          if (info?.name) entry.title = info.name;
        } catch { /* 识别失败不影响保存 */ }
      }
      const oldHead = hv.getHeads().find((h) => h.id === entry.id) ?? null;
      // v2：密码历史由 host 在文件锁内合并（并发安全），扩展只传新值
      const res = await host.upsert({
        id: entry.id,
        title: entry.title ?? '',
        username: entry.username ?? '',
        urls: entry.urls ?? [],
        createdAt: entry.createdAt || oldHead?.createdAt || '',
        password: entry.password ?? '',
        notes: entry.notes ?? '',
        passwordHistory: [],
      });
      await hv.refreshHeads(host);
      // 保存不阻塞：内置映射没命中时，异步用标签页标题再补一次（零联网）
      void autoNameEntry(entry.id, firstUrl, entry.title ?? '', String(req.title ?? ''));
      const secret = await hv.getEntrySecret(host, entry.id);
      return {
        ok: true,
        data: {
          entry: {
            ...entry,
            createdAt: entry.createdAt || oldHead?.createdAt || '',
            updatedAt: oldHead?.updatedAt ?? '',
            password: secret.password,
            passwordHistory: secret.passwordHistory,
            notes: secret.notes,
          },
          revision: res.revision,
        },
      };
    }

    case 'delete-entry': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      await host.remove(String(req.id));
      await hv.refreshHeads(host);
      return { ok: true };
    }

    // ---- 改主密码（v2：改的只是 wrappers，条目密文不动；host 持有的 DEK 不变）----
    case 'change-password': {
      const file = await readVaultFile();
      if (!file.envelope) return { ok: false, code: 'no-vault', message: '尚未创建保险库' };
      const { dek, data } = await openVault(file.envelope, String(req.oldPassword));
      const next = await changeMasterPassword(file.envelope, dek, String(req.newPassword));
      await host.write(JSON.stringify(next), file.revision);
      void data;
      return { ok: true };
    }

    // ---- 导出明文（危险操作：绕过一切加密，只在迁移/纸质备份时用）----
    // 只返回结构与值，不做文件格式；由设置页生成 CSV 并读屏确认。
    case 'export-plaintext': {
      if (!hv.isUnlocked()) return { ok: false, code: 'locked', message: '保险库已锁定' };
      const headsList = hv.getHeads();
      const rows = [];
      for (const h of headsList) {
        const secret = await hv.getEntrySecret(host, h.id);
        rows.push({
          title: h.title ?? '',
          username: h.username ?? '',
          password: secret.password ?? '',
          urls: (h.urls ?? []).join(' '),
          notes: secret.notes ?? '',
          createdAt: h.createdAt ?? '',
          updatedAt: h.updatedAt ?? '',
        });
      }
      return { ok: true, data: { exportedAt: new Date().toISOString(), rows } };
    }

    // ---- 导出/导入（加密 envelope 原样导出）----
    case 'export-envelope': {
      const file = await readVaultFile();
      if (!file.envelope) return { ok: false, code: 'no-vault', message: '尚未创建保险库' };
      return { ok: true, data: { envelope: file.envelope } };
    }

    case 'import-envelope': {
      const incoming = req.envelope as Envelope;
      if (incoming?.format !== 'localvault/v1') {
        return { ok: false, code: 'format', message: '不是合法的 LocalVault 导出文件' };
      }
      // 导入前先解开验证（可以是 v1 整包，也可以是 payload 段里装 v2 的）
      let dek: Uint8Array;
      try {
        ({ dek } = await openVault(incoming, String(req.verifyPassword)));
      } catch (e) {
        return errPayload(e);
      }
      const file = await readVaultFile();
      await host.write(JSON.stringify(incoming), file.revision);
      try {
        await unlockViaHost(dek); // 老格式会自动迁移成 v2
      } catch (e) {
        return errPayload(e);
      }
      await markUnlocked();
      return { ok: true };
    }

    default:
      return { ok: false, code: 'unknown-type', message: '未知消息类型 ' + req.type };
  }
}

type hvHostIdentity = { id: string; label: string; value: string };

/** 保存后补站点名（零联网）：优先用标签页标题，其次内置映射。
 *  只处理「名字还是域名/URL/空」的条目，已有真名的不动。 */
async function autoNameEntry(id: string, url: string | undefined, currentTitle: string, tabTitle = ''): Promise<void> {
  if (!url) return;
  if (!isHostLikeTitle(currentTitle)) return;
  try {
    const info = await host.fetchSiteInfo(url, tabTitle);
    if (!info?.name) return;
    await host.setSiteName(id, info.name, '');
    await hv.refreshHeads(host);
  } catch { /* 识别失败不影响保存 */ }
}

/** 解锁（扩展解出 DEK → 交给 host → 扩展丢掉）。含 v1 → v2 自动迁移。 */
async function unlockViaHost(dek: Uint8Array): Promise<{ entries: number; migrated: boolean }> {
  const r = await hv.unlockWithHost(
    host,
    dek,
    async (env, base) => {
      const w = await host.write(JSON.stringify(env), base);
      return w.revision;
    },
    readVaultFile,
  );
  await markHostUnlocked(); // 跨 SW 回收的解锁标志（session 存储，浏览器关闭即清）
  return r;
}

/** 锁定：host 清 DEK + 扩展清状态 */
async function lockAll(): Promise<void> {
  await host.hostLock().catch(() => undefined); // host 可能本来就没解锁
  hv.resetState();
  await markHostLocked();
  await lock();
}

// 防止 tree-shake 移除未直接使用的导入
void HostClient; type _C = ConflictInfo;
