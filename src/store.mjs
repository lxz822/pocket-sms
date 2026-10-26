import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const newKey = () => randomBytes(32).toString('hex');

export function openStore(directory, retentionHours = 24, clock = Date.now) {
  const dataDir = resolve(directory);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'inbox.sqlite');
  const db = new DatabaseSync(path, { timeout: 5000 });
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the user. */ }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('数据库版本高于程序版本，请升级程序。'); }
  if (!version) db.exec(`
    BEGIN;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen INTEGER
    ) STRICT;
    CREATE TABLE viewers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      sender TEXT NOT NULL, content TEXT NOT NULL, card TEXT NOT NULL,
      received_at TEXT NOT NULL, uploaded_at INTEGER NOT NULL,
      dedupe TEXT NOT NULL UNIQUE, is_test INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX messages_time ON messages(uploaded_at);
    INSERT INTO settings VALUES ('instance_id', '${randomUUID()}');
    PRAGMA user_version=1;
    COMMIT;
  `);
  const managementFile = join(dataDir, 'management-key.txt');
  if (!existsSync(managementFile)) writeFileSync(managementFile, newKey() + '\n', { flag: 'wx', mode: 0o600 });
  const managementKey = readFileSync(managementFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(managementKey)) { db.close(); throw new Error('management-key.txt格式无效，请恢复备份或移除该文件后重启以重新生成。'); }
  const managementHash = hash(managementKey);
  const instanceId = db.prepare("SELECT value FROM settings WHERE key='instance_id'").get().value;
  const cutoff = () => clock() - retentionHours * 3600000;
  const clean = () => db.prepare('DELETE FROM messages WHERE uploaded_at < ?').run(cutoff());
  clean();
  const devices = () => db.prepare('SELECT id, name, created_at AS createdAt, last_seen AS lastSeen FROM devices ORDER BY created_at').all();
  const viewers = () => db.prepare('SELECT id, name, created_at AS createdAt FROM viewers ORDER BY created_at').all();
  const list = () => {
    clean();
    return db.prepare(`SELECT id, device_id AS deviceId, sender, content, card, received_at AS receivedAt,
      uploaded_at AS uploadedAt, is_test AS isTest FROM messages ORDER BY id DESC LIMIT 200`).all();
  };
  function add(kind, name) {
    if (!['devices', 'viewers'].includes(kind)) throw new Error('Invalid kind');
    if (db.prepare(`SELECT count(*) AS n FROM ${kind}`).get().n >= 30) throw new Error('最多30个配对，请先移除旧配对。');
    const id = randomUUID(), key = newKey();
    db.prepare(`INSERT INTO ${kind} (id,name,key_hash,created_at) VALUES (?,?,?,?)`).run(id, name, hash(key), clock());
    return { id, name, key };
  }
  function findKey(kind, key) {
    if (!['devices', 'viewers'].includes(kind) || !/^[a-f0-9]{64}$/.test(key || '')) return null;
    return db.prepare(`SELECT id,name FROM ${kind} WHERE key_hash=?`).get(hash(key));
  }
  function remove(kind, id) {
    if (!['devices', 'viewers'].includes(kind)) throw new Error('Invalid kind');
    db.prepare(`DELETE FROM ${kind} WHERE id=?`).run(id);
  }
  function ingest(device, sms) {
    const now = clock();
    // Source receipt time is preferred; upload timestamp is a fallback. Without either,
    // retain each message rather than accidentally merging two real identical texts.
    const sourceId = sms.receivedAt || sms.timestamp;
    const dedupe = sourceId ? hash(JSON.stringify([device.id, sms.sender, sms.content, sms.card, sourceId])) : randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare(`INSERT OR IGNORE INTO messages
        (device_id,sender,content,card,received_at,uploaded_at,dedupe) VALUES (?,?,?,?,?,?,?)`)
        .run(device.id, sms.sender, sms.content, sms.card, sms.receivedAt, now, dedupe);
      db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now, device.id);
      clean();
      db.exec('COMMIT');
      return { duplicate: result.changes === 0 };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return {
    path, dataDir, instanceId, retentionHours, devices, viewers, list, add, findKey, remove, ingest, clean,
    isManagementKey: key => /^[a-f0-9]{64}$/.test(key || '') && hash(key) === managementHash,
    removeMessage: id => db.prepare('DELETE FROM messages WHERE id=?').run(id),
    clear: () => db.prepare('DELETE FROM messages').run(),
    addTest: () => db.prepare(`INSERT INTO messages (device_id,sender,content,card,received_at,uploaded_at,dedupe,is_test)
      VALUES (NULL,?,?,?,?,?,?,1)`).run('网页测试', '测试验证码 123456。这只验证网页和本地数据库，不代表B手机已接入。', '测试', '', clock(), randomUUID()),
    close: () => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); },
  };
}
