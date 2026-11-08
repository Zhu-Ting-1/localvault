/**
 * 生成「可以直接推到 GitHub」的干净源码目录。
 *
 * 为什么不用 `git archive`：这个仓库的历史里有过开发期私钥、原型脚本与本机绝对路径，
 * 直接推历史等于把它们一起公开。这里按**白名单**从工作树重建一份，并用规则扫描确认
 * 没有私钥 / 令牌 / 本机用户名 / 本机绝对路径，扫到就失败退出。
 *
 * 用法：
 *   node tools/make-github-export.mjs
 *   node tools/make-github-export.mjs --deny=foo.com,bar.com   # 额外要拦的关键词
 *
 * 产物：
 *   release/github/localvault/          ← 目录（git init 在这里）
 *   release/github/localvault-src.zip   ← 同内容的 zip（方便先看）
 *   release/github/leak-report.txt      ← 扫描报告（不要提交/上传）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZipDir } from './zip-writer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const outRoot = join(repo, 'release', 'github');
const stage = join(outRoot, 'localvault');

// ---------- 白名单 ----------
const INCLUDE_FILES = [
  'README.md', 'README.en.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md',
  'package.json', '.gitignore', '.gitattributes',
];
// 注：根目录的《发布要求.md》是内部发布门槛，不随开源版导出（白名单天然排除）。
// 注：根目录的《发布要求.md》是内部发布门槛，不随开源版导出（白名单天然排除）。
const INCLUDE_DIRS = ['app', 'host', 'installer', 'tools', 'screenshots', '.github'];

// ---------- 排除（相对仓库根，posix 分隔符）----------
const DENY_PATH = [
  /^app\/(dist|\.wxt|\.output|node_modules|reports|\.turbo)\//,
  /^host\/vault-host\.exe$/,
  /(^|\/)\.test-vault\//,                 // 测试用保险库（含 vault.db.bak / ui.port 等）
  /(^|\/)\.migration-notes\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
];
const DENY_EXT = new Set([
  '.exe', '.dll', '.pdb', '.pem', '.pfx', '.p12', '.db', '.log', '.zip', '.key',
  '.bak', '.lock', '.port', '.pid',
]);
// 运行时数据文件名：不管扩展名是什么，一律不导出
const DENY_NAME = /^(vault\.db(\..*)?|ui\.(port|pid)|session\.key|tpm\.wrapping|audit\.log|host\.log|vault\.lock)$/;

// ---------- 泄漏扫描规则 ----------
const userName = (process.env.USERNAME || process.env.USER || '').trim();
const extraDeny = (process.argv.find((a) => a.startsWith('--deny=')) || '')
  .replace('--deny=', '').split(',').map((s) => s.trim()).filter(Boolean);

const RULES = [
  { name: '私钥', re: /BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY/ },
  { name: '私钥字段', re: /privateKeyPem\s*:/ },
  { name: '访问令牌', re: /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/ },
  { name: '本机绝对路径', re: /[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9_.-]+)/, allow: (m) => m[1] === '<user>' || m[1] === '$user' || m[1] === 'Public' },
];
if (userName.length >= 3) {
  RULES.push({
    name: '本机用户名',
    re: new RegExp(`\\b${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  });
}
for (const word of extraDeny) {
  RULES.push({ name: '自定关键词 ' + word, re: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
}

const TEXT_EXT = new Set([
  '', '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.cs', '.ps1',
  '.cmd', '.bat', '.html', '.css', '.yml', '.yaml', '.svg', '.gitignore', '.gitattributes',
  '.csv', '.py',
]);

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) listFiles(abs, base, out);
    else out.push({ abs, rel: relative(base, abs).split(sep).join('/') });
  }
  return out;
}

function denied(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (DENY_NAME.test(base)) return '运行时数据文件';
  if (/(^|\/)node_modules(\/|$)/.test(rel)) return 'node_modules';
  if (DENY_PATH.some((re) => re.test(rel))) return '路径规则';
  const dot = rel.lastIndexOf('.');
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  if (DENY_EXT.has(ext)) return '扩展名 ' + ext;
  return null;
}

// ---------- 1) 收集 ----------
const picked = [];
const skipped = [];
for (const f of INCLUDE_FILES) {
  const abs = join(repo, f);
  if (!existsSync(abs)) { skipped.push({ rel: f, why: '不存在（可选文件）' }); continue; }
  picked.push({ abs, rel: f });
}
for (const d of INCLUDE_DIRS) {
  const base = join(repo, d);
  if (!existsSync(base)) { skipped.push({ rel: d + '/', why: '目录不存在' }); continue; }
  for (const f of listFiles(base)) {
    // listFiles 的 rel 是相对 base 的，这里必须补回顶层目录，否则 ^app/... 之类的规则全失效
    const rel = d + '/' + f.rel;
    const why = denied(rel);
    if (why) skipped.push({ rel, why });
    else picked.push({ abs: f.abs, rel });
  }
}

// ---------- 2) 复制 ----------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
let bytes = 0;
for (const f of picked) {
  const dest = join(stage, f.rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f.abs, dest);
  bytes += statSync(dest).size;
}

// ---------- 3) 泄漏扫描 ----------
const findings = [];
const warnings = [];
const textFiles = picked.filter((f) => TEXT_EXT.has(f.rel.slice(f.rel.lastIndexOf('.'))));

for (const f of textFiles) {
  const text = readFileSyncSafe(join(stage, f.rel));
  if (text == null) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      const m = rule.re.exec(lines[i]);
      if (!m) continue;
      if (rule.allow && rule.allow(m)) continue;
      findings.push({ rel: f.rel, line: i + 1, rule: rule.name, sample: lines[i].trim().slice(0, 120) });
      break;
    }
  }
  // 一致性提醒：引用了导出里不存在的旧目录。
  // 只检查代码目录；忽略格式字符串 localvault-spike/v1（信封格式常量）。
  if (/^(app|host|tools|installer|mvp-detect)\//.test(f.rel) && f.rel !== 'tools/make-github-export.mjs') {
    for (const ghost of ['spike/', 'mockups/']) {
      if (new RegExp('(?<!localvault-)' + ghost).test(text)) warnings.push({ rel: f.rel, ghost });
    }
  }
}

// ---------- 4) 报告 ----------
const kb = (bytes / 1024).toFixed(0);
const report = [
  'LocalVault · GitHub 导出报告',
  '时间：' + new Date().toISOString(),
  '',
  '文件：' + picked.length + ' 个，' + kb + ' KB（文本 ' + textFiles.length + ' 个）',
  '排除：' + skipped.length + ' 项',
  '',
  '=== 泄漏扫描 ===',
  findings.length === 0
    ? '✅ 未发现私钥 / 令牌 / 本机绝对路径 / 本机用户名'
    : '❌ 发现 ' + findings.length + ' 处可疑内容：\n' + findings.map((f) => `  ${f.rel}:${f.line}  [${f.rule}]  ${f.sample}`).join('\n'),
  '',
  '=== 文档一致性 ===',
  warnings.length === 0
    ? '✅ 没有引用未导出的历史目录'
    : '⚠️ 以下文件提到了导出里不存在的目录（spike/、mockups/）：\n' +
      [...new Set(warnings.map((w) => w.rel))].map((r) => '  ' + r).join('\n'),
  '',
  '=== 被排除的项（前 40）===',
  skipped.slice(0, 40).map((s) => `  ${s.rel}  —  ${s.why}`).join('\n'),
  skipped.length > 40 ? `  …… 其余 ${skipped.length - 40} 项见控制台` : '',
].join('\n');

mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, 'leak-report.txt'), report, 'utf8');
console.log(report);

// ---------- 5) 打包 ----------
const zipPath = join(outRoot, 'localvault-src.zip');
const info = writeZipDir(stage, zipPath);
console.log('\n目录：' + stage);
console.log('压缩：' + zipPath + '（' + info.files + ' 个文件，' + (info.bytes / 1024).toFixed(0) + ' KB）');

if (findings.length) {
  console.error('\n导出中止：扫描发现可疑内容，处理后再试。');
  process.exit(1);
}

console.log('\n下一步（确认无误后手动执行）：');
console.log('  cd release/github/localvault');
console.log('  git init -b main && git add -A && git commit -m "initial public release v0.3.0"');
console.log('  git remote add origin git@github.com:<你的账号>/localvault.git && git push -u origin main');

function readFileSyncSafe(p) {
  try {
    const buf = readFileSync(p);
    if (buf.includes(0)) return null; // 粗略判断二进制
    return buf.toString('utf8');
  } catch { return null; }
}
