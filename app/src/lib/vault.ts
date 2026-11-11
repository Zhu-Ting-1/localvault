/**
 * vault 文件格式 v1 与加密核心。
 *
 * 威胁模型：数据只在本机；扩展不联网；
 * 主密码是唯一人类凭据；storage.session 只在可信上下文可读。
 *
 * 格式（JSON envelope，整个文件一个 JSON）：
 * {
 *   format: "localvault/v1",
 *   kdf: { alg: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt: b64 },
 *   authVerify: { nonce: b64, ct: b64 },        // 用 KEK 加密一段已知明文，验证密码正确性
 *   wrappers: [                                  // 用 KEK 包裹 DEK 的信封（可多个：master + recovery）
 *     { id: "master"|"recovery-<n>", nonce: b64, ct: b64 }   // ct = DEK 被 KEK 加密的结果
 *   ],
 *   payload: { nonce: b64, ct: b64, aad: b64 },  // 业务数据（条目表）由 DEK 加密
 *   updatedAt, revisionHint
 * }
 *
 * 设计要点：
 * - 改主密码 = 用旧 KEK 解出 DEK → 用新 KEK 重新包裹 master wrapper；payload 密文不变。
 * - 恢复密钥 = 第二个 wrapper，包同一个 DEK；重设主密码走 recovery wrapper。
 * - AAD 绑定格式版本 + wrapper id，防密文在不同语义域之间搬移。
 */
import { argon2id } from 'hash-wasm';

export const VAULT_FORMAT = 'localvault/v1';
export const KDF = {
  alg: 'argon2id',
  memoryKiB: 65536, // 64 MiB
  iterations: 3,
  parallelism: 1,
  saltBytes: 16,
} as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- 基础原语 ----------

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function unb64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Uint8Array<ArrayBuffer>（TS 5.7 收窄，方便 WebCrypto/hash-wasm 两边传参） */
export type Bytes = Uint8Array<ArrayBuffer>;

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(out);
  return out;
}

/** AES-256-GCM；返回 12B nonce + ct（尾部含 16B tag） */
async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<{ nonce: Bytes; ct: Bytes }> {
  const nonce = randomBytes(12);
  const params: AesGcmParams = { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(aad), tagLength: 128 };
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, toArrayBuffer(plaintext)));
  return { nonce, ct };
}

async function aesDecrypt(key: CryptoKey, nonce: Bytes, ct: Bytes, aad: string): Promise<Uint8Array> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(aad), tagLength: 128 };
  return new Uint8Array(await crypto.subtle.decrypt(params, key, toArrayBuffer(ct)));
}

async function importAes(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** TS 5.7+ 的 Uint8Array<ArrayBufferLike> 与 DOM BufferSource 的类型衔接 */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

/** hash-wasm 的参数类型收窄（它要求 Uint8Array<ArrayBuffer>） */
function asBuf(u: Uint8Array): Uint8Array {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
}

// ---------- KDF ----------

export async function deriveKEK(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await argon2id({
      password,
      salt, // hash-wasm 要求 Uint8Array/DataView，不能传裸 ArrayBuffer
      parallelism: KDF.parallelism,
      iterations: KDF.iterations,
      memorySize: KDF.memoryKiB,
      hashLength: 32,
      outputType: 'binary',
    }),
  );
}

// ---------- 类型 ----------

export interface Envelope {
  format: typeof VAULT_FORMAT;
  kdf: { alg: string; memoryKiB: number; iterations: number; parallelism: number; salt: string };
  authVerify: { nonce: string; ct: string };
  wrappers: Array<{ id: string; nonce: string; ct: string }>;
  payload: { nonce: string; ct: string; aad: string };
  updatedAt: string;
}

export interface VaultData {
  entries: VaultEntry[];
  meta: { createdAt: string; generatorVersion: string };
}

export interface VaultEntry {
  id: string;
  title: string;
  username: string;
  password: string;
  urls: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
  passwordHistory: Array<{ password: string; changedAt: string }>;
}

export class VaultError extends Error {
  constructor(
    public code: 'wrong-password' | 'corrupt' | 'no-recovery' | 'format',
    message: string,
  ) {
    super(message);
  }
}

