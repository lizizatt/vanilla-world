// Shared particle layer: a CPU ring buffer of billboards drawn in one instanced pass. Colours are premultiplied, so one
// blend state (one, one-minus-src-alpha) gives both additive fire (alpha 0) and normal smoke/dust (alpha > 0).
import { classifyTriangles } from './wreck.js';
import {planetRelativeFrame} from './pod-render-frame.js';
export const CAPACITY = 2048;
export const QUALITY = { off: 0, low: .35, medium: .7, high: 1 };
export const INSTANCE_FLOATS = 8;
const STRIDE = 12; // x y z vx vy vz age life size0 size1 kind seed

// stops: [u, r, g, b, alpha, glow]; glow 1 = purely additive, 0 = ordinary alpha blend.
export const KINDS = {
  plume: { life: [.18, .34], size: [.28, .12], drag: 2.5, lift: 0, stops: [[0, .6, .78, 1, .5, 1], [.25, 1, .6, .2, .42, 1], [.7, .85, .22, .04, .18, 1], [1, .3, .08, .02, 0, 1]] },
  fire: { life: [.4, .9], size: [.5, .15], drag: 1.2, lift: 3, stops: [[0, 1, .9, .5, .9, 1], [.35, 1, .45, .08, .7, .9], [1, .35, .05, .02, 0, .8]] },
  smoke: { life: [1.2, 2.4], size: [.4, 1.8], drag: 1.5, lift: 2.5, stops: [[0, .35, .35, .37, .0, 0], [.12, .3, .3, .32, .5, 0], [1, .2, .2, .22, 0, 0]] },
  dust: { life: [.9, 1.8], size: [.5, 2], drag: 2.2, lift: 1.2, stops: [[0, .6, .48, .32, .7, 0], [1, .6, .48, .32, 0, 0]] },
  lamp: { life: [.22, .3], size: [.55, .5], drag: 0, lift: 0, stops: [[0, 1, .62, .25, .5, 1], [.5, 1, .55, .18, .6, 1], [1, 1, .4, .1, 0, 1]] },
  spray: { life: [.5, 1.1], size: [.3, .9], drag: 1.2, lift: -9, stops: [[0, .92, .97, 1, .55, 0], [1, .85, .93, 1, 0, 0]] },
  wake: { life: [1.4, 2.6], size: [.6, 3.2], drag: 2.5, lift: 0, stops: [[0, .9, .96, 1, .38, 0], [1, .8, .9, .98, 0, 0]] },
  ripple: { life: [1.6, 2.2], size: [.4, 4.5], drag: 4, lift: 0, stops: [[0, .85, .95, 1, 0, 0], [.2, .85, .95, 1, .28, 0], [1, .8, .9, 1, 0, 0]] },
  burst: { life: [.25, .5], size: [1, 3.5], drag: 4, lift: 0, stops: [[0, 1, .95, .7, 1, 1], [.4, 1, .55, .12, .7, 1], [1, .5, .1, .02, 0, 1]] },
  chunk: { life: [.7, 1.5], size: [.4, .25], drag: .4, lift: -16, stops: [[0, .5, .06, .05, .95, 0], [.7, .32, .04, .04, .9, 0], [1, .2, .03, .03, 0, 0]] },
  mist: { life: [7, 11], size: [30, 62], drag: .2, lift: .15, stops: [[0, .7, .95, .85, 0, .25], [.25, .72, .96, .86, .09, .25], [.75, .85, .95, .8, .07, .25], [1, .85, .95, .8, 0, .25]] },
};
const KIND_IDS = Object.keys(KINDS);

