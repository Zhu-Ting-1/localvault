// 零依赖静态服务器，用于在真实浏览器里打开 fixtures 测试页。
// 用法：node tools/serve-fixtures.mjs [端口]
// file:// 下扩展默认不注入，所以测本地页必须走 http://localhost。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(join(here, '..', 'app', 'tests', 'fixtures', 'detector'));
const port = Number(process.argv[2] || 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = resolve(join(rootDir, normalize(urlPath)));
    if (!target.startsWith(rootDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(target).catch(() => null);
    const filePath = info && info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': types[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('fixtures 测试页已启动：http://localhost:' + port + '/');
  console.log('打开后逐个点开，看右下角 LocalVault 状态卡与蓝色描边。Ctrl+C 结束。');
});