/**
 * 打发布包：把「能直接用的东西」装进一个 zip，用户解压 → 双击 install.cmd → 加载扩展。
 *
 * 产物结构（解压后）：
 *   localvault-v<ver>/
 *     ├─ ext/            扩展构建产物（浏览器里加载这个目录）
 *     ├─ host/           本地助手源码 + 预编译 exe + 编译脚本
 *     ├─ installer/      install.cmd / uninstall.cmd / diagnose.cmd / install.ps1
 *     ├─ README.md / README.en.md / LICENSE
 *     └─ SHA256SUMS.txt
 *
 * 用法：
 *   node tools/package-release.mjs            # 先构建扩展再打包
 *   node tools/package-release.mjs --no-build # 直接用现有 dist 打包
 */
import { execFileSync } from 'node:child_process';
import { writeZipDir } from './zip-writer.mjs';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const noBuild = process.argv.includes('--no-build');

const appPkg = JSON.parse(readFileSync(join(repo, 'app', 'package.json'), 'utf8'));
// 版本以扩展 manifest 为准（wxt.config.ts 里写死的那个），app/package.json 兜底
const wxtConfig = readFileSync(join(repo, 'app', 'wxt.config.ts'), 'utf8');
const manifestVer = /version:\s*'([^']+)'/.exec(wxtConfig)?.[1];
const version = manifestVer ?? appPkg.version ?? '0.0.0';
const name = `localvault-v${version}`;
const outRoot = join(repo, 'release');
const stage = join(outRoot, name);

function log(msg) { console.log('  ' + msg); }

/** Windows 脚本统一 CRLF；PowerShell 保留 BOM——5.1 靠 BOM 判编码，缺了中文会乱码。 */
function copyScript(src, dst) {
  const raw = readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
  const text = raw.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  writeFileSync(dst, (src.endsWith('.ps1') ? '\uFEFF' : '') + text, 'utf8');
}

// 1) 构建扩展
if (!noBuild) {
  console.log('==> 构建扩展（wxt build）');
  execFileSync('npm', ['run', 'build'], { cwd: join(repo, 'app'), stdio: 'inherit', shell: true });
}
const distDir = join(repo, 'app', 'dist', 'chrome-mv3');
if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error('找不到 app/dist/chrome-mv3/manifest.json —— 先 npm run build，或去掉 --no-build');
  process.exit(1);
}

// 2) 铺目录
console.log('==> 组装 ' + name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(distDir, join(stage, 'ext'), { recursive: true });
log('ext/（扩展构建产物）');

// host：**全部 .cs** 必须进包 —— 安装器从这里现场编译，少一个文件就编不过
// （尤其 Argon2Js.cs：缺了后台就拿不到 /argon2.js，主密码解不开）
mkdirSync(join(stage, 'host'), { recursive: true });
const hostExtras = new Set(['build.ps1', 'vault-host.exe', 'vault-host.exe.config']);
const hostFiles = readdirSync(join(repo, 'host'))
  .filter((f) => f.endsWith('.cs') || hostExtras.has(f))
  .sort();
for (const f of hostFiles) {
  const src = join(repo, 'host', f);
  const dst = join(stage, 'host', f);
  if (f.endsWith('.ps1')) copyScript(src, dst);
  else copyFileSync(src, dst);
  log('host/' + f);
}

// installer：启动器与图标也是必需项（缺 vault-ui.ps1 → 没有桌面快捷方式）
mkdirSync(join(stage, 'installer'), { recursive: true });
const installerFiles = [
  'install.ps1', 'install.cmd', 'uninstall.cmd', 'diagnose.cmd',
  'vault-ui.ps1', 'localvault.ico', 'localvault.svg',
];
for (const f of installerFiles) {
  const src = join(repo, 'installer', f);
  if (!existsSync(src)) { throw new Error('发布包缺少必需文件：installer/' + f); }
  const dst = join(stage, 'installer', f);
  if (f.endsWith('.ps1') || f.endsWith('.cmd') || f.endsWith('.bat')) copyScript(src, dst);
  else copyFileSync(src, dst);
  log('installer/' + f);
}

for (const f of ['README.md', 'README.en.md', 'LICENSE']) {
  const src = join(repo, f);
  if (existsSync(src)) { copyFileSync(src, join(stage, f)); log(f); }
}

// 3) 压缩：用自带 zip 写入器。
//    不能用 `tar -a -c -f x.zip`：Git Bash 的 GNU tar 不认识 .zip 的压缩器，
//    会写成一个改了后缀的 tar —— Windows 资源管理器与 Expand-Archive 都打不开。
console.log('==> 压缩');
const zipName = name + '.zip';
const zipPath = join(outRoot, zipName);
rmSync(zipPath, { force: true });
const zipInfo = writeZipDir(stage, zipPath);
log('zip: ' + zipInfo.files + ' 个文件');

// 4) 校验和
const buf = readFileSync(zipPath);
const sha = createHash('sha256').update(buf).digest('hex');
writeFileSync(zipPath + '.sha256', `${sha}  ${name}.zip\n`);
writeFileSync(join(stage, 'SHA256SUMS.txt'), `${sha}  ${name}.zip\n`);

const kb = (statSync(zipPath).size / 1024).toFixed(0);
console.log('');
console.log(`完成：${zipPath}`);
console.log(`大小：${kb} KB`);
console.log(`SHA256：${sha}`);
console.log('');
console.log('给用户的说明：解压后双击 installer\\install.cmd，再按提示把 ext/ 加载进浏览器。');
