import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { openStore } from './store.mjs';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const localIPs = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const stripSlash = value => value.replace(/\/+$/, '');

export function createApplication({ dataDir, retentionHours = 24, publicUrl = '', clock = Date.now } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!Number.isFinite(retentionHours) || retentionHours < 1 || retentionHours > 8760) throw new Error('RETENTION_HOURS 应在1到8760之间');
  if (publicUrl) {
    const u = new URL(publicUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('PUBLIC_URL 应为不带路径、密钥的 http(s) 地址');
    publicUrl = stripSlash(u.origin);
  }
  const store = openStore(dataDir, retentionHours, clock);
  let interfaces = {};
  try { interfaces = networkInterfaces(); } catch { /* Some containers/Android deny interface enumeration; manual addresses still work. */ }
  const networkHosts = new Set(Object.values(interfaces).flat().filter(Boolean).map(i => i.address));
  const allowedHosts = new Set([...localHosts, ...networkHosts, ...[...networkHosts].filter(v => v.includes(':')).map(v => `[${v}]`)]);
  if (publicUrl) allowedHosts.add(new URL(publicUrl).hostname);
  const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ].map(([route, [name, type]]) => [route, { body: readFileSync(new URL('../public/' + name, import.meta.url)), type }]));
  const timer = setInterval(() => { try { store.clean(); } catch { /* No SMS content is logged. */ } }, 60000);
  timer.unref();

  async function body(request, limit = 32768) {
    if (!request.body) throw new HttpError(400, '请求内容为空');
    if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, '请求内容太长');
    const reader = request.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, '请求内容太长'); }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const type = request.headers.get('content-type') || '';
    let result;
    try {
      if (type.startsWith('application/json')) result = JSON.parse(text);
      else if (type.startsWith('application/x-www-form-urlencoded')) result = Object.fromEntries(new URLSearchParams(text));
      else throw new HttpError(415, '请使用JSON或URL编码表单');
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, '请求格式错误'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(400, '需要对象或表单');
    return result;
  }
  const nameOf = (value, fallback) => (typeof value === 'string' ? value.trim().slice(0, 40) : '') || fallback;
  async function handle(request, { remoteAddress = '', localAddress = '' } = {}) {
    try {
      const url = new URL(request.url);
      const destination = localAddress.replace(/^::ffff:/, '');
      if (!allowedHosts.has(url.hostname) && url.hostname !== destination && url.hostname !== `[${destination}]`) throw new HttpError(421, '请使用本机地址、局域网IP或PUBLIC_URL访问');
      const managementKey = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
      const admin = (localIPs.has(remoteAddress) && localHosts.has(url.hostname)) || store.isManagementKey(managementKey);
      const route = url.pathname;
      if (route === '/api/health' && request.method === 'GET') return response({ ok: true });
      if (files.has(route) && ['GET', 'HEAD'].includes(request.method)) {
        const file = files.get(route);
        return new Response(request.method === 'HEAD' ? null : file.body, { headers: { ...headers, 'Content-Type': file.type } });
      }
      if (route === '/api/ingest' && request.method === 'POST') {
        const device = store.findKey('devices', request.headers.get('x-upload-key'));
        if (!device) throw new HttpError(401, '上传密钥无效或已撤销');
        const value = await body(request);
        if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 16000) throw new HttpError(400, 'content应为1到16000字符的短信文本');
        const text = (key, fallback = '') => String(value[key] ?? fallback).slice(0, 160);
        const result = store.ingest(device, { sender: text('from', '未知号码'), content: value.content,
          card: text('card', value.card_slot ?? ''), receivedAt: text('received_at', value.receive_time ?? ''), timestamp: text('timestamp') });
        return response({ code: 0, success: true, ...result, serverTime: clock() });
      }
      const key = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
      const viewer = !admin && key ? store.findKey('viewers', key) : null;
      if (!admin && !viewer) throw new HttpError(401, '请在部署设备本机打开网页，生成A手机的配对链接。无需注册账号。');
      if (request.method === 'GET' && route === '/api/state') {
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        const networkUrls = publicUrl ? [publicUrl] : [...networkHosts].filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v) && !v.startsWith('127.') && !v.startsWith('169.254.')).map(ip => `http://${ip}:${port}`);
        return response({ mode: admin ? 'admin' : 'viewer', instanceId: store.instanceId,
          devices: store.devices(), messages: store.list(), serverTime: clock(), retentionHours,
          ...(admin ? { viewers: store.viewers(), networkUrls, dataDir: store.dataDir } : {}) });
      }
      if (!admin) throw new HttpError(403, '此配对仅可查看短信，管理操作需在部署设备本机进行。');
      if (request.method !== 'POST') throw new HttpError(404, '接口不存在');
      // Browser mutations must originate from the local UI. No CORS, no trust in proxy headers.
      if (request.headers.get('origin') !== url.origin && !(publicUrl && request.headers.get('origin') === publicUrl && url.host === new URL(publicUrl).host)) throw new HttpError(403, '请求来源不符');
      if (!(request.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, '管理操作需要JSON');
      const value = await body(request, 4096);
      if (route === '/api/devices' || route === '/api/viewers') {
        const kind = route === '/api/devices' ? 'devices' : 'viewers';
        if ((kind === 'devices' ? store.devices() : store.viewers()).length >= 30) throw new HttpError(409, '最多30个配对，请先撤销旧配对');
        const added = store.add(kind, nameOf(value.name, kind === 'devices' ? 'B手机' : 'A手机'));
        return response({ ...added }, 201);
      }
      if (route === '/api/remove-device' || route === '/api/remove-viewer') {
        store.remove(route.endsWith('device') ? 'devices' : 'viewers', String(value.id || ''));
        return response({ success: true });
      }
      if (route === '/api/delete-message') {
        if (!Number.isSafeInteger(value.id) || value.id < 1) throw new HttpError(400, 'id无效');
        store.removeMessage(value.id); return response({ success: true });
      }
      if (route === '/api/clear') { store.clear(); return response({ success: true }); }
      if (route === '/api/test') { store.addTest(); return response({ success: true }); }
      throw new HttpError(404, '接口不存在');
    } catch (e) {
      if (e instanceof HttpError) return response({ error: e.message }, e.status);
      // Deliberately do not log request headers, request bodies, SMS or keys.
      return response({ error: '本地服务处理失败，请检查数据目录权限及磁盘空间。' }, 500);
    }
  }
  return { handle, store, close() { clearInterval(timer); store.close(); } };
}
