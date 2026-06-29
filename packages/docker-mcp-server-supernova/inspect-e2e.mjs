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
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
function send(method, params = {}) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
}
await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-e2e', version: '0.0.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
const list = await send('tools/list');
const toolNames = (list.result?.tools ?? []).map(t => t.name);
if (!toolNames.includes('inspect_container')) throw new Error('inspect_container missing');
const inspected = await send('tools/call', { name: 'inspect_container', arguments: { container_id: 'codex-mcp-inspect-test' } });
const text = inspected.result?.content?.find(c => c.type === 'text')?.text ?? '';
const parsed = JSON.parse(text);
console.log(JSON.stringify({ toolPresent: true, name: parsed.Name, image: parsed.Config?.Image, status: parsed.State?.Status, label: parsed.Config?.Labels?.['codex-e2e'] }, null, 2));
child.kill();
await once(child, 'exit').catch(() => {});
