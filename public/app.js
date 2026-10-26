'use strict';
const $ = id => document.getElementById(id);
let data = null, key = '', inFlight = false, pairing = false, timer;
const fragment = new URLSearchParams(location.hash.slice(1));
const fragmentKey = fragment.get('key') || fragment.get('admin') || '';
if (/^[a-f0-9]{64}$/.test(fragmentKey)) {
  key = fragmentKey;
  try { sessionStorage.setItem('viewer-key', key); } catch { /* Keep pairing in page memory when storage is disabled. */ }
  try { history.replaceState(null, '', location.pathname); } catch { /* No external navigation. */ }
} else {
  try { key = sessionStorage.getItem('viewer-key') || ''; } catch { /* A pairing link is required for remote viewing. */ }
}

function node(tag, text, className) {
  const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n;
}
function button(text, fn, className) { const n = node('button', text, className); n.type = 'button'; n.addEventListener('click', fn); return n; }
function notify(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(timer); timer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
async function copy(text) {
  try { if (!navigator.clipboard) throw Error(); await navigator.clipboard.writeText(text); notify('已复制'); }
  catch {
    const t = node('textarea'); t.value = text; t.setAttribute('aria-label', '复制内容'); t.className = 'copy-buffer'; document.body.append(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); notify(ok ? '已复制' : '请长按配置文本手动复制');
  }
}
function field(label, value) {
  const box = node('div', undefined, 'config'), title = node('label', label), t = node('textarea');
  t.value = value; t.readOnly = true; t.rows = Math.min(5, value.split('\n').length + (value.length > 100 ? 2 : 1)); t.setAttribute('aria-label', label);
  box.append(title, t, button('复制', () => copy(value), 'copy')); return box;
}
function formatDate(n) { return new Date(n).toLocaleString('zh-CN', { hour12: false }); }
function codeOf(text) { return /(?:验证码|校验码|动态码|verification code|code)[^\d]{0,15}(\d{4,8})(?!\d)/i.exec(text)?.[1]; }
async function request(path, value) {
  const headers = key ? { Authorization: 'Bearer ' + key } : {};
  const options = { headers, cache: 'no-store', signal: AbortSignal.timeout(10000) };
  if (value !== undefined) { options.method = 'POST'; headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(value); }
  const r = await fetch('/api/' + path, options), json = await r.json();
  if (!r.ok) { const e = new Error(json.error || '请求失败'); e.status = r.status; throw e; } return json;
}
async function act(path, value = {}) {
  try { const r = await request(path, value); await refresh(); return r; }
  catch (e) { notify(e.message || '操作失败'); throw e; }
}
function connection(text, warn) { $('connection').replaceChildren(node('i', undefined, 'dot' + (warn ? ' warn' : '')), node('span', text)); }
async function refresh() {
  if (inFlight) return; inFlight = true;
  try {
    data = await request('state'); $('error').hidden = true;
    for (const n of document.querySelectorAll('.admin')) n.hidden = data.mode !== 'admin';
    connection(data.mode === 'admin' ? '本地管理 · 每2秒检查' : '配对查看 · 每2秒检查', false);
    $('device-count').textContent = data.devices.length;
    $('devices').replaceChildren(...data.devices.map(d => {
      const box = node('div', undefined, 'device'); box.append(node('strong', '▯ ' + d.name), node('small', d.lastSeen ? '最近上传 ' + formatDate(d.lastSeen) : '等待首次上传')); return box;
    }));
    if (!data.devices.length) $('devices').append(node('div', '还没有接入备用机', 'no-device'));
    const filter = $('device-filter'), previous = filter.value;
    filter.replaceChildren(new Option('全部设备', 'all'), ...data.devices.map(d => new Option(d.name, d.id)));
    if ([...filter.options].some(o => o.value === previous)) filter.value = previous;
    $('checked').textContent = '上次检查 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' · 保存' + data.retentionHours + '小时，最多显示200条';
    renderMessages();
  } catch (e) {
    $('error').textContent = e.message || '同步中断，请检查本地服务和网络。'; $('error').hidden = false; connection('同步中断', true);
    // A revoked key must not leave already-read SMS visible in an active page.
    if (e.status === 401) { data = null; $('messages').replaceChildren(); $('devices').replaceChildren(); for (const n of document.querySelectorAll('.admin')) n.hidden = true; }
  } finally { inFlight = false; }
}
function renderMessages() {
  if (!data) return;
  const q = $('query').value.trim().toLowerCase(), filter = $('device-filter').value;
  const items = data.messages.filter(m => (filter === 'all' || m.deviceId === filter) && (m.sender + ' ' + m.content + ' ' + m.card).toLowerCase().includes(q));
  const parent = $('messages'); parent.replaceChildren();
  if (!items.length) {
    const box = node('div', undefined, 'empty');
    box.append(node('div', '✉', 'empty-icon'), node('h2', q || filter !== 'all' ? '没有匹配的短信' : data.devices.length ? '等待备用机发来第一条短信' : '把B手机接进来'), node('p', q ? '换个关键词或选择全部设备。' : '完成一次上传设置后，这里会自动显示新短信。'));
    if (!data.devices.length && data.mode === 'admin') box.append(button('开始接入 ↗', () => openPair('device'), 'primary'));
    parent.append(box); return;
  }
  for (const m of items) {
    const article = node('article', undefined, 'message'), head = node('div', undefined, 'msg-head'), sender = node('span', m.sender, 'sender');
    const deviceName = m.isTest ? '网页测试' : data.devices.find(d => d.id === m.deviceId)?.name || '备用机';
    sender.append(node('span', deviceName + (m.card ? ' · ' + m.card : ''), 'tag')); head.append(sender);
    if (data.mode === 'admin') head.append(button('×', async () => { if (confirm('删除网页中的这条短信？B手机原短信不受影响。')) await act('delete-message', { id: m.id }).catch(() => {}); }, 'icon-btn'));
    const meta = node('div', undefined, 'meta'); meta.append(node('span', '上传 ' + formatDate(m.uploadedAt)));
    if (m.receivedAt) meta.append(node('span', 'B接收 ' + m.receivedAt));
    const code = codeOf(m.content); if (code) meta.append(button(code + ' ⧉', () => copy(code), 'code'));
    meta.append(button('复制全文', () => copy(m.content)));
    article.append(head, node('p', m.content, 'body'), meta); parent.append(article);
  }
}
function show(title, content) {
  $('setup-title').textContent = title; $('setup-body').replaceChildren(...content);
  if (!$('setup').open) $('setup').showModal();
}
function closeDialog() {
  if (pairing && !confirm('配置仅显示这一次。请先保存到手机。确定关闭？')) return;
  pairing = false; $('setup').close(); $('setup-body').replaceChildren();
}
function baseEditor() {
  const label = node('label', '手机可访问的部署设备地址', 'address-label'), input = node('input'); input.className = 'full'; input.type = 'url'; input.value = data.networkUrls?.[0] || location.origin; input.placeholder = 'http://192.168.1.20:3210'; input.setAttribute('aria-label', label.textContent);
  const note = node('p', '局域网填写部署设备的局域网IP；外出查看填写你自己的私人网络地址。不要填127.0.0.1，那个地址在手机上代表手机自己。');
  return { label, input, note };
}
function validateBase(value) {
  let u; try { u = new URL(value); } catch { throw Error('请输入完整的 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('请输入不带路径和密钥的 http(s) 地址');
  if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw Error('手机连接请填写部署设备的局域网IP或私人网络地址');
  return u.origin;
}
function openPair(kind) {
  if (!data || data.mode !== 'admin') return;
  const title = kind === 'device' ? '接入B手机' : '在A手机上查看';
  const intro = node('p', kind === 'device' ? 'B端继续使用你已有的安卓短信转发器，直接上传到自己的设备。' : '不需要账号。生成专属查看链接，在A手机浏览器打开即可。');
  const name = node('input'); name.value = kind === 'device' ? 'B手机' : 'A手机'; name.maxLength = 40; name.setAttribute('aria-label', '配对名称'); name.className = 'full';
  const base = baseEditor(), note = node('div', '每个配对只属于当前部署。配置中没有公共服务器，也没有其他人的信息。', 'notice');
  const submit = button('生成配对配置', async () => {
    let origin; try { origin = validateBase(base.input.value); } catch (e) { notify(e.message); return; }
    submit.disabled = true;
    try { const added = await act(kind === 'device' ? 'devices' : 'viewers', { name: name.value }); pairing = true; renderPair(kind, added, origin); }
    catch { submit.disabled = false; }
  }, 'primary');
  show(title, [intro, node('label', '配对名称', 'address-label'), name, base.label, base.input, base.note, note, submit]);
}
function renderPair(kind, added, base) {
  const parts = [node('div', '配置仅显示这一次，请只保存到你自己的手机。丢失后可以在“管理配对”里撤销并重新生成。', 'banner')];
  if (kind === 'device') {
    parts.push(node('h3', '1. 新增Webhook发送通道'), node('p', '短信转发器 → 发送通道 → 添加 → Webhook；请求方式选择POST。'), field('请求地址 / WebServer', base + '/api/ingest'), node('p', '在自定义请求头中点加号：名称填写 X-Upload-Key，值复制下方内容。'), field('X-Upload-Key 的值', added.key), field('请求参数 / webParams（表单）', 'from=[from]&content=[org_content]&card=[card_slot]&received_at=[receive_time]&timestamp=[timestamp]'), node('p', '加签Secret留空，消息模板保持默认。'), node('h3', '2. 保存通道并绑定短信规则'), node('p', '在“转发规则”中添加短信规则，选择该Webhook通道，并检查双卡范围。'), node('h3', '3. 向B号码发一条普通短信'), node('p', '通道测试不代表完整接收成功；发一条真实的测试短信，确认收件箱自动出现。'));
  } else {
    parts.push(field('A手机配对链接', base + '/#key=' + added.key), node('p', '在A手机浏览器打开该链接。链接中的密钥只用于配对这台本地服务，不经过外部账号。'), node('p', 'A手机可查看和复制该实例全部短信，不能更改配对或删除短信。密钥仅保存在此浏览器标签页的会话中；新会话需再次打开原配对链接。'));
  }
  parts.push(button('我已保存，返回收件箱', () => { pairing = false; closeDialog(); }, 'primary'));
  show(kind === 'device' ? 'B手机上传配置' : 'A手机查看链接', parts);
}
function manage() {
  const content = [node('h3', 'B手机上传配对')];
  const row = (item, path, description) => { const box = node('div', undefined, 'remove-row'); box.append(node('span', item.name), button('撤销', async () => { if (confirm(description)) { await act(path, { id: item.id }).catch(() => {}); manage(); } }, 'danger')); return box; };
  if (!data.devices.length) content.push(node('p', '还没有上传配对。'));
  for (const item of data.devices) content.push(row(item, 'remove-device', '撤销该备用机的上传权限，并删除它上传的网页短信？'));
  content.push(node('h3', 'A手机查看配对'));
  if (!data.viewers.length) content.push(node('p', '还没有查看配对。'));
  for (const item of data.viewers) content.push(row(item, 'remove-viewer', '撤销这个查看配对？对应手机将无法继续读取短信。'));
  content.push(node('h3', '本地数据'), node('p', '数据目录：'), node('p', data.dataDir, 'local-path'), node('p', '实例编号：' + data.instanceId, 'local-path'), node('p', `短信保存${data.retentionHours}小时，到期后由运行中的程序清理。停止程序时计时清理暂停，重启会补清理。`), button('生成一条网页测试消息', () => act('test').catch(() => {})), node('p', '测试消息只验证网页和本地数据库，不代表B手机已接入。'));
  show('管理配对与本地数据', content);
}
$('add-device').addEventListener('click', () => openPair('device'));
$('add-viewer').addEventListener('click', () => openPair('viewer'));
$('manage').addEventListener('click', manage);
$('close-dialog').addEventListener('click', closeDialog);
$('setup').addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
$('refresh').addEventListener('click', refresh);
$('query').addEventListener('input', renderMessages);
$('device-filter').addEventListener('change', renderMessages);
$('clear').addEventListener('click', () => { if (confirm('清空此实例全部网页短信？B手机原短信不受影响。')) act('clear').catch(() => {}); });
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else connection('后台暂停刷新', true); });
window.addEventListener('online', refresh);
refresh();
