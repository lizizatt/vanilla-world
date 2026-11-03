// usage: node browser/rogue/render.mjs <DATA.DAT> <asset e.g. falcon_HOB> <out.png>
// Software-rasterises a decoded HOB model from 4 viewpoints (z-buffer, vertex colour x lambert). Debug tool; output stays untracked.
import fs from 'node:fs';
import { readDirectory, parseHob, parseHmt, hobTriangles } from './dat.js';
import { encodePng } from '../swe1r/png.js';

const [dat, asset = 'falcon_HOB', out = 'rogue-render.png'] = process.argv.slice(2);
const buf = fs.readFileSync(dat), dir = readDirectory(buf), e = dir.get(asset);
if (!e) { console.error('no such asset; have:', [...dir.keys()].join(' ')); process.exit(1); }
const hob = parseHob(buf, e.offset, e.size), tris = hobTriangles(hob);
const he = dir.get(asset.replace(/_HOB$/, '_HMT')), hmt = he && parseHmt(buf, he.offset, he.size);
const texOf = t => { const m = hmt?.materials[t.material]; return m?.kind === 1 ? hmt.textures[m.tex] : null; };
console.log(asset, 'nodes', hob.nodes.length, 'meshes', hob.nodes.reduce((a, n) => a + n.meshes.length, 0), 'tris', tris.length, 'bounds', JSON.stringify(hob.bounds));

const W = 480, H = 360, views = [['3/4', 0.6, 0.45], ['top', 0, 1.5], ['side', Math.PI / 2, 0], ['front', 0, 0]];
const img = new Uint8Array(W * H * 2 * 4 * 1).fill(0);
const full = new Uint8Array(W * 2 * H * 2 * 4);
for (let i = 3; i < full.length; i += 4) full[i] = 255;
const ctr = [0, 1, 2].map(i => (hob.bounds.min[i] + hob.bounds.max[i]) / 2), R = Math.hypot(...hob.bounds.max.map((x, i) => x - hob.bounds.min[i])) / 2;
views.forEach(([, yaw, pitch], vi) => {
  const ox = (vi % 2) * W, oy = (vi >> 1) * H, z = new Float32Array(W * H).fill(1e9);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const xf = p => { const x = p[0] - ctr[0], y = p[1] - ctr[1], zz = p[2] - ctr[2]; const x1 = x * cy + zz * sy, z1 = -x * sy + zz * cy; return [x1, y * cp - z1 * sp, y * sp + z1 * cp]; };
  const k = Math.min(W, H) / (2.1 * R);
  for (const t of tris) {
    const p = t.v.map(xf), s = p.map(q => [W / 2 + q[0] * k, H / 2 - q[1] * k, q[2]]);
    const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; const nl = Math.hypot(...n) || 1;
    const lam = Math.abs(n[2] / nl) * 0.7 + 0.3, col = [0, 1, 2].map(i => (t.color[0][i] + t.color[1][i] + t.color[2][i]) / 3 * lam);
    const x0 = Math.max(0, Math.floor(Math.min(...s.map(q => q[0])))), x1 = Math.min(W - 1, Math.ceil(Math.max(...s.map(q => q[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...s.map(q => q[1])))), y1 = Math.min(H - 1, Math.ceil(Math.max(...s.map(q => q[1]))));
    const d = (s[1][1] - s[2][1]) * (s[0][0] - s[2][0]) + (s[2][0] - s[1][0]) * (s[0][1] - s[2][1]);
    if (!d) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l0 = ((s[1][1] - s[2][1]) * (x - s[2][0]) + (s[2][0] - s[1][0]) * (y - s[2][1])) / d, l1 = ((s[2][1] - s[0][1]) * (x - s[2][0]) + (s[0][0] - s[2][0]) * (y - s[2][1])) / d, l2 = 1 - l0 - l1;
      if (l0 < -1e-3 || l1 < -1e-3 || l2 < -1e-3) continue;
      const zz = l0 * s[0][2] + l1 * s[1][2] + l2 * s[2][2];
      if (zz >= z[y * W + x]) continue;
      z[y * W + x] = zz;
      let c = col;
      const tx = t.uv && texOf(t);
      if (tx) {
        const u = l0 * t.uv[0][0] + l1 * t.uv[1][0] + l2 * t.uv[2][0], v = l0 * t.uv[0][1] + l1 * t.uv[1][1] + l2 * t.uv[2][1];
        const px = ((Math.floor(u * tx.w) % tx.w) + tx.w) % tx.w, py = ((Math.floor(v * tx.h) % tx.h) + tx.h) % tx.h, to = (py * tx.w + px) * 4;
        c = [0, 1, 2].map(i => col[i] * tx.rgba[to + i] / 255);
      }
      const o = ((oy + y) * W * 2 + ox + x) * 4; full[o] = c[0]; full[o + 1] = c[1]; full[o + 2] = c[2];
    }
  }
});
fs.writeFileSync(out, encodePng(W * 2, H * 2, full));
console.log('wrote', out);
