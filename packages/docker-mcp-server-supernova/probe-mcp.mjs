import { spawn } from 'node:child_process';
import { once } from 'node:events';

const child = spawn(process.execPath, ['dist/index.js'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(d));
let buffer = '';
let nextId = 1;
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  while (true) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (e) {
      console.error('NONJSON', line);
    }
  }
});
function send(method, params = {}) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
}
const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-e2e', version: '0.0.0' } });
console.log('INIT', JSON.stringify(init.result ?? init.error, null, 2));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
const tools = await send('tools/list');
console.log('TOOLS', JSON.stringify((tools.result?.tools ?? []).map(t => ({ name: t.name, description: t.description?.slice(0, 90) })), null, 2));
child.kill();
await once(child, 'exit').catch(() => {});
