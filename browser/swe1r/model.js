// Clean-room SWE1R model reader (big-endian N64-style memory image; layouts per public docs and the MIT akopetsch/swe1r-assets metadata).
// Body: u32 tag, then node pointers until -1. Pointers are body offsets. Node: u32 flags, u32 f1, u32 f2, s16 f3, s16 light, u32 f5,
// u32 childCount, u32 childrenPtr, then type fields at 0x1c: MeshGroup (aabb 6f), Transformed (3x4 matrix), WithPivot (matrix + pivot 3f),
// Selector (s32 select), LodSelector (8 f dists, 3 u32). Mesh: material ptr, behaviour ptr, bounds, s16 faces, s16 prim, ptrs, s16 counts.
export const NODE = { MESH_GROUP: 0x3064, BASIC: 0x5064, SELECTOR: 0x5065, LOD: 0x5066, TRANSFORMED: 0xd064, PIVOT: 0xd065, COMPUTED: 0xd066 };
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

// Matrices are 12 floats, 3 rows of 4 (rotation/scale then translation column): p' = R*p + t.
export function mulMat(parent, local) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 4 + c] = parent[r * 4] * local[c] + parent[r * 4 + 1] * local[4 + c] + parent[r * 4 + 2] * local[8 + c];
    o[r * 4 + 3] = parent[r * 4] * local[3] + parent[r * 4 + 1] * local[7] + parent[r * 4 + 2] * local[11] + parent[r * 4 + 3];
  }
  return o;
}
export const applyMat = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
export function parseModel(body, mask) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const u32 = o => dv.getUint32(o), s16 = o => dv.getInt16(o), f32 = o => dv.getFloat32(o);
  const ok = o => o > 0 && o + 4 <= body.length;
  const tag = String.fromCharCode(...body.subarray(0, 4));
  const roots = [];
  for (let o = 4; o + 4 <= body.length; o += 4) {
    const v = u32(o);
    if (v === 0xffffffff) break;
    roots.push(v);
  }
  const meshes = [];
  const seen = new Set();
  // On disk: 3x3 rotation rows then translation (identity = 1,0,0, 0,1,0, 0,0,1, 0,0,0); converted to 3 rows of 4.
  const readMatrix = o => { const f = Array.from({ length: 12 }, (_, i) => f32(o + 4 * i)); return [f[0], f[1], f[2], f[9], f[3], f[4], f[5], f[10], f[6], f[7], f[8], f[11]]; };
  function mesh(o, m, path) {
    const matPtr = u32(o), cl = u32(o + 0x30), vt = u32(o + 0x34), nv = s16(o + 0x3a);
    if (!ok(cl) || !ok(vt) || nv < 1 || vt + nv * 16 > body.length) return;
    meshes.push({ off: o, matrix: m, path, matPtr, cl, vt, nv, prim: s16(o + 0x22) });
  }
  function walk(o, m, path) {
    if (!ok(o) || seen.has(o + ':' + path.length) || path.length > 24) return;
    seen.add(o + ':' + path.length);
    const flags = u32(o) & 0xffff, count = u32(o + 0x14), kids = u32(o + 0x18);
    let mat = m, take = count;
    if (flags === NODE.TRANSFORMED || flags === NODE.PIVOT) mat = mulMat(m, readMatrix(o + 0x1c));
    else if (flags === NODE.LOD) take = Math.min(count, 1);
    else if (flags === NODE.SELECTOR) { const sel = dv.getInt32(o + 0x1c); take = sel >= 0 ? sel + 1 : 1; } // unset (-1): the children are alternate detail levels of one body, first is the finest
    else if (flags !== NODE.MESH_GROUP && flags !== NODE.BASIC && flags !== NODE.COMPUTED) return;
    if (!ok(kids) && count) return;
    for (let i = 0; i < take && i < count; i++) {
      const c = u32(kids + 4 * i);
      if (flags === NODE.SELECTOR && i !== Math.max(0, dv.getInt32(o + 0x1c))) continue;
      if (flags === NODE.MESH_GROUP) mesh(c, mat, path.concat(i));
      else walk(c, mat, path.concat(i));
    }
  }
  if (roots.length) walk(roots[0], IDENT, [0]);
  return { tag, roots, meshes };
}