export class ParticlePool {
  constructor(capacity = CAPACITY, rand = Math.random) {
    this.capacity = capacity; this.rand = rand; this.data = new Float64Array(capacity * STRIDE);
    this.physical=new Uint8Array(capacity);
    this.head = 0; this.quality = QUALITY.medium; this.carry = new Map(); this.data.fill(0);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 6] = 1, this.data[i * STRIDE + 7] = 1; // age == life: dead
  }
  /** Whole particles to emit for `rate` per second over dt at the current quality (fraction carried per key). */
  budget(key, rate, dt) {
    const total = (this.carry.get(key) || 0) + rate * this.quality * dt, n = Math.min(32, Math.floor(total));
    this.carry.set(key, total - n); return this.quality > 0 ? n : 0;
  }
  /** Spawn one particle, overwriting the oldest slot when full. scale multiplies size; spread jitters position. */
  emit(kind, x, y, z, vx = 0, vy = 0, vz = 0, scale = 1, spread = 0) {
    const k = KINDS[kind], r = this.rand, o = this.head * STRIDE, d = this.data;
    this.physical[this.head]=this.frame?1:0;
    if(this.frame){[x,y,z]=this.frame.point([x,y,z]);[vx,vy,vz]=this.frame.vector([vx,vy,vz]);}
    this.head = (this.head + 1) % this.capacity;
    d[o] = x + (r() - .5) * spread; d[o + 1] = y + (r() - .5) * spread; d[o + 2] = z + (r() - .5) * spread;
    d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz; d[o + 6] = 0;
    d[o + 7] = k.life[0] + r() * (k.life[1] - k.life[0]); d[o + 8] = k.size[0] * scale; d[o + 9] = k.size[1] * scale;
    d[o + 10] = KIND_IDS.indexOf(kind); d[o + 11] = r();
  }
  update(dt) {
    const d = this.data;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * STRIDE; if (d[o + 6] >= d[o + 7]) continue;
      const k = KINDS[KIND_IDS[d[o + 10]]], damp = Math.exp(-k.drag * dt);
      d[o + 6] += dt;
      const up=this.physical[i]?Array.from(d.slice(o,o+3)).map(v=>v/Math.hypot(d[o],d[o+1],d[o+2])):[0,1,0];
      for(let axis=0;axis<3;axis++)d[o+3+axis]=d[o+3+axis]*damp+up[axis]*k.lift*dt;
      d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
    }
  }
  get count() { let n = 0; for (let i = 0; i < this.capacity; i++) if (this.data[i * STRIDE + 6] < this.data[i * STRIDE + 7]) n++; return n; }
  /** Write live particles (eye-relative position, size, premultiplied rgba) into out; returns how many. */
  fill(out, eye, body) {
    const d = this.data; let n = 0;
    const relative=body?planetRelativeFrame(body,eye):undefined;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * STRIDE; if (d[o + 6] >= d[o + 7]) continue;
      const k = KINDS[KIND_IDS[d[o + 10]]], u = d[o + 6] / d[o + 7], c = gradient(k.stops, u), q = n * INSTANCE_FLOATS;
      if(this.physical[i]){
        if(!relative)throw Error('Physical particles require the active body frame');
        out.set(relative(Array.from(d.slice(o,o+3))),q);
      }else{out[q] = d[o] - eye[0]; out[q + 1] = d[o + 1] - eye[1]; out[q + 2] = d[o + 2] - eye[2];}
      out[q + 3] = d[o + 8] + (d[o + 9] - d[o + 8]) * u;
      out[q + 4] = c[0] * c[3]; out[q + 5] = c[1] * c[3]; out[q + 6] = c[2] * c[3]; out[q + 7] = c[3] * (1 - c[4]);
      n++;
    }
    return n;
  }
}

export function gradient(stops, u) {
  let i = 1; while (i < stops.length - 1 && u > stops[i][0]) i++;
  const a = stops[i - 1], b = stops[i], t = Math.min(1, Math.max(0, (u - a[0]) / (b[0] - a[0] || 1)));
  return [1, 2, 3, 4, 5].map(j => a[j] + (b[j] - a[j]) * t);
}

/** Uniform for the billboard shader: camera axes with aspect, near and far packed into the w lanes. */
export function particleUniform(view, near, far = 200000, out = new Float32Array(12)) {
  out.set([...view.right, view.aspect, ...view.up, near, ...view.look, far]); return out;
}

export const particleShader = `
struct U {right:vec4f,up:vec4f,look:vec4f};
@group(0) @binding(0) var<uniform> u:U;
struct V {@builtin(position) clip:vec4f,@location(0) q:vec2f,@location(1) c:vec4f};
@vertex fn vs(@builtin(vertex_index) i:u32,@location(0) p:vec4f,@location(1) c:vec4f)->V {
  var corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let q=corners[i];
  let rel=p.xyz+(u.right.xyz*q.x+u.up.xyz*q.y)*p.w;
  let z=dot(rel,u.look.xyz);let near=u.up.w;let far=u.look.w;
  var v:V;
  v.clip=vec4f(dot(rel,u.right.xyz)/(0.55*u.right.w),dot(rel,u.up.xyz)/0.55,(z-near)*far/(far-near),z);
  v.q=q;v.c=c;return v;
}
@fragment fn fs(v:V)->@location(0) vec4f {
  let f=max(1.0-dot(v.q,v.q),0.0);
  return v.c*(f*f);
}`;

