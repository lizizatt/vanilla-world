import init, { Voyage } from './pkg/flats_racer_web.js';
import { readRoute, digest } from './voyage-store.js';

let wasm;
const ready = init().then(exports => (wasm=exports));
const TILE = 1600/3, LIMIT = 3;
let world, pack, accumulator = 0, resident = new Set(), failures = new Map();
let loads = 0, evictions = 0, peak = 0, queue = Promise.resolve();
let horizonStats;

async function checkedBytes(entry, files) {
  const blob = files ? files.get(entry.file) : await readRoute('tiles',entry.file);
  if (!(blob instanceof Blob) || blob.size !== entry.bytes) throw new Error(`${entry.file}: missing or wrong-size offline file`);
  const bytes = await blob.arrayBuffer();
  if (await digest(bytes) !== entry.sha256.toLowerCase()) throw new Error(`${entry.file}: checksum mismatch`);
  return new Uint8Array(bytes);
}
async function horizons() {
  const started = performance.now();
  horizonStats = {patches:0,vertices:0,indices:0,gpuBytes:0,sourceBytes:0,cpuParsedBound:0,
    transientMeshBytes:545*28+3072*4,wasmPeakBytes:0,limit:8192,regions:[]};
  for (const entry of pack.manifest.horizons || []) {
    postMessage({event:'loading',text:`Loading authored horizon ${entry.file}`});
    world.add_horizon(entry.region,await checkedBytes(entry));
    horizonStats.sourceBytes += entry.bytes;
  }
  for (const entry of pack.manifest.horizons || []) {
    const patches = world.horizon_patches(entry.region), indices = world.horizon_indices(entry.region);
    horizonStats.gpuBytes += indices.byteLength;
    postMessage({event:'horizon-index',region:entry.region,indices},[indices.buffer]);
    const region = {region:entry.region,patches:patches.length/5,sourceBounds:[64,64,0,0],globalBounds:[Infinity,Infinity,-Infinity,-Infinity]};
    horizonStats.regions.push(region);
    for (let i=0;i<patches.length;i+=5) {
      const [tx,ty,x,z]=patches.slice(i,i+4);
      region.sourceBounds=[Math.min(region.sourceBounds[0],tx),Math.min(region.sourceBounds[1],ty),
        Math.max(region.sourceBounds[2],tx+1),Math.max(region.sourceBounds[3],ty+1)];
      region.globalBounds=[Math.min(region.globalBounds[0],x),Math.min(region.globalBounds[1],z),
        Math.max(region.globalBounds[2],x+TILE),Math.max(region.globalBounds[3],z+TILE)];
      const vertices = world.horizon_vertices(entry.region,i/5);
      const bounds = [Infinity,-Infinity];
      for (let j=1;j<vertices.length;j+=7) { bounds[0]=Math.min(bounds[0],vertices[j]);bounds[1]=Math.max(bounds[1],vertices[j]); }
      horizonStats.patches++;horizonStats.vertices+=vertices.length/7;horizonStats.indices+=3072;
      horizonStats.gpuBytes+=vertices.byteLength+112;
      postMessage({event:'horizon',region:entry.region,source:Array.from(patches.slice(i,i+2)),
        placement:Array.from(patches.slice(i+2,i+4)),near:patches[i+4],bounds,vertices},[vertices.buffer]);
      if ((i/5)%4===3) await new Promise(resolve => setTimeout(resolve,0));
    }
  }
  horizonStats.cpuParsedBound = world.horizon_cpu_bound();
  horizonStats.wasmPeakBytes = (await ready).memory.buffer.byteLength;
  horizonStats.buildMs = performance.now()-started;
}

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
  const tiles=[],removed=[];
  const wanted = pack.manifest.tiles.map((_,i) => i).filter(i => distance(i,p)<550)
    .sort((a,b) => distance(a,p)-distance(b,p)).slice(0,LIMIT);
  for (const i of resident) {
    if (!wanted.includes(i)) {
      world.remove_tile(i);
      resident.delete(i);
      evictions++;
      removed.push(i);
    }
  }
  for (const index of wanted) {
    if (resident.has(index) || failures.has(index)) continue;
    const entry = pack.manifest.tiles[index];
    postMessage({ event:'loading', text:`Loading ${entry.file}; unknown terrain is held.` });
    try {
      world.add_tile(index,await checkedBytes(entry));
      const vertices = world.geometry(index);
      resident.add(index);
      loads++;
      peak = Math.max(peak,resident.size);
      tiles.push({index,placement:placement(index),vertices});
    } catch (error) {
      world.remove_tile(index);
      failures.set(index,`${entry.file}: ${String(error)}`);
    }
  }
  if (tiles.length || removed.length) {
    const seams = Array.from(resident,index => ({index,vertices:world.horizon_seams(index)}));
    postMessage({event:'detail',tiles,removed,seams},[...tiles,...seams].map(t => t.vertices.buffer));
  }
}
function snapshot() {
  if (horizonStats) horizonStats.wasmPeakBytes=Math.max(horizonStats.wasmPeakBytes,wasm.memory.buffer.byteLength);
  return { telemetry:Array.from(world.telemetry()), resident:Array.from(resident),
    failures:Array.from(failures.values()), loads,evictions,peak,limit:LIMIT,horizon:horizonStats };
}
async function handle(message) {
  await ready;
  if (message.action === 'validate') {
    const candidate = new Voyage(message.json), manifest = JSON.parse(message.json);
    try {
      const files = new Map(message.files.map(file => [file.name,file]));
      if (files.size !== manifest.tiles.length+(manifest.horizons || []).length+1) throw new Error('Select exactly route.json and all listed ADT/WDL files.');
      for (const entry of manifest.horizons || []) {
        candidate.add_horizon(entry.region,await checkedBytes(entry,files));
      }
      for (const [index,entry] of manifest.tiles.entries()) {
        postMessage({event:'loading',text:`Validating hash and source geometry: ${entry.file}`});
        candidate.add_tile(index,await checkedBytes(entry,files));
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
    await horizons();
    const pose = message.pose || pack.manifest.spawn;
    await stream([pose[0],pose[2]]);
    if (message.pose) world.restore(new Float64Array(pose));
    return { ...snapshot(), pack };
  }
  if (!world) throw new Error('Route is not open');
  if (message.action === 'frame') {
    if (message.focus) {
      if (!Array.isArray(message.focus) || message.focus.length!==2 || !message.focus.every(v=>Number.isFinite(v) && Math.abs(v)<1e12)) {
        throw new Error('Invalid visual streaming focus');
      }
      await stream(message.focus);
      return snapshot();
    }
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
