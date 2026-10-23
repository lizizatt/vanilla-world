// Pure plume-placement heuristics for one craft (craft space: +x forward, +y left, +z up; any uniform unit). Used by plume-audit.mjs and tests.
import { classifyTriangles } from './wreck.js';
import { exhaustPoints, engineRear } from './particles.js';

const S = 12;

function engineStats(vertices, indices, part, id) {
  const ids = new Set();
  for (let t = 0; t < part.length; t++) if (part[t] === id) for (let k = 0; k < 3; k++) ids.add(indices[t * 3 + k]);
  if (!ids.size) return undefined;
  const rearPoint = engineRear(vertices, ids), minX = rearPoint[0];
  let maxX = -1e9;
  for (const i of ids) maxX = Math.max(maxX, vertices[i * S]);
  const rear = [...ids].filter(i => vertices[i * S] >= minX && vertices[i * S] < minX + (maxX - minX) * .15);
  const c = [rearPoint[0], 1, 2].map((_, a) => a ? rear.reduce((s, i) => s + vertices[i * S + a], 0) / rear.length : minX);
  const radius = Math.sqrt(rear.reduce((s, i) => s + (vertices[i * S + 1] - c[1]) ** 2 + (vertices[i * S + 2] - c[2]) ** 2, 0) / rear.length);  return { ids, minX, maxX, center: c, radius, verts: ids.size };
}

/** Returns { points, engines, flags[], metrics } for a craft's vertices/indices and its emitter points (default: what the renderer derives). */
export function checkPlumes({ vertices, indices, points, expected = 2 }) {
  const { part, lo, hi } = classifyTriangles(vertices, indices);
  points ??= exhaustPoints(vertices, indices, undefined);
  const length = hi[0] - lo[0], flags = [], eng = [1, 2].map(id => engineStats(vertices, indices, part, id)), found = eng.filter(Boolean).length;
  if (found !== expected) flags.push(`engines:${found}`);
  if (points.length !== expected) flags.push(`emitters:${points.length}`);
  const other = new Set();
  for (let t = 0; t < part.length; t++) if (part[t] === 0) for (let k = 0; k < 3; k++) other.add(indices[t * 3 + k]);
  const metrics = points.map(p => {
    const e = eng.filter(Boolean).sort((a, b) => Math.hypot(a.center[1] - p[1], a.center[2] - p[2]) - Math.hypot(b.center[1] - p[1], b.center[2] - p[2]))[0];
    if (!e) return { engine: false };
    const lateral = Math.hypot(p[1] - e.center[1], p[2] - e.center[2]) / (e.radius || 1), behind = (e.minX - p[0]) / length;
    let near = 1e9, blocked = 0;
    for (const i of e.ids) near = Math.min(near, Math.hypot(vertices[i * S] - p[0], vertices[i * S + 1] - p[1], vertices[i * S + 2] - p[2]));
    for (const i of other) {
      const x = vertices[i * S] - p[0], r = Math.hypot(vertices[i * S + 1] - p[1], vertices[i * S + 2] - p[2]);
      if (x < length * .15 && x > -length * .2 && r < e.radius * .6) blocked++;
    }
    return { lateral, behind, near: near / (e.radius || 1), blocked, radius: e.radius / length };
  });
  metrics.forEach((m, i) => {
    if (m.engine === false) return;
    if (m.lateral > .9) flags.push(`emitter${i}:off-axis ${m.lateral.toFixed(2)}r`);
    if (m.behind > .08) flags.push(`emitter${i}:floating ${(m.behind * 100).toFixed(0)}% behind`);
    if (m.near > 1.5) flags.push(`emitter${i}:far-from-vertices ${m.near.toFixed(1)}r`);
    if (m.blocked > 40) flags.push(`emitter${i}:hull-occluded ${m.blocked}`);
  });
  if (points.length === 2 && Math.hypot(points[0][1] - points[1][1], points[0][2] - points[1][2]) < length * .06) flags.push('merged');
  if (points.length === 2 && Math.abs(Math.abs(points[0][1]) - Math.abs(points[1][1])) > length * .08) flags.push('asymmetric');
  return { points, engines: eng.map(e => e && { rearX: e.minX, center: e.center, radius: e.radius, verts: e.verts }), length, flags, metrics };
}
