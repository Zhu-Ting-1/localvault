/**
 * 保险库 v2 payload：**每条条目拆成两个独立密文块**。
 *
 * 为什么拆：
 * - `head`（标题/账号/网址/时间）只给列表和搜索用；
 * - `secret`（密码/历史/备注）只在复制、填充、编辑时解。
 * 于是"打开保险库"不再等于"全部密码进内存"，密码也不会出现在列表路径里。
 *
 * AAD 绑定：head 用 `localvault/v2/head/<id>`，secret 用 `localvault/v2/secret/<id>`。
 * 这样把一个条目的密文挪到另一个条目、或把 secret 当 head 解，都会认证失败。
 *
 * 明文结构里保留：条目 id、条数、meta。这些不是密码，但会泄漏"你有多少条记录"；
 * v1 的整包加密连条数都不泄漏，v2 用这点信息换"密码不常驻"，是有意的取舍。
 */
import {
  b64, unb64,
  type VaultData, type VaultEntry,
} from './vault';
import { sealJson, openJsonBound, type SealedBlob } from './payload';

export const V2_FORMAT = 'localvault/v2';

export interface EntryHead {
  title: string;
  username: string;
  urls: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EntrySecret {
  password: string;
  passwordHistory: Array<{ password: string; changedAt: string }>;
  notes: string;
}

export interface EntryV2 {
  id: string;
  head: SealedBlob;
  secret: SealedBlob;
}

export interface PayloadV2 {
  format: typeof V2_FORMAT;
  entries: EntryV2[];
  meta: {
    createdAt: string;
    generatorVersion: string;
    /** 常用身份（手机号/邮箱）。由 host 读写，扩展只拿明文结果。 */
    identities?: SealedBlob;
  };
}

const headAad = (id: string) => `localvault/v2/head/${id}`;
const secretAad = (id: string) => `localvault/v2/secret/${id}`;

/** 把一条明文条目拆成两个密文块 */
export async function sealEntryV2(dek: Uint8Array, entry: VaultEntry): Promise<EntryV2> {
  const head: EntryHead = {
    title: entry.title ?? '',
    username: entry.username ?? '',
    urls: entry.urls ?? [],
    createdAt: entry.createdAt ?? '',
    updatedAt: entry.updatedAt ?? '',
  };
  const secret: EntrySecret = {
    password: entry.password ?? '',
    passwordHistory: entry.passwordHistory ?? [],
    notes: entry.notes ?? '',
  };
  return {
    id: entry.id,
    head: await sealJson(dek, head, headAad(entry.id)),
    secret: await sealJson(dek, secret, secretAad(entry.id)),
  };
}

/** 只解 head（列表/搜索路径，绝不碰密码） */
export async function openEntryHead(dek: Uint8Array, e: EntryV2): Promise<EntryHead & { id: string }> {
  // 用「按当前 id 重新算出来的 aad」解 —— 密文被挪到别的条目就会认证失败
  const head = await openJsonBound<EntryHead>(dek, e.head, headAad(e.id));
  return { id: e.id, ...head };
}

/** 只解 secret（复制/填充/编辑路径） */
export async function openEntrySecret(dek: Uint8Array, e: EntryV2): Promise<EntrySecret> {
  return openJsonBound<EntrySecret>(dek, e.secret, secretAad(e.id));
}

/** 整条合成回 v1 时代的形状，供现有 UI 与填充逻辑复用 */
export async function openEntryFull(dek: Uint8Array, e: EntryV2): Promise<VaultEntry> {
  const head = await openEntryHead(dek, e);
  const secret = await openEntrySecret(dek, e);
  return {
    id: e.id,
    title: head.title,
    username: head.username,
    urls: head.urls,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
    password: secret.password,
    passwordHistory: secret.passwordHistory,
    notes: secret.notes,
  };
}

/** 把整份 v1 明文数据编码成 v2 payload（迁移与保存都走这里） */
export async function buildPayloadV2(dek: Uint8Array, data: VaultData): Promise<PayloadV2> {
  const entries: EntryV2[] = [];
  for (const entry of data.entries) entries.push(await sealEntryV2(dek, entry));
  return {
    format: V2_FORMAT,
    entries,
    meta: {
      createdAt: data.meta?.createdAt ?? new Date().toISOString(),
      generatorVersion: data.meta?.generatorVersion ?? '',
    },
  };
}

/** 列表路径：只解 head，密码一个都不碰 */
export async function readHeadsV2(
  dek: Uint8Array,
  payload: PayloadV2,
): Promise<Array<EntryHead & { id: string }>> {
  const out: Array<EntryHead & { id: string }> = [];
  for (const e of payload.entries) out.push(await openEntryHead(dek, e));
  return out;
}

/** 全量读取（迁移校验、导出、需要全库时用；会解出所有密码） */
export async function readAllV2(dek: Uint8Array, payload: PayloadV2): Promise<VaultData> {
  const entries: VaultEntry[] = [];
  for (const e of payload.entries) entries.push(await openEntryFull(dek, e));
  return {
    entries,
    meta: {
      createdAt: payload.meta.createdAt,
      generatorVersion: payload.meta.generatorVersion,
    },
  } as VaultData;
}

export function isPayloadV2(x: unknown): x is PayloadV2 {
  const p = x as PayloadV2 | null;
  return !!p && p.format === V2_FORMAT && Array.isArray(p.entries);
}

/** 供测试与调试：确认某个字段确实是"该条目的该用途"（AAD 校验的显式版本） */
export function expectedAad(kind: 'head' | 'secret', id: string): string {
  return kind === 'head' ? headAad(id) : secretAad(id);
}

// 保留这两位导出，避免调用方为了 b64/unb64 再多引一个模块
export { b64, unb64 };
