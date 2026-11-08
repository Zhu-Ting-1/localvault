/**
 * 扩展构建产物静态校验（manifest / 固定 ID / CSP）。
 *
 * 只读 app/dist/chrome-mv3，不需要私钥：扩展 ID 由 manifest.key（公钥）推导，
 * 必须与安装器里写死的 native messaging allowed_origins 一致 —— 这两处漂移会导致
 * 「扩展能装、但连不上本地助手」这种很难查的问题。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const dist = join(repo, 'app', 'dist', 'chrome-mv3');
const installer = join(repo, 'installer', 'install.ps1');

const errors = [];
const check = (cond, msg) => {
  if (!cond) errors.push(msg);
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + msg);
};

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('找不到 app/dist/chrome-mv3/manifest.json —— 先 cd app && npm run build');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));

check(manifest.manifest_version === 3, 'MV3 manifest');
check(manifest.name === 'LocalVault', 'name = LocalVault');
check(/^\d+\.\d+\.\d+$/.test(manifest.version), '版本号形如 x.y.z（' + manifest.version + '）');
check(Array.isArray(manifest.permissions) && manifest.permissions.includes('nativeMessaging'),
  '声明 nativeMessaging 权限');
check(!manifest.externally_connectable, '没有 externally_connectable（网页无法直连扩展）');
check(!manifest.web_accessible_resources || manifest.web_accessible_resources.length === 0,
  '没有 web_accessible_resources');
check(!!manifest.background?.service_worker, '有 service worker 入口');
check(existsSync(join(dist, manifest.background?.service_worker ?? '')), 'service worker 文件存在');

// 扩展 ID 推导：sha256(DER 公钥) 前 16 字节，按 0-f → a-p 映射
const keyB64 = manifest.key;
check(typeof keyB64 === 'string' && keyB64.length > 200, 'manifest.key 是完整公钥');
let id = '';
if (keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  id = [...hex].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
  check(/^[a-p]{32}$/.test(id), '扩展 ID 形如 32 位 a-p（' + id + '）');
}

// 与安装器里的 allowed_origins 对齐
const ps = readFileSync(installer, 'utf8');
const m = /\$ExtId\s*=\s*'([a-p]{32})'/.exec(ps);
check(!!m, 'installer/install.ps1 里能解析出 $ExtId');
if (m && id) {
  check(m[1] === id, '安装器的扩展 ID 与 manifest.key 推导结果一致（' + m[1] + '）');
}

// CSP：扩展页面不能加载远程脚本
const csp = manifest.content_security_policy?.extension_pages ?? '';
check(/script-src 'self'/.test(csp), 'CSP 只允许同源脚本');
check(!/https?:\/\//.test(csp), 'CSP 不含远程来源');

// 构建产物里不该有源映射
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs);
    else files.push(abs);
  }
})(dist);
check(!files.some((f) => f.endsWith('.map')), '产物不含 .map（不泄漏源码结构）');

console.log('');
if (errors.length) {
  console.error('扩展校验失败：' + errors.length + ' 项');
  process.exit(1);
}
console.log('扩展校验通过：' + files.length + ' 个文件，ID ' + id);