/** Engine exhaust points in craft space: metadata.exhausts if present, else the rear centre of each engine group, else one at the tail. */
/** Nozzle point of an engine's vertex set: the rearmost x-slice that is nearly as wide as the engine's widest (skips thin tether/strut tips that stick out behind it). */
export function engineRear(vertices, ids, bins = 24) {
  if (!ids.size) return undefined;
  let lo = 1e9, hi = -1e9;
  for (const i of ids) { lo = Math.min(lo, vertices[i * STRIDE_V]); hi = Math.max(hi, vertices[i * STRIDE_V]); }
  const slice = Array.from({ length: bins }, () => ({ n: 0, y: [1e9, -1e9], z: [1e9, -1e9], sy: 0, sz: 0 })), w = (hi - lo) / bins || 1;
  for (const i of ids) {
    const s = slice[Math.min(bins - 1, Math.floor((vertices[i * STRIDE_V] - lo) / w))], y = vertices[i * STRIDE_V + 1], z = vertices[i * STRIDE_V + 2];
    s.n++; s.sy += y; s.sz += z; s.y = [Math.min(s.y[0], y), Math.max(s.y[1], y)]; s.z = [Math.min(s.z[0], z), Math.max(s.z[1], z)];
  }
  const spread = s => Math.max(s.y[1] - s.y[0], s.z[1] - s.z[0]), widest = Math.max(...slice.map(s => s.n ? spread(s) : 0)), k = slice.findIndex(s => s.n && spread(s) >= widest * .5);
  return [lo + k * w, slice[k].sy / slice[k].n, slice[k].sz / slice[k].n];
}
export function exhaustPoints(vertices, indices, metadata) {
  if (metadata?.exhausts?.length) return metadata.exhausts.map(p => [...p]);
  const { part, lo, hi } = classifyTriangles(vertices, indices), points = [];
  for (const id of [1, 2]) {
    const ids = new Set();
    for (let t = 0; t < part.length; t++) if (part[t] === id) for (let k = 0; k < 3; k++) ids.add(indices[t * 3 + k]);
    const p = engineRear(vertices, ids); if (p) points.push(p);
  }
  return points.length ? points : [[lo[0], (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]];
}
const STRIDE_V = 12;

/**
 * Emit this frame's thrust plume. matrix is the origin-relative craft matrix (scale included, column-major), origin [x, z] its global offset, length the craft's world length;
 * thrust 0..1. Hot blue-white core, longer and denser when boosting. Particles keep the craft's velocity so they trail in the world.
 */
export function emitPlumes(pool, { points, matrix: m, origin, scale, length, speed, thrust, boosting, dt, key = 'plume' }) {
  const fwd = [m[0] / scale, m[1] / scale, m[2] / scale], boost = boosting ? 1 : 0;
  const rate = (12 + 70 * thrust) * (1 + .9 * boost), push = 6 + 22 * thrust + 28 * boost, size = length / 3.5 * (1 + .5 * boost + .4 * thrust);
  points.forEach((p, i) => {
    const n = pool.budget(`${key}${i}`, rate, dt); if (!n) return;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] + origin[0], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] + origin[1];
    for (let j = 0; j < n; j++) {
      const u = pool.rand() * dt, back = push * (.7 + .6 * pool.rand()) - speed * .9;
      pool.emit('plume', x - fwd[0] * speed * u, y - fwd[1] * speed * u, z - fwd[2] * speed * u,
        -fwd[0] * back, -fwd[1] * back + 1.5, -fwd[2] * back, size, length * .04);
    }
  });
}
/** Creature gib burst: ballistic dark-red chunks plus a short dust puff. Original procedural effect, no game art; size is roughly the creature's half-height. */
export function emitGib(pool, [x, y, z], size) {
  const r = pool.rand, n = Math.round(10 * Math.max(.3, pool.quality) + 4), k = Math.max(.4, Math.min(2, size));
  for (let i = 0; i < n; i++) {
    const a = r() * 6.2832, out = 3 + r() * 8, up = 4 + r() * 9;
    pool.emit('chunk', x, y + k * .5, z, Math.cos(a) * out, up, Math.sin(a) * out, k * (.5 + r() * .8), k * .2);
  }
  pool.emit('dust', x, y + k * .3, z, 0, 1, 0, k * 1.6, k * .3);
}
/** Explosion at the moment the pod breaks up: fireballs, sparks flung outwards and a smoke column. size is craft length / 3.5. */
export function emitBurst(pool, [x, y, z], size) {
  const r = pool.rand, n = Math.round(14 * Math.max(.3, pool.quality) + 4);
  for (let i = 0; i < n; i++) {
    const a = r() * 6.2832, up = r() * 8, out = 4 + r() * 14;
    pool.emit('burst', x, y, z, Math.cos(a) * out, up, Math.sin(a) * out, size * (.6 + r() * .8), size * .3);
    if (i % 2) pool.emit('fire', x, y, z, Math.cos(a) * out * .5, up * .5, Math.sin(a) * out * .5, size * 1.5, size * .3);
    if (i % 5 === 0) pool.emit('smoke', x, y + size, z, Math.cos(a) * 3, 5 + r() * 6, Math.sin(a) * 3, size * 1.3, size * .4);
  }
}

