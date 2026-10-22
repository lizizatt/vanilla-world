// Shared particle layer: a CPU ring buffer of billboards drawn in one instanced pass. Colours are premultiplied, so one
// blend state (one, one-minus-src-alpha) gives both additive fire (alpha 0) and normal smoke/dust (alpha > 0).
import { classifyTriangles } from './wreck.js';
export const CAPACITY = 2048;
export const QUALITY = { off: 0, low: .35, medium: .7, high: 1 };
export const INSTANCE_FLOATS = 8;
const STRIDE = 12; // x y z vx vy vz age life size0 size1 kind seed

// stops: [u, r, g, b, alpha, glow]; glow 1 = purely additive, 0 = ordinary alpha blend.
export const KINDS = {
  plume: { life: [.18, .34], size: [.28, .12], drag: 2.5, lift: 0, stops: [[0, .6, .78, 1, .5, 1], [.25, 1, .6, .2, .42, 1], [.7, .85, .22, .04, .18, 1], [1, .3, .08, .02, 0, 1]] },
  fire: { life: [.4, .9], size: [.5, .15], drag: 1.2, lift: 3, stops: [[0, 1, .9, .5, .9, 1], [.35, 1, .45, .08, .7, .9], [1, .35, .05, .02, 0, .8]] },
  smoke: { life: [1.2, 2.4], size: [.4, 1.8], drag: 1.5, lift: 2.5, stops: [[0, .35, .35, .37, .0, 0], [.12, .3, .3, .32, .5, 0], [1, .2, .2, .22, 0, 0]] },
  dust: { life: [.6, 1.3], size: [.4, 1.6], drag: 2.2, lift: 1.2, stops: [[0, .62, .55, .42, .4, 0], [1, .62, .55, .42, 0, 0]] },
  burst: { life: [.25, .5], size: [1, 3.5], drag: 4, lift: 0, stops: [[0, 1, .95, .7, 1, 1], [.4, 1, .55, .12, .7, 1], [1, .5, .1, .02, 0, 1]] },
};
const KIND_IDS = Object.keys(KINDS);

export class ParticlePool {
  constructor(capacity = CAPACITY, rand = Math.random) {
    this.capacity = capacity; this.rand = rand; this.data = new Float32Array(capacity * STRIDE);
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
      d[o + 3] *= damp; d[o + 4] = d[o + 4] * damp + k.lift * dt; d[o + 5] *= damp;
      d[o] += d[o + 3] * dt; d[o + 1] += d[o + 4] * dt; d[o + 2] += d[o + 5] * dt;
    }
  }
  get count() { let n = 0; for (let i = 0; i < this.capacity; i++) if (this.data[i * STRIDE + 6] < this.data[i * STRIDE + 7]) n++; return n; }
  /** Write live particles (eye-relative position, size, premultiplied rgba) into out; returns how many. */
  fill(out, eye) {
    const d = this.data; let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * STRIDE; if (d[o + 6] >= d[o + 7]) continue;
      const k = KINDS[KIND_IDS[d[o + 10]]], u = d[o + 6] / d[o + 7], c = gradient(k.stops, u), q = n * INSTANCE_FLOATS;
      out[q] = d[o] - eye[0]; out[q + 1] = d[o + 1] - eye[1]; out[q + 2] = d[o + 2] - eye[2];
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
export function exhaustPoints(vertices, indices, metadata) {
  if (metadata?.exhausts?.length) return metadata.exhausts.map(p => [...p]);
  const { part, lo, hi } = classifyTriangles(vertices, indices), points = [];
  for (const id of [1, 2]) {
    let min = 1e9, n = 0, sy = 0, sz = 0;
    for (let t = 0; t < part.length; t++) if (part[t] === id) for (let k = 0; k < 3; k++) min = Math.min(min, vertices[indices[t * 3 + k] * STRIDE_V]);
    if (min === 1e9) continue;
    const rear = min + (hi[0] - lo[0]) * .05;
    for (let t = 0; t < part.length; t++) if (part[t] === id) for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * STRIDE_V; if (vertices[v] > rear) continue;
      sy += vertices[v + 1]; sz += vertices[v + 2]; n++;
    }
    points.push([min, sy / n, sz / n]);
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