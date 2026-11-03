// Minimal Rogue Squadron 3D DATA.DAT reader: asset directory + "HOB" object models. Parses user-supplied bytes only.
// Verified against the Falcon (see browser/design/rogue-squadron-survey.md, "DAT decoder").
const SCALE = 1 / 256;

/** The asset directory sits near the end of DATA.DAT as 32-byte entries: u32 offset, u32 size, i32 -1, u32 2, char name[16]. */
export function readDirectory(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const isEntry = o => o >= 0 && o + 32 <= buf.length && dv.getInt32(o + 8, true) === -1 && dv.getUint32(o + 12, true) === 2 &&
    dv.getUint32(o, true) < buf.length && buf[o + 16] > 32;
  const out = new Map();
  // directories are scattered (one per data segment): take every run of two or more consecutive entries
  for (let p = 0; p + 64 <= buf.length; p += 4) {
    if (!isEntry(p) || !isEntry(p + 32)) continue;
    for (; isEntry(p); p += 32) {
      let n = ''; for (let i = 16; i < 32 && buf[p + i]; i++) n += String.fromCharCode(buf[p + i]);
      if (!out.has(n)) out.set(n, { offset: dv.getUint32(p, true), size: dv.getUint32(p + 4, true) });
    }
  }
  if (!out.size) throw Error('DATA.DAT directory not found');
  return out;
}

/**
 * HOB: little-endian memory image with file-relative pointers.
 *  header +0x00 version, +0x08 char name[16], +0x18 root node, bounds min xyz at +0x64, max at +0x70
 *  node (0x84 B): +0x00/+0x04/+0x0c sibling/child links, +0x08 parent, +0x10 first mesh, +0x50 translation, +0x5c scale
 *  mesh (0x60 B): +0x00 next mesh, +0x14 vertex count, +0x18 normal count, +0x20 packet list, +0x24 verts, +0x28 normals
 *  vertex/normal: 4 x i16 (x,y,z,pad), vertices 1/256 units, normals 256 = unit length
 *  packet list: +0x08 first packet, +0x0c packet count. Packet: dword id, dword tag, tag>>24 = length in dwords,
 *    tag bit0 quad (else triangle), bit1 has normal indices; dword2 hi16 = material index; then u16 position indices,
 *    u16 normal indices (optional), ABGR vertex colours, optional (u,v) u16 pairs in 4.12 fixed point.
 */
export function parseHob(buf, offset, size) {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, size);
  const u32 = o => dv.getUint32(o, true), u16 = o => dv.getUint16(o, true), f32 = o => dv.getFloat32(o, true);
  let name = ''; for (let i = 8; i < 24 && dv.getUint8(i); i++) name += String.fromCharCode(dv.getUint8(i));
  const vec = (p, n, k) => Array.from({ length: n }, (_, i) => [0, 1, 2].map(j => dv.getInt16(p + i * 8 + j * 2, true) * k));
  const parseMesh = m => {
    const nv = u32(m + 0x14), nn = u32(m + 0x18), list = u32(m + 0x20);
    const mesh = { verts: vec(u32(m + 0x24), nv, SCALE), normals: vec(u32(m + 0x28), nn, SCALE), polys: [] };
    let o = u32(list + 8);
    for (let n = u32(list + 0xc); n > 0; n--) {
      const tag = u32(o + 4), len = tag >>> 24, nvt = tag & 1 ? 4 : 3;
      if (len < 4) throw Error('bad packet at 0x' + o.toString(16));
      let p = o + 12;
      const rdIdx = () => { const r = []; for (let i = 0; i < nvt; i++) r.push(u16(p + (i >> 1) * 4 + (i & 1) * 2)); p += 8; return r; };
      const poly = { material: u32(o + 8) >>> 16, tag, idx: rdIdx() };
      if (tag & 2) poly.nidx = rdIdx();
      poly.colors = []; for (let i = 0; i < nvt; i++, p += 4) poly.colors.push(u32(p));
      if (o + len * 4 - p >= nvt * 4) { poly.uv = []; for (let i = 0; i < nvt; i++, p += 4) poly.uv.push([u16(p) / 4096, u16(p + 2) / 4096]); }
      mesh.polys.push(poly);
      o += len * 4;
    }
    return mesh;
  };
  const seen = new Set(), nodes = [];
  const walk = (p, parent) => {
    if (!p || p + 0x84 > size || seen.has(p)) return;
    seen.add(p);
    const n = { at: p, parent, t: [f32(p + 0x50), f32(p + 0x54), f32(p + 0x58)], s: [f32(p + 0x5c), f32(p + 0x60), f32(p + 0x64)], meshes: [] };
    for (let m = u32(p + 0x10), g = 0; m && g < 16; m = u32(m), g++) n.meshes.push(parseMesh(m));
    nodes.push(n);
    for (const k of [0, 4, 0xc]) walk(u32(p + k), n);
  };
  walk(u32(0x18), null);
  return { name, nodes, bounds: { min: [f32(0x64), f32(0x68), f32(0x6c)], max: [f32(0x70), f32(0x74), f32(0x78)] } };
}

/** Flatten to world-space triangles (quads split). Child nodes repeat their parent's pivot (turret nodes), so only each node's own translation/scale is applied. */
export function hobTriangles(hob) {
  const tris = [];
  for (const n of hob.nodes) {
    const pt = v => v; // vertices are already model-space (node t is only the pivot)
    for (const m of n.meshes) for (const p of m.polys) {
      const v = p.idx.map(i => pt(m.verts[i])), nrm = p.nidx?.map(i => m.normals[i]);
      const c = p.colors.map(c => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255]);
      for (const t of p.idx.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]])
        tris.push({ v: t.map(i => v[i]), n: nrm && t.map(i => nrm[i]), color: t.map(i => c[i]), material: p.material });
    }
  }
  return tris;
}
