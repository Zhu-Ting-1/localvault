/**
 * 用 DEK 加解密的通用小工具。
 *
 * 两个消费方：
 * - 保险库 payload（条目表，AAD = localvault-payload/v1）
 * - 保险库之外的小数据（常用身份，AAD = localvault-identities/v1）
 *   身份数量很少且要独立更新，没必要每次都重写整个 vault 文件，
 *   但仍用同一把 DEK 加密，保证「落盘无明文」。
 */
import { b64, unb64, type Envelope, type VaultData } from './vault';

const PAYLOAD_AAD_PREFIX = 'localvault-payload/v1';

/** AES-GCM 密封块：nonce/ct 均为 base64，aad 参与认证（防跨用途重放） */
export interface SealedBlob {
  nonce: string;
  ct: string;
  aad: string;
}

/** 用 DEK 封装任意可 JSON 化的数据 */
export async function sealJson(dek: Uint8Array, data: unknown, aad: string): Promise<SealedBlob> {
  const dekBuf = new ArrayBuffer(dek.byteLength);
  new Uint8Array(dekBuf).set(dek);
  const aesDek = await crypto.subtle.importKey('raw', dekBuf, 'AES-GCM', false, ['encrypt']);
  const nonceBuf = new ArrayBuffer(12);
  crypto.getRandomValues(new Uint8Array(nonceBuf));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonceBuf, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
      aesDek,
      new TextEncoder().encode(JSON.stringify(data)) as unknown as BufferSource,
    ),
  );
  return { nonce: b64(new Uint8Array(nonceBuf)), ct: b64(ct), aad };
}

/** 用 DEK 打开密封块 */
export async function openJson<T>(dek: Uint8Array, blob: SealedBlob): Promise<T> {
  return openJsonBound<T>(dek, blob, blob.aad);
}

/**
 * 用**调用方给定的** AAD 解密，忽略密文里自带的 aad 字段。
 *
 * 为什么要这个：`blob.aad` 是随密文一起存的，攻击者把 A 条目的密文挪到 B 条目时，
 * 自带 aad 也跟着过去 —— 解密仍然成功，AAD 绑定形同虚设。
 * 只有用"按当前位置/用途重新算出来的 aad"去解，挪动才会认证失败。
 */
export async function openJsonBound<T>(dek: Uint8Array, blob: SealedBlob, aad: string): Promise<T> {
  const dekBuf = new ArrayBuffer(dek.byteLength);
  new Uint8Array(dekBuf).set(dek);
  const aesDek = await crypto.subtle.importKey('raw', dekBuf, 'AES-GCM', false, ['decrypt']);
  const nonce = unb64(blob.nonce);
  const ct = unb64(blob.ct);
  const nonceBuf = new ArrayBuffer(nonce.byteLength);
  new Uint8Array(nonceBuf).set(nonce);
  const ctBuf = new ArrayBuffer(ct.byteLength);
  new Uint8Array(ctBuf).set(ct);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonceBuf, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
    aesDek,
    ctBuf,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** 用已知 DEK 重加密 payload（条目变更的写路径）。 */
export async function encryptPayloadWithDek(
  envelope: Envelope,
  dek: Uint8Array,
  data: VaultData,
): Promise<Envelope> {
  const sealed = await sealJson(dek, data, PAYLOAD_AAD_PREFIX);
  return {
    ...envelope,
    payload: sealed,
    updatedAt: new Date().toISOString(),
  };
}

/** 用 DEK 直接解 payload（「记住解锁」的恢复路径，不经过主密码）。 */
export async function decryptWithDek(envelope: Envelope, dek: Uint8Array): Promise<VaultData> {
  return openJson<VaultData>(dek, envelope.payload);
}
