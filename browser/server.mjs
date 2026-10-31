import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { shellManifest, stampServiceWorker, archiveStamp, archiveEnabled, CSP } from './shell-manifest.mjs';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json':'application/json', '.svg':'image/svg+xml', '.glb':'model/gltf-binary', '.jpg':'image/jpeg' };
// Served files = the generated shell manifest (import graph, re-read per second so new files need no restart) plus optional local-only assets.
const optional = /^\/(?:vehicles\/[a-z0-9-]+\.glb|local\/npc-spawns\.json|world-map-art\.jpg|npc-pack\.json)$/;
let cached = { at: 0, manifest: null, set: new Set() };
async function shell() {
  if (Date.now() - cached.at > 1000) {
    const manifest = await shellManifest({ allowMissing: true });
    cached = { at: Date.now(), manifest, set: new Set([...manifest.files.map(f => '/' + f)]) };
  }
  return cached;
}const server = http.createServer(async (request, response) => {
  let path;
  try { path = new URL(request.url, 'http://localhost').pathname; }
  catch { response.writeHead(400).end('Invalid URL'); return; }
  const file = path === '/' ? '/index.html' : path;
  if(file==='/favicon.ico' && request.method==='GET'){response.writeHead(204).end();return;}
  if (request.method !== 'GET' || !((await shell()).set.has(file) || optional.test(file))) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    let bytes = await readFile(new URL(file==='/local/npc-spawns.json'?'../runtime/browser/npc-spawns.json':file==='/local/world-map.jpg'?'../runtime/browser/world-map.jpg':file==='/npc-pack.json'?'../runtime/browser/npc-pack.json':`.${file}`, import.meta.url));
    if (file === '/archive-flag.js') bytes = archiveStamp(bytes.toString('utf8'), archiveEnabled());
    if (file === '/sw.js') bytes = stampServiceWorker(bytes.toString('utf8'), (await shell()).manifest);
    response.writeHead(200, {
      'Content-Type': types[file.slice(file.lastIndexOf('.'))],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP(archiveEnabled()),
    }).end(bytes);
  } catch (error) {
    if((file==='/local/npc-spawns.json'||file==='/local/world-map.jpg'||file==='/npc-pack.json') && error.code==='ENOENT'){response.writeHead(404).end('No private local population pack');return;}
    if(error.code==='ENOENT'&&!file.startsWith('/pkg/')){response.writeHead(404).end('Not found');return;}
    console.error(`Cannot serve ${file}: ${error.message}`);
    response.writeHead(500).end('Build the Wasm package first; see server log.');
  }
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
server.listen(port, '127.0.0.1', () => console.log(`Local world: http://127.0.0.1:${port}`));
