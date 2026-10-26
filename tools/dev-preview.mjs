// Local development preview only. Uses a separate ignored database.
import { startServer } from '../server.mjs';
const args = process.argv.slice(2);
const read = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const port = Number(read('--port', 4173)), host = read('--host', '127.0.0.1');
const running = await startServer({ host, port, dataDir: '.preview-data', publicUrl: process.env.PREVIEW_URL || `http://terminal.local:${port}` });
console.log(`Development preview ready on port ${running.port}. This uses .preview-data, not your real inbox.`);
const stop = async () => { await running.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
