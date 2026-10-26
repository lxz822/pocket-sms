// Run on your own deployment machine/container. Prints a management pairing link;
// never include its output in public issues, screenshots or application logs.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const base = new URL(process.argv[2] || process.env.PUBLIC_URL || 'http://127.0.0.1:3210');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash || base.search || base.pathname !== '/') throw Error('需要不带路径的http(s)地址');
  const key = readFileSync(join(resolve(process.env.DATA_DIR || join(root, 'data')), 'management-key.txt'), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('无效的管理密钥文件');
  console.log(`${base.origin}/#admin=${key}`);
} catch (e) { console.error('先启动服务，再生成管理配对链接。' + e.message); process.exitCode = 1; }
