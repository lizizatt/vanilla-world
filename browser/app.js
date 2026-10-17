import init, { Racer } from './pkg/flats_racer_web.js';
import { RouteClient } from './voyage-client.js';

const $ = id => document.getElementById(id);
const canvas = $('world');
const keys = new Set();
const controls = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyJ']);
let racer, device, context, pipeline, terrainBuffer, terrainCount, bodyBuffer, bodyCount, depth;
let terrainBytes = new Uint8Array(), terrainName = 'Synthetic flat fixture / no game assets';
let accumulator = 0, lastTime = 0, frames = 0, ticks = 0, running = false, camera;
let routeMode = false, routeBusy = false, renderOrigin = [0,0], ocean;
const routeTiles = new Map();
const evidence = { ready: false, frames: 0, ticks: 0, terrainVertices: 0, source: 'synthetic', telemetry: [], errors: [] };
window.racerEvidence = evidence;
const report = message => { $('status').textContent = message; };
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  evidence.errors.push(message);
  report(`Error: ${message}`);
}

canvas.addEventListener('keydown', event => {
  if (controls.has(event.code)) { event.preventDefault(); keys.add(event.code); }
});
window.addEventListener('keyup', event => keys.delete(event.code));
canvas.addEventListener('blur', () => keys.clear());
document.addEventListener('visibilitychange', () => { keys.clear(); accumulator = 0; lastTime = 0; });

function database() { return new Promise((resolve, reject) => {
  const request = indexedDB.open('vanilla-world-racer', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('save');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('Local save database is blocked by another tab.'));
}); }
async function savedRecord(record) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('save', record ? 'readwrite' : 'readonly');
    const store = tx.objectStore('save');
    const request = record ? store.put(record, 'current') : store.get('current');
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Local save transaction aborted')); };
  });
}

function buffer(data, usage) {
  const result = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
  new Float32Array(result.getMappedRange()).set(data);
  result.unmap();
  return result;
}
function materialVertices(vertices, material = 0) {
  const result = new Float32Array(vertices.length/6*7);
  for (let i = 0, j = 0; i < vertices.length; i += 6, j += 7) {
    result.set(vertices.subarray(i,i+6),j); result[j+6] = material;
  }
  return result;
}
function selectTerrain(bytes, name, pose) {
  const next = new Racer(bytes);
  let vertices, gpu;
  try {
    if (pose) next.restore(new Float32Array(pose));
    vertices = next.vertices();
    gpu = buffer(materialVertices(vertices), GPUBufferUsage.VERTEX);
  } catch (error) { next.free(); throw error; }
  racer?.free();
  terrainBuffer?.destroy();
  racer = next;
  terrainBuffer = gpu;
  terrainCount = vertices.length / 6;
  terrainBytes = bytes;
  terrainName = name;
  $('terrain').textContent = name;
  evidence.source = bytes.length ? 'imported-adt' : 'synthetic';
  evidence.terrainVertices = terrainCount;
  keys.clear();
  accumulator = 0;
  camera = undefined;
}
async function load() {
  const record = await savedRecord();
  if (!record) { report('No local save yet.'); return; }
  if (record.version !== 1 || !(record.bytes instanceof Uint8Array) ||
      !Array.isArray(record.pose) || record.pose.length !== 4 ||
      !record.pose.every(v => typeof v === 'number' && Number.isFinite(v)) || typeof record.name !== 'string') {
    throw new Error('Unsupported or damaged local save; current terrain was not changed.');
  }
  selectTerrain(record.bytes, record.name, record.pose);
  report('Loaded local parked pose and terrain. Click the view to drive.');
}
$('save').onclick = async () => {
  try {
    if (routeMode) {
      await route.save();
      report('Saved route v2: global hovercraft pose + offline pack identity.');
      return;
    }
    const pose = Array.from(racer.telemetry().slice(0, 4));
    await savedRecord({ version: 1, bytes: terrainBytes, name: terrainName, pose });
    report('Saved locally: terrain + parked pose (momentum resets on load).');
  } catch (error) { fail(error); }
};
$('load').onclick = () => routeMode ? routeAction(() => route.load(), 'Loaded route save.') : load().catch(fail);
$('reset').onclick = () => {
  if (routeMode) return routeAction(() => route.reset(), 'Route reset to Kalimdor coast; save was not overwritten.');
  racer.reset(); camera = undefined; keys.clear(); report('Reset. Click the view to drive.');
};
$('import').onchange = async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (!/\.adt$/i.test(file.name) || file.size === 0 || file.size > 16 * 1024 * 1024) {
      throw new Error('Choose a nonempty vanilla .adt tile smaller than 16 MiB.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    selectTerrain(bytes, `Imported ${file.name} / height geometry only`);
    leaveRoute();
    report('Local ADT parsed and meshed in Rust Wasm. Save to retain it after reload.');
  } catch (error) { fail(error); }
  finally { event.target.value = ''; }
};

