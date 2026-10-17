import http from 'node:http';
import { readFile } from 'node:fs/promises';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json':'application/json' };
const allowed = /^\/(?:index\.html|world-(?:app|client|worker|store|renderer|camera|input|audio|tuning)\.js|asset-(?:source|folder)\.js|(?:scene|terrain|craft)-stream\.js|camera-collision\.js|flight\.js|style\.css|sw\.js|local\/npc-spawns\.json|pkg\/flats_racer_web(?:_bg\.wasm|\.js))$/;
const server = http.createServer(async (request, response) => {
  let path;
  try { path = new URL(request.url, 'http://localhost').pathname; }
  catch { response.writeHead(400).end('Invalid URL'); return; }
  const file = path === '/' ? '/index.html' : path;
  if(file==='/favicon.ico' && request.method==='GET'){response.writeHead(204).end();return;}
  if (request.method !== 'GET' || !allowed.test(file)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const bytes = await readFile(new URL(file==='/local/npc-spawns.json'?'../runtime/browser/npc-spawns.json':`.${file}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': types[file.slice(file.lastIndexOf('.'))],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    }).end(bytes);
  } catch (error) {
    if(file==='/local/npc-spawns.json' && error.code==='ENOENT'){response.writeHead(404).end('No private local population pack');return;}
    console.error(`Cannot serve ${file}: ${error.message}`);
    response.writeHead(500).end('Build the Wasm package first; see server log.');
  }
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
server.listen(4173, '127.0.0.1', () => console.log('Local world: http://127.0.0.1:4173'));
