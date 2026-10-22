// Turns a SWE1R Podd/Part model into the renderer's craft payload (see vehicle-model.js): 12-float vertices
// (position, normal, uv, rgba), uint32 indices, batches per texture, decoded RGBA textures. Clean-room: display-list
// opcodes and vertex layout follow the public N64 F3DEX2 documentation (G_VTX 0x01, G_TRI1 0x05, G_TRI2 0x06, G_QUAD 0x07, G_ENDDL 0xDF).
import { parseModel, applyMat } from './model.js';
import { decodePixels, readPalette, FMT } from './image.js';

// Mesh texture binding: MeshMaterial { flags, offX, offY, ptr MaterialTexture, ptr Material }; MaterialTexture { format@0xc,
// width@0x10, height@0x12, textureIndex@0x38 (top byte 0x0A flags, low 24 bits index) }.
export function meshTexture(body, mesh) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const mm = mesh.matPtr;
  if (!mm || mm + 16 > body.length) return null;
  const mt = dv.getUint32(mm + 8);
  if (!mt || mt + 0x3c > body.length) return null;
  return { format: dv.getUint16(mt + 0xc), width: dv.getInt16(mt + 0x10), height: dv.getInt16(mt + 0x12), index: dv.getUint32(mt + 0x38) & 0xffffff, flags: dv.getUint32(mm) };
}

export function decodeTriangles(body, mesh) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const slots = new Array(64).fill(null);
  const tris = [];
  let mode = 0x20000; // pod display lists never set G_GEOMETRYMODE, and their vertex bytes are signed normals (0x82/0x7e/0x00 patterns), not colours
  for (let o = mesh.cl; o + 8 <= body.length; o += 8) {
    const op = body[o], w0 = dv.getUint32(o), w1 = dv.getUint32(o + 4);
    if (op === 0xdf) break;
    if (op === 0xd9) mode = ((mode & w0) | w1) >>> 0; // G_GEOMETRYMODE (F3DEX2): clear mask in w0, set bits in w1
    else if (op === 0x01) {
      const n = (w0 >> 12) & 0xff, v0 = ((w0 >> 1) & 0x7f) - n, at = w1, lit = (mode & 0x20000) !== 0; // G_LIGHTING: bytes are normals, else vertex colour
      if (v0 < 0 || v0 + n > 64 || at + n * 16 > body.length) break;
      for (let i = 0; i < n; i++) {
        const p = at + i * 16;
        slots[v0 + i] = { x: dv.getInt16(p), y: dv.getInt16(p + 2), z: dv.getInt16(p + 4), u: dv.getInt16(p + 8), v: dv.getInt16(p + 10),
          nx: 0, ny: 0, nz: 0, a: body[p + 15] / 255,
          ...(lit ? { r: 1, g: 1, b: 1 } : { r: body[p + 12] / 255, g: body[p + 13] / 255, b: body[p + 14] / 255 }) };
      }
    } else if (op === 0x05 || op === 0x06 || op === 0x07) {
      const tri = w => [((w >> 16) & 0xff) >> 1, ((w >> 8) & 0xff) >> 1, (w & 0xff) >> 1].map(i => slots[i]);
      const a = tri(w0);
      if (a.every(Boolean)) tris.push(a);
      if (op !== 0x05) { const b = tri(w1); if (b.every(Boolean)) tris.push(b); }
    }
  }
  return tris;
}

// opts.texture(t) -> { width, height, rgba } | null. Returns { asset, textures, bounds }; coordinates are the model's own
// (callers map axes and scale).
export function buildPod(body, mask, opts = {}) {
  const meshes = parseModel(body, mask).meshes;
  const vertices = [], indices = [], batches = [], textures = new Map();
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  const groups = new Map();
  for (const mesh of meshes) {
    const t = meshTexture(body, mesh);
    let tex = t && opts.texture ? opts.texture(t) : null;
    if (tex && !textures.has(`swe1r\\${t.index}`) && textures.size >= (opts.maxTextures ?? 64)) tex = null; // renderer's craft payload limit; the rest stay untextured
    const key = tex ? `swe1r\\${t.index}` : null;
    if (tex && !textures.has(key)) textures.set(key, { key, width: tex.width, height: tex.height, rgba: tex.rgba });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ mesh, t: tex ? { w: tex.width, h: tex.height } : null });
  }
  for (const [key, list] of groups) {
    const first = indices.length;
    for (const { mesh, t } of list) {
      for (const tri of decodeTriangles(body, mesh)) {
        const P = tri.map(v => applyMat(mesh.matrix, v.x, v.y, v.z));
        const e1 = P[1].map((c, i) => c - P[0][i]), e2 = P[2].map((c, i) => c - P[0][i]);
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const nl = Math.hypot(...n) || 1; n = n.map(c => c / nl);
        tri.forEach((v, k) => {
          const [x, y, z] = P[k];
          indices.push(vertices.length / 12);
          vertices.push(x, y, z, n[0], n[1], n[2], t ? v.u / 32 / t.w : 0, t ? v.v / 32 / t.h : 0, v.r, v.g, v.b, v.a);
          for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[k][a]); hi[a] = Math.max(hi[a], P[k][a]); }
        });
      }
    }
    if (indices.length > first) batches.push({ firstIndex: first, indexCount: indices.length - first, texture: key, blend: 'opaque', alphaCutoff: 0, doubleSided: true, wrapX: true, wrapY: true, emissive: 0 });
  }
  return { asset: { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), batches }, textures: [...textures.values()], bounds: { lo, hi }, meshCount: meshes.length };
}

// Decodes a texture-block item [pixels, palette] using the dimensions/format a mesh material declared.
export function decodeTexture(item, t) {
  const [pixels, palette] = item;
  const pal = t.format === FMT.CI4 ? readPalette(palette, 0, 16) : t.format === FMT.CI8 ? readPalette(palette, 0, 256) : null;
  return { width: t.width, height: t.height, rgba: decodePixels(t.format, pixels, t.width, t.height, pal) };
}
