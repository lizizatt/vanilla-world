// Crash proof of concept (debug only): splits the craft mesh into pod / left engine / right engine, dents it near the
// impact, and replays a Rust rigid-body simulation (flats-racer-physics wreck.rs) recorded at 60 Hz.
const STRIDE = 12;
export const WRECK_SECONDS = 2.6;
export const WRECK_CHUNK = 60;
export const WRECK_CHUNKS = Math.ceil(WRECK_SECONDS * 120 / WRECK_CHUNK);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Craft model space is +x forward, +y left, +z up. Engines sit far forward and off-centre; no centred engine => all pod.
export function classifyTriangles(vertices, indices) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < vertices.length; i += STRIDE) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], vertices[i + a]); hi[a] = Math.max(hi[a], vertices[i + a]); }
  const half = Math.max(Math.abs(lo[1]), Math.abs(hi[1])), xCut = lo[0] + (hi[0] - lo[0]) * .55;
  const part = new Uint8Array(indices.length / 3);
  for (let t = 0; t < part.length; t++) {
    let cx = 0, cy = 0;
    for (let k = 0; k < 3; k++) { const v = indices[t * 3 + k] * STRIDE; cx += vertices[v] / 3; cy += vertices[v + 1] / 3; }
    part[t] = cx > xCut && Math.abs(cy) > half * .3 ? (cy > 0 ? 1 : 2) : 0;
  }
  return { part, lo, hi };
}

// One index buffer per part (sharing the vertex buffer); batches keep their material.
export function splitParts(vertices, indices, batches) {
  const { part, lo, hi } = classifyTriangles(vertices, indices);
  return [0, 1, 2].map(p => {
    const out = [], outBatches = [], min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    for (const batch of batches) {
      const first = out.length;
      for (let i = batch.firstIndex; i < batch.firstIndex + batch.indexCount; i += 3) {
        if (part[i / 3] !== p) continue;
        for (let k = 0; k < 3; k++) {
          const index = indices[i + k], v = index * STRIDE;
          out.push(index);
          for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], vertices[v + a]); max[a] = Math.max(max[a], vertices[v + a]); }
        }
      }
      if (out.length > first) outBatches.push({ ...batch, firstIndex: first, indexCount: out.length - first });
    }
    const empty = !out.length;
    return { indices: Uint32Array.from(out), batches: outBatches, empty,
      center: empty ? [0, 0, 0] : min.map((v, a) => (v + max[a]) / 2), half: empty ? [.1, .1, .1] : max.map((v, a) => Math.max(.02 * (hi[a] - lo[a]), (v - min[a]) / 2)) };
  });
}

// Push vertices near the front of the craft inwards and jitter them, once, at the moment of impact.
export function crumple(vertices, seed = 1, strength = .22) {
  const { lo, hi } = classifyTriangles(vertices, new Uint32Array(0));
  const out = Float32Array.from(vertices), r = rng(seed), size = Math.max(hi[0] - lo[0], 1e-6);
  const impact = [hi[0], (lo[1] + hi[1]) / 2 + (r() - .5) * (hi[1] - lo[1]) * .5, (lo[2] + hi[2]) / 2], radius = size * .45;
  for (let i = 0; i < out.length; i += STRIDE) {
    const d = Math.hypot(out[i] - impact[0], out[i + 1] - impact[1], out[i + 2] - impact[2]), k = Math.max(0, 1 - d / radius);
    if (!k) continue;
    out[i] -= size * strength * k * k * (.6 + r() * .8);
    out[i + 1] += (r() - .5) * size * strength * .6 * k;
    out[i + 2] += (r() - .5) * size * strength * .6 * k;
  }
  return out;
}

/** Model->world rotation columns (unit) and translation from a craftMatrix (which includes scale). */
export function craftFrame(m, scale) {
  return { rot: Float32Array.from([0, 1, 2, 4, 5, 6, 8, 9, 10].map(i => m[i] / scale)), pos: [m[12], m[13], m[14]] };
}

/** Pose record -> 4x4 column-major matrix drawing a part (model vertices around `center`) at the body pose. */
export function partMatrix(pose, center, scale, origin) {
  const [x, y, z, qx, qy, qz, qw] = pose;
  const b = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw)],
    [2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw)],
    [2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
  const m = new Float32Array(16);
  for (let c = 0; c < 3; c++) m.set([b[c][0] * scale, b[c][1] * scale, b[c][2] * scale, 0], c * 4);
  for (let a = 0; a < 3; a++) m[12 + a] = [x - origin[0], y, z - origin[1]][a] - scale * (b[0][a] * center[0] + b[1][a] * center[1] + b[2][a] * center[2]);
  m[15] = 1;
  return m;
}

/** Concatenate `wreck_run` outputs: each is n*7 floats per 60 Hz record, then n connected flags. */
export function appendWreckChunk(wreck, chunk, n) {
  if (chunk.length < n) return;
  wreck.frames.push(...Array.from({ length: (chunk.length - n) / (7 * n) }, (_, f) => chunk.subarray(f * 7 * n, (f + 1) * 7 * n)));
  wreck.connected = Array.from(chunk.subarray(chunk.length - n), v => v > .5);
}

/** Frame to show at `seconds`, holding the last recorded one; undefined before anything is recorded. */
export function wreckFrame(wreck, seconds) {
  if (!wreck.frames.length) return undefined;
  return wreck.frames[Math.min(wreck.frames.length - 1, Math.max(0, Math.floor(seconds * 60)))];
}

// Overheat: engine heat (telemetry 6) just reached 1.0 while boost is held. Shares the gib cooldown (mem.at).
export function overheatTrigger(mem, p, boosting, on, now, blocked = false, cooldown = 5000) {
  const hot = p[6] >= 1, fire = hot && !mem.hot && boosting && on && !blocked && now - (mem.at ?? -1e9) > cooldown;
  mem.hot = hot;
  if (fire) mem.at = now;
  return fire;
}

// Gib on the rising edge of obstacle contact (telemetry 8 === 3) when the last pre-contact speed reaches minSpeed; cooldown in ms.
export function gibTrigger(mem, p, on, minSpeed, now, blocked = false, cooldown = 5000) {
  const hit = p[8] === 3, fire = hit && !mem.hit && on && !blocked && mem.speed >= minSpeed && now - (mem.at ?? -1e9) > cooldown;
  if (!hit) mem.speed = p[5];
  mem.hit = hit;
  if (fire) mem.at = now;
  return fire;
}