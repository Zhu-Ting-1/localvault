/**
 * 经 host 的保险库数据层。
 *
 * 核心变化：**扩展不再持有 DEK、不再自己解密条目**。
 *  - unlock 时：扩展用主密码解出 DEK → 交给 host → 立刻丢弃 → 之后所有加解密都在 host 进程里
 *  - list：只拿 head（标题/账号/网址），密码根本不出现在这条路径
 *  - get-secret：复制/填充时按条取，用完即弃
 *  - upsert/delete：host 在同一把文件锁内完成读-改-写（并发天然串行化）
 *
 * v1 → v2 迁移：unlock 发现老库（host 报 need-migrate）时自动做——
 * 扩展解密 v1 全量 → backup-before-migrate → 组装 v2 payload → 整体写回 → 校验。
 * 全程只在迁移的几秒内持有 DEK，平时零持有。
 */
import type { HostClient, HostHead } from './host';
import type { VaultEntry, Envelope, VaultData } from './vault';
import { encryptPayloadWithDek, decryptWithDek } from './payload';
import { buildPayloadV2, isPayloadV2 } from './vault-v2';

/** 内存里的条目列表（只有 head，没有密码）。解锁时拉一次，写入后刷新。 */
let heads: HostHead[] = [];
let unlockedFlag = false;

export function isUnlocked(): boolean {
  return unlockedFlag;
}

export function getHeads(): HostHead[] {
  return heads;
}

/** 把 host 的 head 列表当成 v1 时代的 VaultEntry（无密码）供搜索/匹配用 */
export function headsAsEntries(): VaultEntry[] {
  return heads.map((h) => ({
    id: h.id,
    title: h.title,
    username: h.username,
    urls: h.urls ?? [],
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
    password: '',
    passwordHistory: [],
    notes: '',
  }));
}

export function resetState(): void {
  heads = [];
  unlockedFlag = false;
}

/** 解锁（含自动迁移 v1 → v2）。dek 只在本次调用内使用，返回前丢弃。 */
export async function unlockWithHost(
  host: HostClient,
  dek: Uint8Array,
  writeEnvelope: (env: Envelope, baseRevision: number) => Promise<number>,
  readEnvelope: () => Promise<{ envelope: Envelope | null; revision: number }>,
): Promise<{ entries: number; migrated: boolean }> {
  let migrated = false;

  // 第一次尝试直接 unlock；老库会报 need-migrate
  try {
    const r = await host.unlock(dek);
    let list;
    try {
      list = await host.list();
    } catch (le) {
      // SW 在 Argon2id 重计算期间可能被浏览器重启 → 端口重建到新 host 进程（无钥匙）。
      // unlock 的结果已随密钥槽落盘，这里 resume 一次即可拿回同一会话。
      const resumed = await resumeWithHost(host);
      if (!resumed) {
        throw Object.assign(new Error('post-unlock list: ' + String((le as Error).message)), { code: 'post-list-' + String((le as { code?: string }).code ?? '?') });
      }
      list = { entries: heads };
    }
    heads = list.entries;
    unlockedFlag = true;
    return { entries: r.entries, migrated };
  } catch (e) {
    if ((e as { code?: string }).code !== 'need-migrate') throw e;
  }

  // ---- v1 → v2 迁移 ----
  const file = await readEnvelope();
  if (!file.envelope) throw Object.assign(new Error('保险库文件丢失'), { code: 'no-vault' });

  const dataV1 = await decryptWithDek(file.envelope, dek);
  await host.backupBeforeMigrate(); // 强制备份：v0.2.x 读不懂 v2，这份备份就是回退路

  const payloadV2 = await buildPayloadV2(dek, dataV1);
  // 常用身份原来存在扩展的 storage.local（DEK 加密）；迁移时一并搬进 payload meta 段
  const envelopeNext = await encryptPayloadWithDek(file.envelope, dek, payloadV2 as unknown as VaultData);

  await writeEnvelope(envelopeNext, file.revision);

  // 迁移后逐条校验（条数 + id 集合），失败立即抛错（原文件没动过，可重试）
  const unlockRes = await host.unlock(dek);
  const list = await host.list();
  const idsBefore = new Set(dataV1.entries.map((e) => e.id));
  const idsAfter = new Set(list.entries.map((e) => e.id));
  if (idsBefore.size !== idsAfter.size || [...idsBefore].some((id) => !idsAfter.has(id))) {
    throw Object.assign(new Error('迁移校验失败：条目集合不一致（原文件未动，可重试）'), { code: 'migrate-verify' });
  }

  heads = list.entries;
  unlockedFlag = true;
  migrated = true;
  return { entries: unlockRes.entries, migrated };
}

export async function refreshHeads(host: HostClient): Promise<void> {
  if (!unlockedFlag) return;
  const list = await host.list();
  heads = list.entries;
}

/** 取单条密码。返回的明文由调用方使用后尽快释放（无法真正清零，但不再可达）。 */
export async function getEntrySecret(host: HostClient, id: string): Promise<{ password: string; passwordHistory: Array<{ password: string; changedAt: string }>; notes: string }> {
  if (!unlockedFlag) throw Object.assign(new Error('保险库已锁定'), { code: 'locked' });
  return host.getSecret(id);
}
/** 判断 payload 明文（迁移前解出来的）是不是已经是 v2 */
export function payloadIsV2(raw: unknown): boolean {
  return isPayloadV2(raw);
}

/**
 * SW 回收后的会话恢复：host 从密钥槽读回 DEK。
 * 调用时机：SW 冷启动 + session 标志说"已解锁"。成功则刷新 heads；槽不存在/失效返回 false。
 */
export async function resumeWithHost(host: HostClient): Promise<boolean> {
  try {
    await host.unlockResume();
    const list = await host.list();
    heads = list.entries;
    unlockedFlag = true;
    return true;
  } catch {
    return false;
  }
}

/** TPM 解锁成功后由 background 调用：拉列表并置解锁态（与 resume 同语义） */
export async function setHeadsForResume(host: HostClient): Promise<boolean> {
  try {
    const list = await host.list();
    heads = list.entries;
    unlockedFlag = true;
    return true;
  } catch {
    return false;
  }
}
