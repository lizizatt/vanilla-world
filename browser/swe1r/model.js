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
export function modelHeader(body) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength), roots = [], alt = [];
  let o = 4;
  const word = () => { if (o + 4 > body.length) throw new Error('truncated model header'); const v = dv.getUint32(o); o += 4; return v; };
  while (true) { const v = word(); if (v === 0xffffffff) break; roots.push(v); }
  while (true) {
    const tag = word();
    if (tag === 0x48456e64) break;
    if (tag === 0x44617461) { const size = word(); o += size * 4; }
    else if (tag === 0x416e696d || tag === 0x416c744e) {
      while (true) { const v = word(); if (!v) break; if (tag === 0x416c744e) alt.push(v); }
    } else throw new Error('unknown model header section');
  }
  return { roots, alt };
}

export function parseModel(body, mask, opts = {}) {
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
  const active = new Set();
  const replacements = new Map();
  if (opts.alternate) {
    const main = modelHeader(body), alternate = modelHeader(opts.alternate);
    if (tag !== 'Podd' || String.fromCharCode(...opts.alternate.subarray(0, 4)) !== 'MAlt' || main.alt.length !== alternate.alt.length) throw new Error('invalid Podd/MAlt pair');
    main.alt.forEach((slot, i) => {
      if (!ok(slot) || slot % 4 || alternate.alt[i] + 0x1c > opts.alternate.length) throw new Error('invalid AltN reference');
      replacements.set(slot, alternate.alt[i]);
    });
  }
  // On disk: 3x3 rotation rows then translation (identity = 1,0,0, 0,1,0, 0,0,1, 0,0,0); converted to 3 rows of 4.
  const readMatrix = o => { const f = Array.from({ length: 12 }, (_, i) => f32(o + 4 * i)); return [f[0], f[1], f[2], f[9], f[3], f[4], f[5], f[10], f[6], f[7], f[8], f[11]]; };
  function mesh(o, m, path, chain) {
    if (!ok(o) || o + 0x3c > body.length) return;
    const matPtr = u32(o), cl = u32(o + 0x30), vt = u32(o + 0x34), nv = s16(o + 0x3a);
    if (!ok(cl) || !ok(vt) || nv < 1 || vt + nv * 16 > body.length) return;
    meshes.push({ off: o, matrix: m, path, chain, matPtr, cl, vt, nv, prim: s16(o + 0x22), body });
  }
  function walk(o, m, path, chain = []) {
    if (!ok(o) || o + 0x1c > body.length || active.has(o) || path.length > 48) return;
    const flags = u32(o) & 0xffff, count = u32(o + 0x14), kids = u32(o + 0x18);
    if (opts.visibleOnly && !(u32(o + 4) & 2)) return;
    let mat = m, take = count;
    const here = flags === NODE.TRANSFORMED || flags === NODE.PIVOT ? chain.concat({ type: flags, flags: s16(o + 0xc), header: tag === 'MAlt' && o !== opts.root && roots.includes(o), local: readMatrix(o + 0x1c) }) : chain;
    if (flags === NODE.TRANSFORMED || flags === NODE.PIVOT) {
      const local = readMatrix(o + 0x1c);
      if (flags === NODE.PIVOT && (s16(o + 0xc) & 0x10)) {
        const pivot = [f32(o + 0x4c), f32(o + 0x50), f32(o + 0x54)];
        const rotated = applyMat(local, ...pivot);
        for (let a = 0; a < 3; a++) local[a * 4 + 3] += pivot[a] - (rotated[a] - local[a * 4 + 3]);
      }
      mat = mulMat(m, local);
    }
    else if (flags === NODE.LOD) take = opts.finest ? count : Math.min(count, 1);
    else if (flags === NODE.SELECTOR) { const sel = opts.finest ? 0 : dv.getInt32(o + 0x1c); take = sel >= 0 ? sel + 1 : 1; }
    else if (flags !== NODE.MESH_GROUP && flags !== NODE.BASIC && flags !== NODE.COMPUTED) return;
    if (count && (!ok(kids) || kids + count * 4 > body.length)) throw new Error('invalid model children');
    active.add(o);
    for (let i = 0; i < take && i < count; i++) {
      const before = meshes.length;
      const c = u32(kids + 4 * i);
      if (flags === NODE.SELECTOR && i !== (opts.finest ? 0 : Math.max(0, dv.getInt32(o + 0x1c)))) continue;
      if (flags === NODE.MESH_GROUP) mesh(c, mat, path.concat(i), here);
      else if (replacements.has(kids + 4 * i)) {
        const sub = parseModel(opts.alternate, null, { root: replacements.get(kids + 4 * i), finest: true, visibleOnly: opts.visibleOnly });
        for (const mesh of sub.meshes) meshes.push({ ...mesh, matrix: mulMat(mat, mesh.matrix), path: path.concat(i, ...mesh.path), chain: here.concat(mesh.chain) });
      }
      else walk(c, mat, path.concat(i), here);
      // The first cockpit slot can contain only the pilot's empty skeleton.
      if (flags === NODE.LOD && opts.finest && meshes.length > before) break;
    }
    active.delete(o);
  }
  if (roots.length) walk(opts.root ?? roots[0], IDENT, [0]);
  return { tag, roots, meshes };
}
