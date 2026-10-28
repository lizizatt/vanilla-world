// Turns a SWE1R Podd/Part model into the renderer's craft payload (see vehicle-model.js): 12-float vertices
// (position, normal, uv, rgba), uint32 indices, batches per texture, decoded RGBA textures. Clean-room: display-list
// opcodes and vertex layout follow the public N64 F3DEX2 documentation (G_VTX 0x01, G_TRI1 0x05, G_TRI2 0x06, G_QUAD 0x07, G_ENDDL 0xDF).
import { parseModel, applyMat } from './model.js';
import { decodePixels, readPalette, FMT } from './image.js';
import { INTAKE_TEXTURES, intakeIslands, textureAddress } from './intakes.js';

// Mesh texture binding: MeshMaterial { flags, offX, offY, ptr MaterialTexture, ptr Material }; MaterialTexture { format@0xc,
// width@0x10, height@0x12, textureIndex@0x38 (top byte 0x0A flags, low 24 bits index) }.
export function meshTexture(body, mesh) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const mm = mesh.matPtr;
  if (!mm || mm + 16 > body.length) return null;
  const mt = dv.getUint32(mm + 8);
  if (!mt || mt + 0x3c > body.length) return null;
  const child=dv.getUint32(mt+0x1c);
  return { format: dv.getUint16(mt + 0xc), width: dv.getInt16(mt + 0x10), height: dv.getInt16(mt + 0x12), index: dv.getUint32(mt + 0x38) & 0xffffff, flags: dv.getUint32(mm),
    ...textureAddress(child&&child+16<=body.length?body[child+3]:0) };
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

// S10.5 texel coordinates are normalised by a fixed 4096 for every texture size (the header's +0x14/+0x16 scale fields are width*512 / height*512, i.e. the same thing):
// u/4096 = 0..1 spans the whole texture, so a 16x128 strip is not tiled 8x.
const UV_RANGE = 4096;

// The energy binder: a 2-triangle 64x16 pink-arc quad strung between the engines in 23 of 25 racer pods (none in 260 and 268).
// The model data carries no scroll/animation for it, so the web renderer animates it (see beam.js).
export const BEAM_TEXTURE = 815;

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
    const tris=decodeTriangles(body,mesh).map(tri=>({tri,P:tri.map(v=>applyMat(mesh.matrix,v.x,v.y,v.z))}));
    const parts=tex&&INTAKE_TEXTURES.has(t.index)?intakeIslands(tris):[{tris,pivot:null}];
    for(let i=0;i<parts.length;i++){
      const {tris,pivot}=parts[i],address=textureAddress(0);
      if(t){address.addressU=t.addressU;address.addressV=t.addressV;}
      const groupKey=`${key}|${address.addressU}|${address.addressV}|${pivot?`${mesh.off}:${i}`:''}`;
      if(!groups.has(groupKey))groups.set(groupKey,{key,address,pivot,list:[]});
      groups.get(groupKey).list.push({tris,textured:!!tex});
    }
  }
  for (const {key,address,pivot,list} of groups.values()) {
    const first = indices.length;
    for (const { tris, textured } of list) {
      for (const {tri,P} of tris) {
        const e1 = P[1].map((c, i) => c - P[0][i]), e2 = P[2].map((c, i) => c - P[0][i]);
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const nl = Math.hypot(...n) || 1; n = n.map(c => c / nl);
        tri.forEach((v, k) => {
          const [x, y, z] = P[k];
          indices.push(vertices.length / 12);
          vertices.push(x, y, z, n[0], n[1], n[2], textured ? v.u / UV_RANGE : 0, textured ? v.v / UV_RANGE : 0, v.r, v.g, v.b, v.a);
          for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[k][a]); hi[a] = Math.max(hi[a], P[k][a]); }
        });
      }
    }
    const beam = key === `swe1r\\${BEAM_TEXTURE}`;
    if (indices.length > first) batches.push({ firstIndex: first, indexCount: indices.length - first, texture: key, ...alphaMode(textures.get(key)), doubleSided: true, ...address, wrapX: true, wrapY: true, emissive: 0,
      ...(pivot&&{intake:pivot}), ...(beam && { beam: true, blend: 'add', emissive: 1 }) });
  }
  return { asset: { vertices: new Float32Array(vertices), indices: new Uint32Array(indices), batches }, textures: [...textures.values()], bounds: { lo, hi }, meshCount: meshes.length };
}

// Texture alpha decides the mode: binary alpha is a cutout, partial alpha blends, fully opaque (or near-empty) stays opaque.
// shortcut: the original's combiner/render-mode words are not decoded, so an opaque texture that carries alpha is treated as see-through.
export function alphaMode(tex) {
  const opaque = { blend: 'opaque', alphaCutoff: 0 };
  if (!tex) return opaque;
  let clear = 0, partial = 0;
  const px = tex.rgba, n = px.length / 4;
  for (let i = 3; i < px.length; i += 4) { if (px[i] < 250) { if (px[i] < 5) clear++; else partial++; } }
  if (clear + partial < n * 0.02 || clear > n * 0.98) return opaque;
  return partial > (clear + partial) * 0.1 ? { blend: 'alpha', alphaCutoff: 0 } : { blend: 'opaque', alphaCutoff: 0.5 };
}

// Decodes a texture-block item [pixels, palette] using the dimensions/format a mesh material declared.
export function decodeTexture(item, t) {
  const [pixels, palette] = item;
  const pal = t.format === FMT.CI4 ? readPalette(palette, 0, 16) : t.format === FMT.CI8 ? readPalette(palette, 0, 256) : null;
  return { width: t.width, height: t.height, rgba: decodePixels(t.format, pixels, t.width, t.height, pal) };
}