const shader = `
struct Uniforms {
  eye: vec4f, right: vec4f, up: vec4f, forward: vec4f,
  body: vec4f, settings: vec4f, tile: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Vertex { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f, @location(2) @interpolate(flat) material: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) material: f32) -> Vertex {
  var position = p + u.tile.xyz;
  var normal = n;
  if (material == 1.0) {
    let s = sin(u.body.w); let c = cos(u.body.w);
    let sb = sin(u.settings.z); let cb = cos(u.settings.z);
    let banked = vec3f(p.x*cb-p.y*sb, p.x*sb+p.y*cb, p.z);
    position = vec3f(banked.x*c+banked.z*s, banked.y, -banked.x*s+banked.z*c) + u.body.xyz;
    normal = vec3f(n.x*c+n.z*s, n.y, -n.x*s+n.z*c);
  }
  let relative = position - u.eye.xyz;
  let z = dot(relative, u.forward.xyz);
  var result: Vertex;
  result.clip = vec4f(dot(relative, u.right.xyz)/(0.55*u.settings.x), dot(relative, u.up.xyz)/0.55, (z-0.1)*1200.0/1199.9, z);
  result.world = position;
  result.normal = normal;
  result.material = material;
  return result;
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
  let light = 0.35 + 0.65*max(dot(normalize(v.normal), normalize(vec3f(-0.3, 1.0, 0.4))), 0.0);
  let line = min(abs(fract(v.world.x/8.0+0.5)-0.5), abs(fract(v.world.z/8.0+0.5)-0.5));
  let grid = smoothstep(0.0, 0.018, line);
  var color = mix(vec3f(0.31, 0.32, 0.25), vec3f(0.63, 0.59, 0.40), grid)*light;
  if (v.material == 1.0) { color = vec3f(0.10, 0.89, 0.82)*light; }
  if (v.material == 2.0) {
    let ripple = 0.5 + 0.5*sin(v.world.x*0.16+v.world.z*0.12+u.settings.y);
    color = mix(vec3f(0.025,0.18,0.29),vec3f(0.06,0.36,0.48),ripple);
  }
  let fog = clamp(length(v.world-u.eye.xyz)/900.0, 0.0, 0.85);
  return vec4f(mix(color, vec3f(0.08, 0.15, 0.20), fog), 1.0);
}`;

