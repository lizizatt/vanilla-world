// GPU/CPU parity smoke for the shared wind emitter: runs windWGSL() as a compute shader in Edge and compares windAt (dir, speed, strength) against wind.js
// on random points, zones and storm levels. No game data; needs a server on PORT.
import {chromium} from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WIND} from './wind-config.js';
import {windAt, packWind, beltVector} from './wind.js';

const N = 2048, zones = Object.keys(WIND.zones);
let s = 7; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const cases = [];
for (let i = 0; i < N; i++) {
  const z = zones[i % zones.length], storm = r() < .5 ? 0 : r(), mael = r() < .25 ? [r() * 4e4, r() * 4e4] : undefined;
  cases.push({a: packWind({base: beltVector(r()), ...WIND.zones[z], storm, mael}), x: (r() - .5) * 8e4, z: (r() - .5) * 8e4, t: r() * WIND.period});
}
const input = new Float32Array(N * 16);
cases.forEach((c, i) => { input.set(c.a, i * 16); input.set([c.x, c.z, c.t], i * 16 + 12); });
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-windparity-')), {channel: process.env.LAB_CHANNEL || 'msedge', headless: true, args: ['--mute-audio', '--enable-unsafe-webgpu']});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`http://127.0.0.1:${process.env.PORT || 4291}/?test`);
const result = await page.evaluate(async raw => {
  const input = new Float32Array(raw), N = input.length / 16;
  const {windWGSL} = await import('/wind-wgsl.js');
  const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
  const code = `${windWGSL()}
struct Row {a0:vec4f,a1:vec4f,a2:vec4f,p:vec4f};
@group(0) @binding(0) var<storage,read> inp:array<Row>;@group(0) @binding(1) var<storage,read_write> outp:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g:vec3u) {let r=inp[g.x];outp[g.x]=windAt(r.a0,r.a1,r.a2,r.p.xy,r.p.z);}`;
  const module = device.createShaderModule({code}), info = await module.getCompilationInfo();
  const errs = info.messages.filter(m => m.type === 'error').map(m => `${m.lineNum}: ${m.message}`);
  if (errs.length) return {errs};
  const mk = (size, usage) => device.createBuffer({size, usage}), ib = mk(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    ob = mk(N * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC), rb = mk(N * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  device.queue.writeBuffer(ib, 0, input);
  const pipe = device.createComputePipeline({layout: 'auto', compute: {module, entryPoint: 'main'}});
  const bg = device.createBindGroup({layout: pipe.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: ib}}, {binding: 1, resource: {buffer: ob}}]});
  const enc = device.createCommandEncoder(), pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(N / 64); pass.end();
  enc.copyBufferToBuffer(ob, 0, rb, 0, N * 16); device.queue.submit([enc.finish()]); await rb.mapAsync(GPUMapMode.READ);
  return {gpu: [...new Float32Array(rb.getMappedRange().slice(0))]};
}, [...input]);
await ctx.close();
const worst = [0, 0, 0];
if (result.gpu) cases.forEach((c, i) => {
  const w = windAt(c.a, c.x, c.z, c.t), g = result.gpu.slice(i * 4, i * 4 + 4);
  worst[0] = Math.max(worst[0], Math.hypot(w.dir[0] - g[0], w.dir[1] - g[1]));
  worst[1] = Math.max(worst[1], Math.abs(w.speed - g[2]));
  worst[2] = Math.max(worst[2], Math.abs(w.strength - g[3]));
});
console.log(JSON.stringify({errs: result.errs, worst, of: N}));
// f32 sin/cos on phases built from ~1e4 yd coordinates costs a little: tolerate a few hundredths of a yd/s.
if (result.errs || !(worst[0] < 2e-2 && worst[1] < .25 && worst[2] < 1e-2)) { console.error('PARITY FAIL'); process.exit(1); }
console.log('wind parity ok');
