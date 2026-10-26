import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.mjs';
import { startServer } from '../server.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'pocket-sms-test-'));
function api(app, route, { method = 'GET', value, key, upload, local = true, host = '127.0.0.1:3210', origin, type = 'application/json', raw, extra = {} } = {}) {
  const headers = { ...extra }; if (key) headers.Authorization = 'Bearer ' + key; if (upload) headers['X-Upload-Key'] = upload;
  if (method === 'POST') { headers['Content-Type'] = type; headers.Origin = origin ?? 'http://' + host; }
  const request = new Request('http://' + host + route, { method, headers, ...(method === 'POST' ? { body: raw ?? JSON.stringify(value ?? {}) } : {}) });
  return app.handle(request, { remoteAddress: local ? '127.0.0.1' : '192.168.10.99' });
}
test('no accounts: local administration, per-device upload and read-only viewer pairing', async () => {
  const dir = temp(); const app = createApplication({ dataDir: dir });
  try {
    assert.equal((await api(app, '/api/state')).status, 200);
    assert.equal((await api(app, '/api/state', { local: false })).status, 401);
    assert.equal((await api(app, '/api/state', { local: false, extra: { 'X-Forwarded-For': '127.0.0.1', 'oai-authenticated-user-id': 'fake' } })).status, 401);
    assert.equal((await api(app, '/api/state', { host: 'attacker.example:3210' })).status, 421);
    assert.equal((await api(app, '/api/devices', { method: 'POST', origin: 'http://attacker.example' })).status, 403);
    const d = await (await api(app, '/api/devices', { method: 'POST', value: { name: 'B <script>' } })).json();
    const v = await (await api(app, '/api/viewers', { method: 'POST', value: { name: 'A手机' } })).json();
    const sms = { from: '10086', content: '验证码 123456，"引号" & + 换行\n中文🙂', card: 'SIM2', received_at: '2026-10-26 18:00:00', timestamp: '100' };
    const upload = () => api(app, '/api/ingest', { method: 'POST', local: false, upload: d.key, value: sms });
    assert.equal((await upload()).status, 200);
    assert.equal((await (await upload()).json()).duplicate, true);
    let state = await (await api(app, '/api/state', { local: false, key: v.key })).json();
    assert.equal(state.messages.length, 1); assert.equal(state.messages[0].content, sms.content);
    assert.equal(state.messages[0].card, 'SIM2'); assert.equal(state.mode, 'viewer');
    assert.equal(state.dataDir, undefined); assert.equal(state.viewers, undefined);
    assert.equal(JSON.stringify(state).includes(d.key), false);
    assert.equal((await api(app, '/api/devices', { method: 'POST', local: false, key: v.key })).status, 403);
    assert.equal((await api(app, '/api/clear', { method: 'POST', local: false, upload: d.key })).status, 401);
    // The source receipt time, not a newly-generated retry timestamp, controls deduplication.
    sms.timestamp = '200'; await upload();
    assert.equal((await (await api(app, '/api/state')).json()).messages.length, 1);
    sms.received_at = '2026-10-26 18:01:00'; await upload();
    assert.equal((await (await api(app, '/api/state')).json()).messages.length, 2);
    const form = new URLSearchParams({ ...sms, content: 'URL编码 & + 中文🙂', received_at: '2026-10-26 18:02:00' });
    assert.equal((await api(app, '/api/ingest', { method: 'POST', local: false, upload: d.key, type: 'application/x-www-form-urlencoded;charset=UTF-8', raw: form.toString() })).status, 200);
    state = await (await api(app, '/api/state')).json(); assert.equal(state.messages[0].content, 'URL编码 & + 中文🙂');
    assert.equal((await api(app, '/api/ingest', { method: 'POST', upload: d.key, value: { content: 'x'.repeat(33000) } })).status, 413);
    assert.equal((await api(app, '/api/ingest', { method: 'POST', upload: d.key, raw: '{' })).status, 400);
    assert.equal((await api(app, '/api/ingest', { method: 'POST', upload: d.key, value: { content: 123 } })).status, 400);
    assert.equal((await api(app, '/api/ingest', { method: 'POST', upload: d.key, type: 'text/plain', raw: 'abc' })).status, 415);
    await api(app, '/api/remove-viewer', { method: 'POST', value: { id: v.id } });
    assert.equal((await api(app, '/api/state', { local: false, key: v.key })).status, 401);
    await api(app, '/api/remove-device', { method: 'POST', value: { id: d.id } });
    assert.equal((await upload()).status, 401);
    assert.equal((await (await api(app, '/api/state')).json()).messages.length, 0);
  } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('independent local databases, key isolation, persistence and expiry', async () => {
  const aDir = temp(), bDir = temp(); let now = 2000000000000;
  let a = createApplication({ dataDir: aDir, clock: () => now });
  const b = createApplication({ dataDir: bDir, clock: () => now });
  try {
    const config = await (await api(a, '/api/devices', { method: 'POST' })).json();
    const viewer = await (await api(a, '/api/viewers', { method: 'POST' })).json();
    const sms = { content: '仅在A实例', timestamp: '2000000000000' };
    await api(a, '/api/ingest', { method: 'POST', upload: config.key, value: sms });
    assert.notEqual(a.store.instanceId, b.store.instanceId);
    assert.equal((await api(b, '/api/ingest', { method: 'POST', upload: config.key, value: sms })).status, 401);
    assert.equal((await api(b, '/api/state', { local: false, key: viewer.key })).status, 401);
    assert.equal(b.store.list().length, 0);
    const id = a.store.instanceId; a.close(); a = createApplication({ dataDir: aDir, clock: () => now });
    assert.equal(a.store.instanceId, id); assert.equal(a.store.list().length, 1);
    assert.equal((await api(a, '/api/state', { local: false, key: viewer.key })).status, 200);
    now += 25 * 3600000; assert.equal(a.store.list().length, 0);
  } finally { a.close(); b.close(); rmSync(aDir, { recursive: true, force: true }); rmSync(bDir, { recursive: true, force: true }); }
});
test('management pairing for containers and HTTPS reverse proxies', async () => {
  const dir = temp(), app = createApplication({ dataDir: dir, publicUrl: 'https://sms.example.test' });
  try {
    const admin = readFileSync(join(dir, 'management-key.txt'), 'utf8').trim();
    assert.equal((await api(app, '/api/state', { local: false, host: 'sms.example.test', key: admin })).status, 200);
    assert.equal((await api(app, '/api/devices', { method: 'POST', local: false, host: 'sms.example.test', origin: 'https://sms.example.test', key: admin })).status, 201);
    assert.equal((await api(app, '/api/devices', { method: 'POST', local: false, host: 'sms.example.test', origin: 'https://evil.example', key: admin })).status, 403);
  } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('actual HTTP server: assets, upload, local database and bounded errors', async () => {
  const dir = temp(), running = await startServer({ port: 0, dataDir: dir });
  try {
    const base = 'http://127.0.0.1:' + running.port;
    let r = await fetch(base + '/'); assert.equal(r.status, 200);
    assert.match(await r.text(), /无需账号/); assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
    const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...extra }, body: JSON.stringify(value) });
    const d = await (await post('/api/devices', { name: 'HTTP测试' })).json();
    assert.equal((await post('/api/ingest', { content: 'HTTP验证码 246810', timestamp: 'http-1' }, { 'X-Upload-Key': d.key })).status, 200);
    const state = await (await fetch(base + '/api/state')).json(); assert.equal(state.messages[0].content, 'HTTP验证码 246810');
    assert.equal((await fetch(base + '/data/inbox.sqlite')).status, 404);
    assert.equal((await fetch(base + '/.env')).status, 404);
    await post('/api/test', {}); await post('/api/clear', {});
    assert.equal((await (await fetch(base + '/api/state')).json()).messages.length, 0);
  } finally { await running.close(); rmSync(dir, { recursive: true, force: true }); }
});