/**
 * 把 vault.db 里的 ciphertext 解析成 Envelope。
 * 任何不可用情况（空、非 JSON、格式不认识、损坏）
 * 都返回 null，调用方按「没有可用保险库」处理，绝不让 JSON.parse 异常冒到 UI。
 */
export function parseEnvelope(raw: string | null | undefined): Envelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Envelope;
    return parsed && parsed.format === VAULT_FORMAT ? parsed : null;
  } catch {
    return null;
  }
}

const PAYLOAD_AAD_PREFIX = 'localvault-payload/v1';

// ---------- 创建 / 打开 ----------

/** 新建保险库：生成 DEK，master + recovery 两个 wrapper，空条目表。 */
export async function createVault(
  masterPassword: string,
  generatorVersion: string,
): Promise<{ envelope: Envelope; dek: Uint8Array; recoveryKey: string }> {
  const salt = randomBytes(KDF.saltBytes);
  const kek = await deriveKEK(masterPassword, salt);
  const dek = randomBytes(32);
  const aesDek = await importAes(dek);

  // recovery key：人类可抄写的 32 字符组（128 位熵 base32 化 + 分组）。
  // 派生 KEK 一律用归一化后的形式（用户抄写时可能带/不带横线、大小写不同）。
  const recoveryRaw = randomBytes(20);
  const recoveryKey = formatRecoveryKey(recoveryRaw);
  const recoveryKek = await deriveKEK(normalizeRecoveryKey(recoveryKey), salt);

  const authVerify = await aesEncrypt(await importAes(kek), enc.encode('localvault-auth-ok'), 'localvault-auth/v1');

  const data: VaultData = {
    entries: [],
    meta: { createdAt: new Date().toISOString(), generatorVersion },
  };
  const payload = await aesEncrypt(aesDek, enc.encode(JSON.stringify(data)), PAYLOAD_AAD_PREFIX);

  const wrap = async (k: Uint8Array, id: string) => {
    const aes = await importAes(k);
    // nonce 和 ct 必须来自同一次加密，不能分别调用两次
    const { nonce, ct } = await aesEncrypt(aes, dek, 'localvault-wrap/' + id);
    return { id, nonce: b64(nonce), ct: b64(ct) };
  };

  const envelope: Envelope = {
    format: VAULT_FORMAT,
    kdf: {
      alg: KDF.alg,
      memoryKiB: KDF.memoryKiB,
      iterations: KDF.iterations,
      parallelism: KDF.parallelism,
      salt: b64(salt),
    },
    authVerify: { nonce: b64(authVerify.nonce), ct: b64(authVerify.ct) },
    wrappers: [
      await wrap(kek, 'master'),
      await wrap(recoveryKek, 'recovery-1'),
    ],
    payload: { nonce: b64(payload.nonce), ct: b64(payload.ct), aad: PAYLOAD_AAD_PREFIX },
    updatedAt: new Date().toISOString(),
  };

  return { envelope, dek, recoveryKey };
}

/** 用主密码或恢复密钥打开保险库。错误密码/损坏 → VaultError，绝不抛裸异常。 */
export async function openVault(
  envelope: Envelope,
  password: string,
  useRecovery = false,
): Promise<{ dek: Uint8Array; data: VaultData }> {
  if (envelope.format !== VAULT_FORMAT) {
    throw new VaultError('format', '不认识的保险库格式：' + envelope.format);
  }
  const salt = unb64(envelope.kdf.salt);
  const kek = await deriveKEK(password, salt);

  // 1. 验证密码：解开 authVerify。
  //    authVerify 用「主密码 KEK」加密，因此只在主密码路径做；
  //    恢复密钥路径由 recovery wrapper 的 GCM tag 自行验证。
  if (!useRecovery) {
    try {
      await aesDecrypt(await importAes(kek), unb64(envelope.authVerify.nonce), unb64(envelope.authVerify.ct), 'localvault-auth/v1');
    } catch {
      throw new VaultError('wrong-password', '密码错误或文件损坏');
    }
  }

  // 2. 解出 DEK
  const wid = useRecovery ? 'recovery-1' : 'master';
  const w = envelope.wrappers.find((x) => x.id === wid);
  if (!w) throw new VaultError('no-recovery', '此保险库没有恢复密钥 wrapper');
  const wrapKey = await importAes(kek);
  let dek: Uint8Array;
  try {
    dek = await aesDecrypt(wrapKey, unb64(w.nonce), unb64(w.ct), 'localvault-wrap/' + w.id);
  } catch {
    throw new VaultError(useRecovery ? 'wrong-password' : 'corrupt', '无法解出数据密钥');
  }

  // 3. 解 payload
  const data = await decryptPayload(envelope, dek);
  return { dek, data };
}

