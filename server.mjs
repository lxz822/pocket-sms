import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createApplication } from './src/app.mjs';

function argumentsOf(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lan') values.lan = true;
    else if (a === '--help' || a === '-h') values.help = true;
    else if (['--host', '--port', '--data-dir', '--public-url'].includes(a)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${a}缺少参数`);
      values[a.slice(2)] = args[++i];
    } else throw new Error(`不支持的参数：${a}`);
  }
  return values;
}
export async function startServer({ host = '127.0.0.1', port = 3210, dataDir, publicUrl = '', retentionHours = 24 } = {}) {
  const app = createApplication({ dataDir: dataDir || join(fileURLToPath(new URL('.', import.meta.url)), 'data'), publicUrl, retentionHours });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const authority = incoming.headers.host;
      if (!authority || /[\s\/@\\]/.test(authority) || !incoming.url?.startsWith('/')) {
        outgoing.writeHead(400); outgoing.end('Bad request'); return;
      }
      const request = new Request(`http://${authority}${incoming.url}`, {
        method: incoming.method, headers: incoming.headers,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
      });
      const reply = await app.handle(request, { remoteAddress: incoming.socket.remoteAddress, localAddress: incoming.socket.localAddress });
      outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
      outgoing.end(Buffer.from(await reply.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end('{"error":"无效请求"}');
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  try {
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  } catch (e) { app.close(); throw e; }
  const address = server.address();
  return { server, app, port: address.port, async close() { await new Promise(r => { server.close(r); server.closeIdleConnections(); }); app.close(); } };
}
async function main() {
  const args = argumentsOf(process.argv.slice(2));
  if (args.help) {
    console.log('随身收件箱 · 本地版\nnode server.mjs [--lan] [--host 地址] [--port 3210] [--data-dir 路径] [--public-url https://你的域名]\n默认仅本机访问，无账号、无登录。--lan启用手机连接，手机通过本机生成的配对链接查看。'); return;
  }
  const port = Number(args.port || process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为1到65535之间的整数');
  const host = args.host || process.env.HOST || (args.lan ? '0.0.0.0' : '127.0.0.1');
  const running = await startServer({ host, port,
    dataDir: args['data-dir'] || process.env.DATA_DIR,
    publicUrl: args['public-url'] || process.env.PUBLIC_URL || '',
    retentionHours: Number(process.env.RETENTION_HOURS || 24),
  });
  console.log(`随身收件箱已启动\n本机打开：http://127.0.0.1:${running.port}\n数据目录：${resolve(running.app.store.dataDir)}\n${host === '127.0.0.1' ? '仅本机访问。两台手机接入请使用：node server.mjs --lan' : '手机接入已启用。请在部署设备本机网页生成配对配置。'}\n按 Ctrl+C 退出。`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await running.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