/**
 * Per-frame debris effects for one wreck part: fire that dies out in the first 1.4 s, smoke for the whole wreck, and a dust puff when it
 * lands (downward speed lost in one frame). memo {x, y, z, vy} is the part's last pose and is updated in place.
 */
export function emitDebris(pool, memo, [x, y, z], age, dt, size, key, seconds = 2.6) {
  const vy = memo.has ? (y - memo.y) / dt : 0, land = memo.has && memo.vy < -5 && vy > memo.vy * .4;
  const vx = memo.has ? (x - memo.x) / dt : 0, vz = memo.has ? (z - memo.z) / dt : 0;
  Object.assign(memo, { x, y, z, vy, has: true });
  const fire = pool.budget(`${key}f`, age < 1.4 ? 55 * (1 - age / 1.4) : 0, dt), smoke = pool.budget(`${key}s`, 7 * (1 - .6 * age / seconds), dt);
  for (let i = 0; i < fire; i++) pool.emit('fire', x, y, z, vx * .2, vy * .2, vz * .2, size, size * .3);
  for (let i = 0; i < smoke; i++) pool.emit('smoke', x, y, z, vx * .15, vy * .15, vz * .15, size * .7, size * .2);
  if (land) for (let i = 0, n = Math.round(3 * Math.max(.4, pool.quality)); i < n; i++) {
    const a = pool.rand() * 6.2832, s = 3 + pool.rand() * 5;
    pool.emit('dust', x, y, z, Math.cos(a) * s, 1 + pool.rand() * 2, Math.sin(a) * s, size, size * .2);
  }
}

