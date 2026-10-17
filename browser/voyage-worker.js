import init, { Voyage } from './pkg/flats_racer_web.js';
import { readRoute, digest } from './voyage-store.js';

const ready = init();
const TILE = 1600/3, LIMIT = 3;
let world, pack, accumulator = 0, resident = new Set(), failures = new Map();
let loads = 0, evictions = 0, peak = 0, queue = Promise.resolve();

function placement(index) {
  const tile = pack.manifest.tiles[index], region = pack.manifest.regions[tile.region];
  return [region.placement[0]+(tile.x-region.tile_origin[0])*TILE,
    region.placement[1]+(tile.y-region.tile_origin[1])*TILE];
}
function distance(index, p) {
  const a = placement(index);
  return Math.hypot(Math.max(a[0]-p[0],0,p[0]-a[0]-TILE),Math.max(a[1]-p[1],0,p[1]-a[1]-TILE));
}
async function stream(p) {
  const wanted = pack.manifest.tiles.map((_,i) => i).filter(i => distance(i,p)<550)
    .sort((a,b) => distance(a,p)-distance(b,p)).slice(0,LIMIT);
  for (const i of resident) {
    if (!wanted.includes(i)) {
      world.remove_tile(i);
      resident.delete(i);
      evictions++;
      postMessage({ event:'evict', index:i });
    }
  }
  for (const index of wanted) {
    if (resident.has(index) || failures.has(index)) continue;
    const entry = pack.manifest.tiles[index];
    postMessage({ event:'loading', text:`Loading ${entry.file}; unknown terrain is held.` });
    try {
      const blob = await readRoute('tiles', entry.file);
      if (!(blob instanceof Blob) || blob.size !== entry.bytes) throw new Error('missing or wrong-size offline tile');
      const bytes = await blob.arrayBuffer();
      if (await digest(bytes) !== entry.sha256.toLowerCase()) throw new Error('offline tile checksum mismatch');
      world.add_tile(index,new Uint8Array(bytes));
      const vertices = world.geometry(index);
      resident.add(index);
      loads++;
      peak = Math.max(peak,resident.size);
      postMessage({ event:'tile',index,placement:placement(index),vertices },[vertices.buffer]);
    } catch (error) {
      world.remove_tile(index);
      failures.set(index,`${entry.file}: ${String(error)}`);
    }
  }
}
function snapshot() {
  return { telemetry:Array.from(world.telemetry()), resident:Array.from(resident),
    failures:Array.from(failures.values()), loads,evictions,peak,limit:LIMIT };
}
async function handle(message) {
  await ready;
  if (message.action === 'validate') {
    const candidate = new Voyage(message.json), manifest = JSON.parse(message.json);
    try {
      const files = new Map(message.files.map(file => [file.name,file]));
      if (files.size !== manifest.tiles.length+1) throw new Error('Select exactly route.json and all listed tiles.');
      for (const [index,entry] of manifest.tiles.entries()) {
        const file = files.get(entry.file);
        if (!file || file.size !== entry.bytes) throw new Error(`Missing or wrong-size tile: ${entry.file}`);
        postMessage({event:'loading',text:`Validating hash and source geometry: ${entry.file}`});
        const bytes = await file.arrayBuffer();
        if (await digest(bytes) !== entry.sha256.toLowerCase()) throw new Error(`SHA-256 mismatch: ${entry.file}`);
        candidate.add_tile(index,new Uint8Array(bytes));
        candidate.remove_tile(index);
      }
      return true;
    } finally { candidate.free(); }
  }
  if (message.action === 'open') {
    pack = await readRoute('meta','pack');
    if (!pack) throw new Error('No offline route pack; import route.json and its tiles.');
    world?.free();
    world = new Voyage(pack.json);
    resident = new Set(); failures = new Map(); accumulator = 0; loads = 0; evictions = 0; peak = 0;
    const pose = message.pose || pack.manifest.spawn;
    await stream([pose[0],pose[2]]);
    if (message.pose) world.restore(new Float64Array(pose));
    return { ...snapshot(), pack };
  }
  if (!world) throw new Error('Route is not open');
  if (message.action === 'frame') {
    const before = world.telemetry();
    await stream([before[0],before[2]]);
    accumulator += Math.min(Math.max(message.dt,0),0.1);
    while (accumulator >= 1/120) {
      world.tick(message.throttle,message.steer,message.flags);
      accumulator -= 1/120;
    }
  } else if (message.action === 'reset') {
    world.reset(); accumulator = 0;
    await stream([pack.manifest.spawn[0],pack.manifest.spawn[2]]);
  } else if (message.action === 'restore') {
    await stream([message.pose[0],message.pose[2]]);
    world.restore(new Float64Array(message.pose));
    accumulator = 0;
  } else if (message.action === 'retry') {
    failures.clear();
    const p = world.telemetry();
    await stream([p[0],p[2]]);
  } else if (message.action === 'probe') {
    return message.points.map(p => Array.from(world.surface(p[0],p[1])));
  } else if (message.action !== 'snapshot') {
    throw new Error('Unknown route operation');
  }
  return snapshot();
}
onmessage = ({data}) => {
  queue = queue.then(async () => {
    try { postMessage({ id:data.id, result:await handle(data) }); }
    catch (error) { postMessage({ id:data.id, error:String(error) }); }
  });
};