async function decryptPayload(envelope: Envelope, dek: Uint8Array): Promise<VaultData> {
  const aesDek = await importAes(dek);
  let plain: Uint8Array;
  try {
    plain = await aesDecrypt(aesDek, unb64(envelope.payload.nonce), unb64(envelope.payload.ct), envelope.payload.aad);
  } catch {
    throw new VaultError('corrupt', '数据损坏或被篡改');
  }
  try {
    return JSON.parse(dec.decode(plain)) as VaultData;
  } catch {
    throw new VaultError('corrupt', '解密后的数据不是合法 JSON');
  }
}

// ---------- 改主密码 / 重设 ----------

/**
 * 改主密码：payload 密文不变，只换 master wrapper。
 * recovery wrapper 保持不变（同一个 DEK）。
 */
export async function changeMasterPassword(envelope: Envelope, dek: Uint8Array, newPassword: string): Promise<Envelope> {
  const kek = await deriveKEK(newPassword, unb64(envelope.kdf.salt));
  const aes = await importAes(kek);
  const w = await aesEncrypt(aes, dek, 'localvault-wrap/master');
  const authVerify = await aesEncrypt(aes, enc.encode('localvault-auth-ok'), 'localvault-auth/v1');
  return {
    ...envelope,
    authVerify: { nonce: b64(authVerify.nonce), ct: b64(authVerify.ct) },
    wrappers: envelope.wrappers.map((x) =>
      x.id === 'master' ? { id: 'master', nonce: b64(w.nonce), ct: b64(w.ct) } : x,
    ),
    updatedAt: new Date().toISOString(),
  };
}

/** 用恢复密钥重设主密码（主密码忘了的场景）。 */
export async function resetWithRecovery(
  envelope: Envelope,
  recoveryKey: string,
  newPassword: string,
): Promise<{ envelope: Envelope; dek: Uint8Array }> {
  const { dek } = await openVault(envelope, normalizeRecoveryKey(recoveryKey), true);
  const next = await changeMasterPassword(envelope, dek, newPassword);
  return { envelope: next, dek };
}

// ---------- recovery key 格式 ----------

// 32 个符号（base32 硬要求）：字母去掉易混淆的 I L O（23 个），
// 数字用 2-9（8 个），共 31 → 从 0-9 里取一个最不混淆的补足：用 5 已在表内，
// 这里补 U（字母表里没有的顺序位置，实际等价于把 U 排在 Z 后）。
// 注意：只要「编码-解码用同一张表」且表恰好 32 个不重复符号即可，顺序无所谓。
const B32 = (() => {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // 23 个，无 I L O
  const digits = '23456789'; // 8 个，无 0 1
  const alphabet = letters + digits; // 31
  // 补第 32 个：低混淆候选 X 已存在 → 用 W 已存在 → 用 0 最差 → 选字母 V 后补 'U' 不重复？
  // U 不在 letters（我们没去掉 U）。检查：letters 含 U。那就补数字 0。
  // 0 与 O 混淆，但 O 已从表里去掉，因此 0 在这张表里不与任何符号混淆——安全。
  const full = alphabet + '0'; // 32
  if (new Set(full).size !== 32) throw new Error('base32 表必须是 32 个不重复符号');
  return full;
})();

export function formatRecoveryKey(raw: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  const chars: string[] = [];
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      chars.push(B32[(value >>> (bits - 5)) & 31] ?? '?');
      bits -= 5;
    }
  }
  if (bits > 0) chars.push(B32[(value << (5 - bits)) & 31] ?? '?');
  out = chars.join('');
  // 32 字符分 4 组
  return (out.match(/.{1,8}/g) ?? []).join('-');
}

export function normalizeRecoveryKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '');
}