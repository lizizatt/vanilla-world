// Builds the start gantry (A), checkpoint gate (C) and overworld flag-beacon as prop lists
// for worldTest.props(). Frame: +x along the road (heading), +y left, +z up, yards. `real` carries preloaded local-asset models
// ({pole,banner,brazier,lens}: {asset,textures,k}); without it the same shapes are procedural boxes (hosted fallback).
const WHITE={key:'white',width:1,height:1,rgba:new Uint8Array([255,255,255,255])};
const FADE_YD=3.5;
const COL={amber:[1,.7,.15,1],red:[1,.12,.08,1],green:[.2,1,.3,1],pole:[.34,.3,.28,1],white:[.95,.95,.95,1],black:[.05,.05,.06,1],dim:[.35,.5,.62,1]};
const FACES=[[[0,0,0],[0,1,0],[0,1,1],[0,0,1],[-1,0,0]],[[1,0,0],[1,0,1],[1,1,1],[1,1,0],[1,0,0]],[[0,0,0],[0,0,1],[1,0,1],[1,0,0],[0,-1,0]],
  [[0,1,0],[1,1,0],[1,1,1],[0,1,1],[0,1,0]],[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,-1]],[[0,0,1],[0,1,1],[1,1,1],[1,0,1],[0,0,1]]];

// With a texture dictionary (name -> {key,width,height,rgba} from worldTest.propTexture) a quad/box given a texture name is drawn
// textured and semi-transparent (opaque -> alpha at TEX_ALPHA, UVs tile every TILE_YD); unknown names fall back to flat colour (hosted).
export const TEX_ALPHA = .62, TILE_YD = 3;
export class Mesh {
  constructor(tex = {}) { this.g = {}; this.T = tex; }
  quad(blend, p, c, t) {
    if (t && this.T[t]) { if (blend === 'opaque') blend = 'alpha'; if (blend === 'alpha') c = c.map(x => [x[0], x[1], x[2], x[3] * TEX_ALPHA]); } else t = undefined;
    (this.g[blend + '|' + (t || '')] ||= []).push({ p, c, t }); return this;
  }
  box(blend, [x, y, z], [w, d, h], c, t) {
    for (const f of FACES) this.quad(blend, f.slice(0, 4).map(([a, b, e]) => [x + a * w, y + b * d, z + e * h]), [c, c, c, c], t);
    return this;
  }
  column(blend, r, z0, z1, bottom, top, sides = 4) { // open tube: gradient from bottom to top colour
    for (let i = 0; i < sides; i++) {
      const a = i / sides * Math.PI * 2, b = (i + 1) / sides * Math.PI * 2;
      this.quad(blend, [[Math.cos(a) * r, Math.sin(a) * r, z0], [Math.cos(b) * r, Math.sin(b) * r, z0], [Math.cos(b) * r, Math.sin(b) * r, z1], [Math.cos(a) * r, Math.sin(a) * r, z1]], [bottom, bottom, top, top]);
    }
    return this;
  }
  build() {
    const V = [], I = [], batches = [];
    const used = new Map();
    for (const [group, quads] of Object.entries(this.g)) {
      const [blend, name] = group.split('|'), tex = name && this.T[name];
      if (tex) used.set(tex.key, tex);
      const firstIndex = I.length;
      for (const { p, c } of quads) {
        const len = (a, b) => Math.hypot(...[0, 1, 2].map(k => p[b][k] - p[a][k])), us = tex ? len(0, 1) / TILE_YD : 1, vs = tex ? len(0, 3) / TILE_YD : 1;
        const [u, v, w] = [0, 1, 2].map(k => p[1][k] - p[0][k]), [s, t, o] = [0, 1, 2].map(k => p[3][k] - p[0][k]);
        let n = [v * o - w * t, w * s - u * o, u * t - v * s]; const l = Math.hypot(...n) || 1; n = n.map(x => x / l);
        const base = V.length / 12;
        p.forEach((q, k) => V.push(...q, ...n, (k === 1 || k === 2 ? 1 : 0) * us, (k > 1 ? 1 : 0) * vs, ...c[k]));
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      batches.push({ firstIndex, indexCount: I.length - firstIndex, texture: tex ? tex.key : 'white', blend, alphaCutoff: 0, emissive: true, doubleSided: true, wrapX: true, wrapY: true, noDepthWrite: blend === 'add' });
    }
    return { asset: { vertices: new Float32Array(V), indices: new Uint32Array(I), batches }, textures: [WHITE, ...used.values()] };
  }
}

// Clips every triangle at z=h and scales vertex alpha by floor..1 below it; opaque batches become alpha-blended.
export function fadeGround(asset, { h, floor = .12 }) {
  const src = asset.vertices, V = [], I = [], batches = [];
  const vert = i => Array.from(src.subarray(i * 12, i * 12 + 12));
  const mix = (a, b, t) => a.map((x, k) => x + (b[k] - x) * t);
  const ramp = p => { if (p[2] < h) p[11] *= floor + (1 - floor) * Math.max(0, p[2]) / h; return p; };
  const lower = poly => { // Sutherland-Hodgman against z<=h; upper part is untouched so only the lower polygon is emitted separately
    const out = [];
    poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length], ia = a[2] <= h, ib = b[2] <= h;
      if (ia) out.push(a); if (ia !== ib) out.push(mix(a, b, (h - a[2]) / (b[2] - a[2]))); });
    return out;
  };
  const upper = poly => {
    const out = [];
    poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length], ia = a[2] >= h, ib = b[2] >= h;
      if (ia) out.push(a); if (ia !== ib) out.push(mix(a, b, (h - a[2]) / (b[2] - a[2]))); });
    return out;
  };
  const emit = (poly, f) => { if (poly.length < 3) return; const ids = poly.map(p => { V.push(...(f ? ramp(p.slice()) : p)); return V.length / 12 - 1; });
    for (let k = 1; k < ids.length - 1; k++) I.push(ids[0], ids[k], ids[k + 1]); };
  for (const b of asset.batches) {
    const first = I.length;
    for (let t = b.firstIndex; t < b.firstIndex + b.indexCount; t += 3) {
      const poly = [0, 1, 2].map(k => vert(asset.indices[t + k]));
      emit(lower(poly), true); emit(upper(poly), false);
    }
    batches.push({ ...b, firstIndex: first, indexCount: I.length - first, blend: b.blend === 'opaque' ? 'alpha' : b.blend });
  }
  return { vertices: new Float32Array(V), indices: new Uint32Array(I), batches };
}

