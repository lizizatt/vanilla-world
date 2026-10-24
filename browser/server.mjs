import http from 'node:http';
import { readFile } from 'node:fs/promises';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json':'application/json', '.svg':'image/svg+xml', '.glb':'model/gltf-binary' };
const allowed = /^\/(?:index\.html|world-(?:app|client|worker|store|renderer|camera|input|audio|music|tuning|view)\.js|far-(?:worker|stream|channel)\.js|asset-(?:source|folder|channel|worker)\.js|(?:scene|terrain|water|craft)-stream\.js|npc-pack\.js|actors\.js|hud-model\.js|wander\.js|loading-art\.js|wreck\.js|beam\.js|water-shader\.js|clouds\.js|cloud-flow\.js|particles\.js|shadow\.js|race(?:-flags|-gate-preview|-gates)?\.js|track-edit(?:or)?\.js|vehicles\.js|swe1r\/(?:folder|attach|cache|ui|voice-map|block|comp|image|names|model|pod|skin|sfx|hud)\.js|swe1r\/voice-map\.json|glb\.js|vehicle-model\.js|vehicles\/[a-z0-9-]+\.glb|tracks\/[a-z0-9-]+\.json|ocean-mesh\.js|worldmap\.js|map-panel\.js|music\.js|sky\.js|space\.js|globe-patches\.js|planet-frame\.js|tile-registry\.js|height-bake\.js|adt-synth\.js|demo-source\.js|orient\.js|camera-collision\.js|flight\.js|style\.css|icon\.svg|sw\.js|npc-pack\.json|local\/npc-spawns\.json|pkg\/flats_racer_web(?:_bg\.wasm|\.js))$/;
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
    const bytes = await readFile(new URL(file==='/local/npc-spawns.json'?'../runtime/browser/npc-spawns.json':file==='/npc-pack.json'?'../runtime/browser/npc-pack.json':`.${file}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': types[file.slice(file.lastIndexOf('.'))],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    }).end(bytes);
  } catch (error) {
    if((file==='/local/npc-spawns.json'||file==='/npc-pack.json') && error.code==='ENOENT'){response.writeHead(404).end('No private local population pack');return;}
    if(error.code==='ENOENT'&&!file.startsWith('/pkg/')){response.writeHead(404).end('Not found');return;}
    console.error(`Cannot serve ${file}: ${error.message}`);
    response.writeHead(500).end('Build the Wasm package first; see server log.');
  }
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
server.listen(port, '127.0.0.1', () => console.log(`Local world: http://127.0.0.1:${port}`));
