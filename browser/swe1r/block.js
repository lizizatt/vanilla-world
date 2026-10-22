// Clean-room reader for the SWE1R retail PC "out_*block.bin" containers (all big-endian):
// u32 count, then count*partsPerItem u32 part offsets, then a u32 end-of-data terminator.
// A part's size is the next nonzero offset minus its own; offset 0 means an empty part.
// Format knowledge from public docs (OpenSWE1R/swe1r-re, akopetsch/swe1r-assets, MIT); no code copied.

export const PARTS = { model: 2, texture: 2, sprite: 1, spline: 1 };

export function readBlock(bytes, kind) {
  const per = PARTS[kind];
  if (!per) throw new Error(`unknown block kind ${kind}`);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 8) throw new Error('block too small');
  const count = dv.getUint32(0, false);
  const slots = count * per;
  if (4 + 4 * (slots + 1) > u8.length) throw new Error('block header exceeds file');
  const offs = [];
  for (let i = 0; i <= slots; i++) offs.push(dv.getUint32(4 + 4 * i, false));
  const end = offs[slots] || u8.length;
  if (end > u8.length) throw new Error('block terminator beyond file');
  const items = [];
  for (let i = 0; i < count; i++) {
    const parts = [];
    for (let p = 0; p < per; p++) {
      const o = offs[i * per + p];
      let e = 0;
      if (o) {
        for (let j = i * per + p + 1; j <= slots; j++) if (offs[j]) { e = offs[j]; break; }
        if (!e || e > end) e = end;
        if (e < o) throw new Error(`item ${i} part ${p} has a negative size`);
      }
      parts.push(o ? u8.subarray(o, e) : new Uint8Array(0));
    }
    items.push(parts);
  }
  return items;
}
