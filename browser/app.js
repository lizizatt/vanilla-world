import init, { Racer } from './pkg/flats_racer_web.js';

const $ = id => document.getElementById(id);
const canvas = $('world');
const keys = new Set();
const controls = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyJ']);
let racer, device, context, pipeline, terrainBuffer, terrainCount, bodyBuffer, bodyCount, depth;
let terrainBytes = new Uint8Array(), terrainName = 'Synthetic flat fixture / no game assets';
let accumulator = 0, lastTime = 0, frames = 0, ticks = 0, running = false, camera;
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
function selectTerrain(bytes, name, pose) {
  const next = new Racer(bytes);
  let vertices, gpu;
  try {
    if (pose) next.restore(new Float32Array(pose));
    vertices = next.vertices();
    gpu = buffer(vertices, GPUBufferUsage.VERTEX);
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
    const pose = Array.from(racer.telemetry().slice(0, 4));
    await savedRecord({ version: 1, bytes: terrainBytes, name: terrainName, pose });
    report('Saved locally: terrain + parked pose (momentum resets on load).');
  } catch (error) { fail(error); }
};
$('load').onclick = () => load().catch(fail);
$('reset').onclick = () => { racer.reset(); camera = undefined; keys.clear(); report('Reset. Click the view to drive.'); };
$('import').onchange = async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (!/\.adt$/i.test(file.name) || file.size === 0 || file.size > 16 * 1024 * 1024) {
      throw new Error('Choose a nonempty vanilla .adt tile smaller than 16 MiB.');
    }
    selectTerrain(new Uint8Array(await file.arrayBuffer()), `Imported ${file.name} / height geometry only`);
    report('Local ADT parsed and meshed in Rust Wasm. Save to retain it after reload.');
  } catch (error) { fail(error); }
  finally { event.target.value = ''; }
};

const shader = `
struct Uniforms {
  eye: vec4f, right: vec4f, up: vec4f, forward: vec4f,
  body: vec4f, settings: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Vertex { @builtin(position) clip: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> Vertex {
  var position = p;
  var normal = n;
  if (u.settings.y > 0.5) {
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
  return result;
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
  let light = 0.35 + 0.65*max(dot(normalize(v.normal), normalize(vec3f(-0.3, 1.0, 0.4))), 0.0);
  let line = min(abs(fract(v.world.x/8.0+0.5)-0.5), abs(fract(v.world.z/8.0+0.5)-0.5));
  let grid = smoothstep(0.0, 0.018, line);
  var color = mix(vec3f(0.31, 0.32, 0.25), vec3f(0.63, 0.59, 0.40), grid)*light;
  if (u.settings.y > 0.5) { color = vec3f(0.10, 0.89, 0.82)*light; }
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
  return new Float32Array(output);
}
const sub = (a,b) => a.map((v,i) => v-b[i]);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const normalize = a => { const length = Math.hypot(...a); return a.map(v => v/length); };
const uniforms = [];
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
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 24, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
    ] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });
  for (let i = 0; i < 2; i++) {
    const gpu = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    uniforms.push({ gpu, group: device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: gpu } }] }) });
  }
  const body = bodyGeometry();
  bodyBuffer = buffer(body, GPUBufferUsage.VERTEX);
  bodyCount = body.length / 6;
}
function draw(state, dt) {
  const width = Math.max(1, Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)));
  const height = Math.max(1, Math.round(canvas.clientHeight * Math.min(devicePixelRatio, 2)));
  if (!depth || canvas.width !== width || canvas.height !== height) {
    canvas.width = width; canvas.height = height;
    depth?.destroy();
    depth = device.createTexture({ size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  const [x,y,z,yaw] = state;
  const forward = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  const desired = [x-forward[0]*13, y+7, z-forward[2]*13];
  camera = camera ? camera.map((v,i) => v+(desired[i]-v)*(1-Math.exp(-dt*6))) : desired;
  const look = normalize(sub([x+forward[0]*7, y, z+forward[2]*7], camera));
  const right = normalize(cross(look, [0,1,0]));
  const up = cross(right, look);
  for (let i = 0; i < 2; i++) {
    device.queue.writeBuffer(uniforms[i].gpu, 0, new Float32Array([
      ...camera, 0, ...right, 0, ...up, 0, ...look, 0, x,y,z,yaw, width/height,i,state[4],state[6],
    ]));
  }
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: [0.08,0.15,0.20,1], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, uniforms[0].group); pass.setVertexBuffer(0, terrainBuffer); pass.draw(terrainCount);
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
    while (accumulator >= 1/120) {
      racer.tick(throttle, steer, flags);
      ticks++;
      accumulator -= 1/120;
    }
    const state = racer.telemetry();
    draw(state, dt);
    frames++;
    Object.assign(evidence, { ready: true, frames, ticks, telemetry: Array.from(state) });
    $('speed').textContent = state[5].toFixed(1);
    $('boost').textContent = `${Math.round(state[6]*100)}%`;
    $('contact').textContent = state[8] ? 'EDGE HOLD' : state[7] ? 'HOVER' : 'AIR';
    requestAnimationFrame(frame);
  } catch (error) { running = false; fail(error); }
}
async function start() {
  await init();
  await renderer();
  selectTerrain(new Uint8Array(), terrainName);
  await load().catch(fail);
  for (const id of ['save', 'load', 'reset', 'import']) $(id).disabled = false;
  if (!evidence.errors.length) report('Local simulation ready. Click the view to drive.');
  running = true;
  requestAnimationFrame(frame);
  const registration = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  if (registration.active) $('offline').textContent = 'Offline shell ready / saves in this browser';
}
start().catch(fail);
