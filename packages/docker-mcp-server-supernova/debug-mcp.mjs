import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['dist/index.js'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
child.stderr.on('data', (d) => process.stderr.write('STDERR: '+d.toString()));
child.stdout.on('data', (d) => process.stdout.write('STDOUT: '+JSON.stringify(d.toString())+'\n'));
child.on('exit', (c,s)=>console.error('EXIT',c,s));
setTimeout(()=>{
 const msg={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'codex-e2e',version:'0'}}};
 console.error('SEND init'); child.stdin.write(JSON.stringify(msg)+'\n');
}, 1000);
setTimeout(()=>{ console.error('KILL'); child.kill(); }, 60000);
