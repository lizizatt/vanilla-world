// GPU/CPU parity smoke for the shared weather emitter: runs weatherWGSL() (with flowWGSL's vnoise3) as a compute shader in Edge and compares
// cell intensity, coverage gate, storm rain and lifecycle against weather-field.js on random points. No game data; needs a server on PORT.
import {chromium} from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as F from './weather-field.js';

const N = 4096;
let s = 99; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const input = new Float32Array(N * 4);
for (let i = 0; i < N; i++) input.set([(r() - .5) * 8e4, (r() - .5) * 8e4, (r() - .5) * 8e4, r() * 4e5], i * 4);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-wxparity-')), {channel: process.env.LAB_CHANNEL || 'msedge', headless: true, args: ['--mute-audio', '--enable-unsafe-webgpu']});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`http://127.0.0.1:${process.env.PORT || 4291}/?test`);
const result = await page.evaluate(async raw => {
  const input = new Float32Array(raw), N = input.length / 4;
  const {weatherWGSL} = await import('/weather-wgsl.js'), {flowWGSL} = await import('/cloud-flow.js');
  const adapter = await navigator.gpu.requestAdapter(), device = await adapter.requestDevice();
  const code = `struct C {fe:vec4f,fu:vec4f};@group(0) @binding(0) var<uniform> c:C;${flowWGSL()}${weatherWGSL()}
@group(0) @binding(1) var<storage,read> inp:array<vec4f>;@group(0) @binding(2) var<storage,read_write> outp:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g:vec3u) {
  let p=inp[g.x];let k=c.fe.x*0.0;outp[g.x]=k+vec4f(wxCellIntensity(p.xyz,p.w),wxCoverageGate(fract(p.x*.001)),wxStormRain(fract(p.y*.001),fract(p.z*.001)),wxLifeEnvelope(p.w/1100.0));}`;
  const module = device.createShaderModule({code}), info = await module.getCompilationInfo();
  const errs = info.messages.filter(m => m.type === 'error').map(m => `${m.lineNum}: ${m.message}`);
  if (errs.length) return {errs};
  const mk = (size, usage) => device.createBuffer({size, usage}), ub = mk(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST), ib = mk(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    ob = mk(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC), rb = mk(input.byteLength, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  device.queue.writeBuffer(ib, 0, input);
  const pipe = device.createComputePipeline({layout: 'auto', compute: {module, entryPoint: 'main'}});
  const bg = device.createBindGroup({layout: pipe.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: ub}}, {binding: 1, resource: {buffer: ib}}, {binding: 2, resource: {buffer: ob}}]});
  const enc = device.createCommandEncoder(), pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(N / 64); pass.end();
  enc.copyBufferToBuffer(ob, 0, rb, 0, input.byteLength); device.queue.submit([enc.finish()]); await rb.mapAsync(GPUMapMode.READ);
  return {gpu: [...new Float32Array(rb.getMappedRange().slice(0))]};
}, [...input]);
await ctx.close();
const fr = x => x - Math.floor(x), worst = [0, 0, 0, 0];
let cellBad = 0;
if (result.gpu) for (let i = 0; i < N; i++) {
  const p = [...input.slice(i * 4, i * 4 + 4)], cpu = [F.cellIntensity(p.slice(0, 3), p[3]), F.coverageGate(fr(p[0] * .001)), F.stormRain(fr(p[1] * .001), fr(p[2] * .001)), F.lifeEnvelope(p[3] / 1100)];
  for (let k = 0; k < 4; k++) worst[k] = Math.max(worst[k], Math.abs(cpu[k] - result.gpu[i * 4 + k]));
  if (Math.abs(cpu[0] - result.gpu[i * 4]) > 2e-2) cellBad++;
}
// The cell goes through the f32 hash, whose rounding can differ from f64 at a few lattice points: require 99% agreement there and tight agreement on the pure smoothstep terms.
console.log(JSON.stringify({errs: result.errs, worst, cellBad, of: N}));
if (result.errs || worst.slice(1).some(v => !(v < 2e-3)) || cellBad > N * .01) { console.error('PARITY FAIL'); process.exit(1); }
console.log('weather parity ok');