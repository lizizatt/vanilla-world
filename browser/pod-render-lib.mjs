// Pure helpers for render-smoke-pod.mjs (kept separate so they are unit-tested without a browser).
export const VIEWS = ['front', 'side', 'three-quarter', 'top', 'rear'];

// Free-flight camera pose [x, y, z, yaw, pitch] looking at `target` from a craft-relative direction.
// Craft forward in world (x, z) is (-sin yaw, -cos yaw); left is (-cos yaw, sin yaw).
export function viewPose(craft, view, dist) {
  const [x, y, z, yaw] = craft, f = [-Math.sin(yaw), -Math.cos(yaw)], l = [-Math.cos(yaw), Math.sin(yaw)];
  const dir = { front: [f[0], 0.15, f[1]], rear: [-f[0], 0.15, -f[1]], side: [l[0], 0.15, l[1]],
    'three-quarter': [f[0] + l[0], 0.5, f[1] + l[1]], top: [0.001 * f[0], 1, 0.001 * f[1]] }[view];
  if (!dir) throw new Error(`unknown view ${view}`);
  const n = Math.hypot(...dir), t = [x, y + 0.8, z], c = dir.map((v, i) => t[i] + (v / n) * dist);
  const d = t.map((v, i) => v - c[i]);
  return [...c, Math.atan2(-d[0], -d[2]), Math.asin(d[1] / Math.hypot(...d))];
}

// rgba: Uint8ClampedArray of a centre crop. `flat` = no variation at all (nothing drawn / blank frame).
export function pixelStats(rgba) {
  let magenta = 0, n = rgba.length / 4, sum = 0, sq = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (r > 200 && b > 200 && g < 60) magenta++;
    const l = (r + g + b) / 3; sum += l; sq += l * l;
  }
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  return { magentaFraction: magenta / n, stddev: sd, flat: sd < 1 };
}

// asset: craft payload { vertices (12 floats each), indices }, in craft space (+x forward). Engines must lead the pod.
export function modelChecks(asset, scale = 1) {
  const v = asset.vertices, defects = [], warnings = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let bad = 0;
  for (let i = 0; i < v.length; i += 12) for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(v[i + a])) bad++; else { lo[a] = Math.min(lo[a], v[i + a]); hi[a] = Math.max(hi[a], v[i + a]); }
  }
  const size = hi.map((h, a) => (h - lo[a]) * scale), tris = asset.indices.length / 3;
  if (bad) defects.push(`${bad} non-finite vertex coordinates`);
  if (!tris) defects.push('no triangles');
  if (!bad && (Math.max(...size) < 1 || Math.max(...size) > 40)) defects.push(`implausible size ${size.map(s => s.toFixed(1)).join('x')} yd`);
  if (!bad && hi[0] <= -lo[0]) warnings.push('engines do not lead the pod (extent forward <= extent behind; origin is the pod, so informational)');
  return { tris, size, lo, hi, defects, warnings };
}