// Recolours a model's vertices (multiplies with the texel in the shader), e.g. a lens lit red/amber/green.
export const tint = (asset, c) => { const v = new Float32Array(asset.vertices); for (let i = 0; i < v.length; i += 12) for (let k = 0; k < 4; k++) v[i + 8 + k] = c[k]; return { ...asset, vertices: v }; };

// Gate-local (forward, left, up) -> world prop pos [x, height, z], matching craftMatrix's basis.
export const place = (at, yaw, [f, l, u]) => { const s = Math.sin(yaw), c = Math.cos(yaw); return [at[0] - f * s - l * c, at[1] + u, at[2] - f * c + l * s]; };

const mk = (m, at, yaw) => ({ ...m.build(), space: 'craft', scale: 1, pos: at, yaw });
const model = (at, yaw, local, m, k, extra = {}) => ({ asset: extra.asset || m.asset, textures: m.textures, space: 'craft', scale: k * (m.k || 1), pos: place(at, yaw, local), yaw, ...extra.p });
const faded = p => ({ ...p, asset: fadeGround(p.asset, { h: FADE_YD / (p.scale || 1) }) });

// A: start/finish gantry. phase 0 off, 1 red, 2 amber, 3 green lights.
export function gantry({ at, yaw, width = 30, phase = 3, real }) {
  const m = new Mesh(real?.tex), h = width / 2, lamp = [COL.red, COL.amber, COL.green];
  const out = [];
  if (!real) for (const s of [-1, 1]) m.box('opaque', [-.5, s * h - .5, 0], [1, 1, 17], COL.pole);
  m.box('opaque', [-.8, -h, 15], [1.6, width, 1.4], real ? COL.white : COL.pole, 'wood');
  const n = Math.round(width / 1.5);
  for (let r = 0; r < 2; r++) for (let i = 0; i < n; i++) m.box('opaque', [-.85 - r * .02, -h + i * width / n, 16.4 + r * 1.0], [.2, width / n, 1.0], (i + r) % 2 ? COL.white : COL.black);
  m.box('opaque', [-1.1, -4.2, 11.6], [1.6, 8.4, 3.2], real ? COL.white : COL.pole, 'iron');
  if (real) for (const s of [-1, 1]) m.box('opaque', [-.9, s * h - .9, 0], [1.8, 1.8, 1.4], COL.white, 'stone');
  for (let i = 0; i < 3; i++) m.box(real ? 'add' : 'opaque', [-1.3, -3.6 + i * 2.8, 12.0], [.3, 2.0, 2.0], i + 1 === phase ? lamp[i] : [.12, .12, .12, 1]);
  out.push(faded(mk(m, at, yaw)));
  if (real) {
    for (const s of [-1, 1]) out.push(faded(model(at, yaw, [0, s * h, 0], real.pole, 1.7)));
    for (let i = 0; i < 3 && real.lens; i++) out.push(model(at, yaw, [-1.3, -2.8 + i * 2.8, 12.4], real.lens, 1, { asset: tint(real.lens.asset, i + 1 === phase ? lamp[i] : [.15, .15, .15, 1]) }));
  }
  return out;
}