function bodyGeometry() {
  const points = [[0, 0.25, -2.7], [-1.2, 0, 1.3], [1.2, 0, 1.3], [0, 0.65, 0.8], [0, -0.35, 0.6]];
  const output = [];
  for (const face of [[0,1,3], [0,3,2], [1,2,3], [0,4,1], [0,2,4], [1,4,2]]) {
    const [a,b,c] = face.map(i => points[i]);
    const n = normalize(cross(sub(b,a), sub(c,a)));
    for (const point of [a,b,c]) output.push(...point, ...n);
  }
  return materialVertices(new Float32Array(output),1);
}
const sub = (a,b) => a.map((v,i) => v-b[i]);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const normalize = a => { const length = Math.hypot(...a); return a.map(v => v/length); };
const uniforms = [];
function uniform() {
  const gpu = device.createBuffer({ size:112, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  return {gpu,group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:gpu}}]})};
}
function releaseDrawable(item) { item?.buffer.destroy(); item?.uniform.gpu.destroy(); }
function clearRouteGeometry() {
  for (const item of routeTiles.values()) releaseDrawable(item);
  routeTiles.clear(); releaseDrawable(ocean); ocean = undefined;
}
const route = new RouteClient(data => {
  releaseDrawable(routeTiles.get(data.index));
  routeTiles.set(data.index,{buffer:buffer(data.vertices,GPUBufferUsage.VERTEX),
    count:data.vertices.length/7,placement:data.placement,uniform:uniform()});
}, index => { releaseDrawable(routeTiles.get(index)); routeTiles.delete(index); },report,fail,clearRouteGeometry);
function prepareOcean() {
  releaseDrawable(ocean);
  const [x,z,right,bottom] = route.pack.manifest.ocean, y = route.pack.manifest.sea_level;
  const w = right-x, h = bottom-z;
  const vertices = new Float32Array([
    0,y,0,0,1,0,2, w,y,0,0,1,0,2, w,y,h,0,1,0,2,
    0,y,0,0,1,0,2, w,y,h,0,1,0,2, 0,y,h,0,1,0,2,
  ]);
  ocean = {buffer:buffer(vertices,GPUBufferUsage.VERTEX),count:6,placement:[x,z],uniform:uniform()};
  $('terrain').textContent = route.pack.manifest.label;
}
function leaveRoute() {
  route.stop(); routeMode = false; clearRouteGeometry(); renderOrigin = [0,0]; camera = undefined;
  delete evidence.route; delete evidence.packId;
  localStorage.setItem('racer-mode','tile');
  $('journey').textContent = '';
}
async function routeAction(action, message) {
  keys.clear(); routeBusy = true;
  try {
    await action();
    if (route.pack) prepareOcean();
    camera = undefined;
    report(message);
  } catch (error) { fail(error); }
  finally { routeBusy = false; }
}
$('pack').onchange = async event => {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  keys.clear(); routeBusy = true;
  evidence.ready = false;
  try {
    await route.import(files);
    routeMode = true;
    prepareOcean(); camera = undefined; renderOrigin = [0,0];
    report('Real coastal corridor ready. W travels east; S returns west. Four tiles, not complete continents.');
  } catch (error) { fail(error); }
  finally { routeBusy = false; event.target.value = ''; }
};
$('retry').onclick = () => routeMode && routeAction(async () => { route.state = await route.request('retry'); },'Retried offline tile reads.');
$('lab').onclick = async () => {
  leaveRoute();
  selectTerrain(new Uint8Array(),'Synthetic flat fixture / no game assets');
  await load().catch(fail);
};
// Read-only observations for browser regression tests; they never teleport or inject controls.
window.routeProbe = points => route.request('probe',{points});
async function renderer() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use current Edge/Chrome on localhost with hardware acceleration.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter. Enable hardware acceleration or use a supported GPU.');
  evidence.adapter = {
    vendor: adapter.info?.vendor,
    architecture: adapter.info?.architecture,
    device: adapter.info?.device,
    description: adapter.info?.description,
    isFallbackAdapter: adapter.info?.isFallbackAdapter,
  };
  device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', event => { running = false; fail(event.error); });
  device.lost.then(info => { running = false; fail(`WebGPU device lost: ${info.message}`); });
  context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  const module = device.createShaderModule({ code: shader });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter(m => m.type === 'error');
  if (errors.length) throw new Error(errors.map(m => m.message).join('\n'));
  pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation:2,offset:24,format:'float32' },
    ] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });
  for (let i = 0; i < 2; i++) {
    uniforms.push(uniform());
  }
  const body = bodyGeometry();
  bodyBuffer = buffer(body, GPUBufferUsage.VERTEX);
  bodyCount = body.length / 7;
}
function draw(state, dt) {
  const width = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)));
  const height = Math.max(1, Math.round(canvas.clientHeight * Math.min(devicePixelRatio, 2)));
  if (!depth || canvas.width !== width || canvas.height !== height) {
    canvas.width = width; canvas.height = height;
    depth?.destroy();
    depth = device.createTexture({ size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  let [x,y,z,yaw] = state;
  if (routeMode) {
    const nextOrigin = [state[11],state[12]];
    if (camera) { camera[0] -= nextOrigin[0]-renderOrigin[0]; camera[2] -= nextOrigin[1]-renderOrigin[1]; }
    renderOrigin = nextOrigin;
    x -= renderOrigin[0]; z -= renderOrigin[1];
  }
  const forward = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  const desired = [x-forward[0]*13, y+7, z-forward[2]*13];
  camera = camera ? camera.map((v,i) => v+(desired[i]-v)*(1-Math.exp(-dt*6))) : desired;
  const look = normalize(sub([x+forward[0]*7, y, z+forward[2]*7], camera));
  const right = normalize(cross(look, [0,1,0]));
  const up = cross(right, look);
  function upload(target,offset) {
    device.queue.writeBuffer(target.gpu, 0, new Float32Array([
      ...camera, 0, ...right, 0, ...up, 0, ...look, 0, x,y,z,yaw, width/height,lastTime/1000,state[4],state[6],...offset,0,
    ]));
  }
  upload(uniforms[1],[0,0,0]);
  if (!routeMode) upload(uniforms[0],[0,0,0]);
  else for (const item of [...routeTiles.values(),ocean].filter(Boolean)) {
    upload(item.uniform,[item.placement[0]-renderOrigin[0],0,item.placement[1]-renderOrigin[1]]);
  }
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: [0.08,0.15,0.20,1], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  pass.setPipeline(pipeline);
  if (!routeMode) {
    pass.setBindGroup(0, uniforms[0].group); pass.setVertexBuffer(0, terrainBuffer); pass.draw(terrainCount);
  } else for (const item of [...routeTiles.values(),ocean].filter(Boolean)) {
    pass.setBindGroup(0,item.uniform.group); pass.setVertexBuffer(0,item.buffer); pass.draw(item.count);
  }
  pass.setBindGroup(0, uniforms[1].group); pass.setVertexBuffer(0, bodyBuffer); pass.draw(bodyCount);
  pass.end();
  device.queue.submit([encoder.finish()]);
}
function frame(now) {
  if (!running) return;
  try {
    const dt = lastTime ? Math.min((now-lastTime)/1000, 0.1) : 0;
    lastTime = now;
    accumulator += dt;
    const down = (...names) => names.some(name => keys.has(name));
    const throttle = Number(down('KeyW','ArrowUp'))-Number(down('KeyS','ArrowDown'));
    const steer = Number(down('KeyA','ArrowLeft'))-Number(down('KeyD','ArrowRight'));
    const flags = Number(down('Space')) | (Number(down('ShiftLeft','ShiftRight'))<<1) | (Number(down('KeyC'))<<2) | (Number(down('KeyJ'))<<3);
    let state;
    if (routeMode) {
      accumulator = 0;
      if (!routeBusy) route.frame(dt,throttle,steer,flags);
      state = route.state?.telemetry;
      if (!state) { evidence.ready = false; requestAnimationFrame(frame); return; }
      const stats = route.state;
      const region = state[10] < 0 ? 'Connecting ocean' : route.pack.manifest.regions[state[10]].id;
      $('journey').textContent = `${region} / ${state[9] ? 'water' : 'ground'} / global ${state[0].toFixed(2)}, ${state[2].toFixed(2)} / tiles ${stats.resident.length}/3 / rebases ${state[13]}`;
      if (stats.failures.length) report(`Missing/error: ${stats.failures.join('; ')}. Reimport or Retry tiles; unloaded ground is never safe.`);
      else if (state[8]) report(state[8] === 1 ? 'Loading hold: required terrain is not resident.' : 'Boundary/solid hold: outside imported corridor, hole or abrupt rise.');
      else if ($('status').textContent.startsWith('Loading')) report('Streaming ready; explicit 512 yd connecting ocean, provisional geography.');
      Object.assign(evidence,{source:'route',route:stats,packId:route.pack.id,terrainVertices:[...routeTiles.values()].reduce((n,t) => n+t.count,0)});
    } else {
      while (accumulator >= 1/120) {
        racer.tick(throttle, steer, flags);
        ticks++;
        accumulator -= 1/120;
      }
      state = racer.telemetry();
    }
    draw(state, dt);
    frames++;
    Object.assign(evidence, { ready: !routeBusy, frames, ticks, telemetry: Array.from(state) });
    $('speed').textContent = state[5].toFixed(1);
    $('boost').textContent = `${Math.round(state[6]*100)}%`;
    $('contact').textContent = state[8] ? 'HOLD' : state[7] ? (routeMode && state[9] ? 'WATER' : 'HOVER') : 'AIR';
    requestAnimationFrame(frame);
  } catch (error) { running = false; fail(error); }
}
async function start() {
  await init();
  await renderer();
  selectTerrain(new Uint8Array(), terrainName);
  await load().catch(fail);
  if (localStorage.getItem('racer-mode') === 'route') {
    routeMode = true;
    await routeAction(() => route.resume(),'Restored global hovercraft route save.');
  }
  for (const id of ['save', 'load', 'reset', 'import', 'pack', 'retry', 'lab']) $(id).disabled = false;
  if (!evidence.errors.length) report('Local simulation ready. Click the view to drive.');
  running = true;
  requestAnimationFrame(frame);
  const registration = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  if (registration.active) $('offline').textContent = 'Offline shell ready / saves in this browser';
}
start().catch(fail);