/** Smoke curling off each engine as heat climbs past the warning level (0 below warn, full at 1). */
export function emitHeatSmoke(pool, { points, matrix: m, origin, length, heat, warn = .8, dt }) {
  const k = Math.max(0, (heat - warn) / (1 - warn)); if (!k) return;
  points.forEach((p, i) => {
    const n = pool.budget(`heat${i}`, 10 + 40 * k, dt);
    for (let j = 0; j < n; j++) pool.emit('smoke', m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] + origin[0], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] + .1 * length,
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] + origin[1], 0, 2, 0, length / 3.5 * (.8 + k), length * .03);
  });
}
/** Dust kicked up behind a grounded craft: a thin stream at speed, a heavy cloud while drifting (sideways slip throws it out). */
export function overWater(y, length, waterY = 0) { return y - waterY < length * .6 && y - waterY > -length * 2; }
/** Over water: spray thrown up behind the craft, a V wake trailing it, and slow pulsing ripple rings under it when still. */
export function emitWaterFx(pool, { matrix: m, origin, scale, length, speed, time, dt }) {
  const k = Math.min(1, speed / 120), px = m[12] + origin[0], pz = m[14] + origin[1], py = m[13] - length * .1;
  const bx = -m[0] / scale, bz = -m[2] / scale, sx = m[4] / scale, sz = m[6] / scale;
  const n = speed < 4 ? 0 : pool.budget('spray', 25 + 140 * k, dt), size = length / 4 * (.5 + .5 * k);
  for (let j = 0; j < n; j++) {
    const side = (pool.rand() - .5) * 2, back = .05 + pool.rand() * .15;
    pool.emit('spray', px + bx * length * .45 + sx * side * length * .35, py, pz + bz * length * .45 + sz * side * length * .35,
      bx * speed * back + sx * side * 4, 2 + pool.rand() * 4 * (.4 + k), bz * speed * back + sz * side * 4, size, size * .2);
  }
  const w = speed < 4 ? 0 : pool.budget('wake', 12 + 40 * k, dt);
  for (let j = 0; j < w; j++) {
    const side = pool.rand() < .5 ? -1 : 1;
    pool.emit('wake', px + bx * length * .6, py, pz + bz * length * .6, bx * speed * .1 + sx * side * (3 + 6 * k), 0, bz * speed * .1 + sz * side * (3 + 6 * k), length / 3 * (.6 + k), length * .05);
  }
  if (speed < 4 && pool.quality > 0) {
    const pulse = Math.sin(time * 2.4) > .96 ? 1 : 0, prev = pool.carry.get('ripplePulse') || 0;
    pool.carry.set('ripplePulse', pulse);
    if (pulse && !prev) pool.emit('ripple', px, py, pz, 0, 0, 0, length * .5, 0);
  }
}
export function emitGroundDust(pool, { matrix: m, origin, scale, length, speed, drift, grounded, dt }) {
  if (grounded && speed < 5) return emitIdleDust(pool, { matrix: m, origin, scale, length, dt });
  const k = Math.min(1, speed / 120), rate = !grounded || speed < 5 ? 0 : drift && speed > 25 ? 170 : 20 + 110 * k;
  const n = rate ? pool.budget('dust', rate, dt) : 0, size = length / 3.5 * (.5 + .5 * k);
  for (let j = 0; j < n; j++) {
    const side = (pool.rand() - .5) * 2, back = .05 + pool.rand() * .15;
    pool.emit('dust', m[12] + origin[0] - m[0] / scale * length * .45 + m[4] / scale * side * length * .35, m[13] + length * .05, m[14] + origin[1] - m[2] / scale * length * .45 + m[6] / scale * side * length * .35,
      -m[0] / scale * speed * back + m[4] / scale * side * (drift ? 8 : 3), 1.5 + pool.rand() * 2.5 * (.5 + k), -m[2] / scale * speed * back + m[6] / scale * side * (drift ? 8 : 3), size * (drift ? 1.4 : 1), size * .3);
  }
}
/** Idle on land: a few small, slow puffs blown outward from under the craft by its hover thrust (bounded by the pool budget and quality). */
export function emitIdleDust(pool, { matrix: m, origin, length, dt }) {
  const n = pool.budget('dust', 7, dt);
  for (let j = 0; j < n; j++) {
    const a = pool.rand() * Math.PI * 2, s = 1.5 + pool.rand() * 1.5;
    pool.emit('dust', m[12] + origin[0] + Math.cos(a) * length * .25, m[13] + length * .05, m[14] + origin[1] + Math.sin(a) * length * .25, Math.cos(a) * s, .4 + pool.rand() * .6, Math.sin(a) * s, length / 6, length * .1);
  }
}
/** Microclimate inside a druidic dome: thin, slow, ethereal mist wisps drifting low around the camera, only while `level` (dome membership 0..1) is non-zero.
 * `ground` is the world height of the dome floor; wisps hover 6..70 yd above it and wander within 320 yd of the eye. */
export function emitDomeMist(pool, { eye, level, ground, dt }) {
  if (level <= .05) return;
  const n = pool.budget('dome-mist', 22 * level, dt);
  for (let j = 0; j < n; j++) {
    const a = pool.rand() * Math.PI * 2, r = 320 * Math.sqrt(pool.rand());
    pool.emit('mist', eye[0] + Math.cos(a) * r, ground + 6 + pool.rand() * 64, eye[2] + Math.sin(a) * r, (pool.rand() - .5) * 2, 0, (pool.rand() - .5) * 2, 1);
  }
}
/** Night glow halos on lamp/torch models: a few soft additive sprites per second at each model-local point of each nearby lamp. */
export function emitLamps(pool, lamps, origin, dt, night) {
  if (night <= .05) return;
  lamps.forEach(({ points, matrix: m }, k) => points.forEach((p, i) => {
    const n = pool.budget(`lamp${k}_${i}`, 14 * night, dt);
    for (let j = 0; j < n; j++) pool.emit('lamp', m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] + origin[0], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] + origin[1], 0, 0, 0, 1 + .25 * pool.rand());
  }));
}