// C: checkpoint gate. state 'next' amber, 'passed' dim.
export function checkpoint({ at, yaw, width = 24, state = 'next', pulse = 1, real }) {
  const m = new Mesh(real?.tex), h = width / 2, hot = state === 'next', c = hot ? COL.amber : COL.dim, a = hot ? .3 * pulse : .2;
  const out = [];
  if (!real) for (const s of [-1, 1]) { m.box('opaque', [-.4, s * h - .4, 0], [.8, .8, 10], COL.pole); m.box('add', [-1.1, s * h - 1.1, 10], [2.2, 2.2, 2.2], [...c.slice(0, 3), 1]); }
  const beams = new Mesh();
  for (const s of [-1, 1]) { const g = new Mesh().column('add', hot ? 1.6 : .8, 10.5, 140, [...c.slice(0, 3), a], [...c.slice(0, 3), 0], 6); for (const q of g.g['add|']) beams.quad('add', q.p.map(([x, y, z]) => [x, y + s * h, z]), q.c); }
  const beamTex = new Mesh(real?.tex);
  beamTex.quad('add', [[0, -h, 0], [0, h, 0], [0, h, 9], [0, -h, 9]], [[...c.slice(0, 3), .02], [...c.slice(0, 3), .02], [...c.slice(0, 3), .22 * (hot ? pulse : .5)], [...c.slice(0, 3), .22 * (hot ? pulse : .5)]], 'zap');
  if (real) for (const s of [-1, 1]) m.box('opaque', [-1, s * h - 1, 0], [2, 2, 1.3], COL.white, 'metal');
  const body = new Mesh(real?.tex); for (const g of [m.g, beams.g, beamTex.g]) for (const [k, q] of Object.entries(g)) (body.g[k] ||= []).push(...q);
  out.push(faded(mk(body, at, yaw)));
  if (real) for (const s of [-1, 1]) {
    out.push(faded(model(at, yaw, [0, s * h, 0], real.pole, .95)));
    out.push(model(at, yaw, [0, s * h, 9.3], real.brazier, 1.5));
  }
  return out;
}

// Overworld race label: tall pole + banner + pulsing sky beam. fade of the beam top is to transparent (sky colour shows through).
export function beacon({ at, yaw, pulse = 1, height = 700, real }) {
  const m = new Mesh(real?.tex);
  if (real) { m.box('opaque', [-3, -3, 0], [6, 6, 1.6], COL.white, 'stone'); m.box('alpha', [-.2, .3, 20], [.3, 9, 9], [1, 1, 1, 1], 'flag'); }
  if (!real) { m.box('opaque', [-.5, -.5, 0], [1, 1, 30], COL.pole); m.box('opaque', [-.2, .5, 24], [.4, 6, 4.5], COL.red); m.box('opaque', [-.2, .5, 28.5], [.4, 6, 1], COL.white); }
  m.column('add', 1.6, 30, height, [1, .75, .25, .6 * pulse], [1, .75, .25, 0], 8);
  m.column('add', 5, 30, height * .6, [1, .6, .2, .12 * pulse], [1, .6, .2, 0], 8);
  const out = [mk(m, at, yaw)];
  if (real) out.push(model(at, yaw, [0, 0, 0], real.pole, 3));
  return out;
}
