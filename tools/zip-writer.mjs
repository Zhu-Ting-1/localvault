/**
 * 极简 ZIP 打包器（零依赖）。
 *
 * 为什么不用 tar：Windows 上 `tar -a -c -f x.zip` 在 GNU tar（Git Bash 自带）里
 * 不会生成 zip —— 它按后缀找不到压缩器，直接写成未压缩 tar，文件名叫 .zip。
 * 资源管理器/Expand-Archive 都打不开，发布包等于废的。
 *
 * 这里用 zlib.deflateRawSync + 手写 ZIP 结构（本地头 + 中央目录 + EOCD），
 * 支持 UTF-8 文件名（通用标志位 11），足够做发布包。
 */
import { deflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/** 递归列出目录下所有文件，返回 [{ abs, rel, mtime }] */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, base, out);
    } else if (st.isFile()) {
      out.push({ abs, rel: relative(base, abs).split(sep).join('/'), mtime: st.mtime });
    }
  }
  return out;
}

/**
 * 把整个目录打成 zip。
 * @param {string} srcDir 要打包的目录（其内容成为 zip 根）
 * @param {string} outFile 输出 .zip 路径
 * @param {(rel: string) => boolean} [filter] 过滤（返回 false 跳过）
 */
export function writeZipDir(srcDir, outFile, filter) {
  const files = walk(srcDir)
    .filter((f) => (filter ? filter(f.rel) : true))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const raw = readFileSync(f.abs);
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const { time, day } = dosDateTime(f.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filename
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0x81a40000, 38);     // external attrs: -rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, eocd]));
  return { files: files.length, bytes: offset + centralBuf.length + eocd.length };
}
