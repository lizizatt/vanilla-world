// Pixel decoding for SWE1R N64-derived images (formats per OpenSWE1R/swe1r-re Sprites.md / akopetsch/swe1r-assets, MIT).
// Output is always RGBA8 (Uint8Array, w*h*4).
export const FMT = { RGBA32: 0x0003, GA4: 0x0400, G8: 0x0401, CI4: 0x0200, CI8: 0x0201 };

export function rgba5551(hi, lo) {
  const v = (hi << 8) | lo;
  const e = c => (c << 3) | (c >> 2);
  return [e((v >> 11) & 31), e((v >> 6) & 31), e((v >> 1) & 31), v & 1 ? 255 : 0];
}

export function readPalette(bytes, off, count) {
  const pal = [];
  for (let i = 0; i < count && off + 2 * i + 1 < bytes.length; i++) pal.push(rgba5551(bytes[off + 2 * i], bytes[off + 2 * i + 1]));
  return pal;
}

const nib = (b, i) => (i & 1 ? b[i >> 1] & 15 : b[i >> 1] >> 4);

// `stride` is the row width in pixels in the source data (>= w).
export function decodePixels(fmt, px, w, h, palette, stride = w) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x, o = (y * w + x) * 4;
      let c;
      if (fmt === FMT.CI4) c = palette[nib(px, i)] ?? [255, 0, 255, 255];
      else if (fmt === FMT.CI8) c = palette[px[i]] ?? [255, 0, 255, 255];
      else if (fmt === FMT.GA4) { const v = nib(px, i) * 17; c = [v, v, v, v]; }
      else if (fmt === FMT.G8) { const v = px[i]; c = [v, v, v, v]; }
      else if (fmt === FMT.RGBA32) c = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]];
      else throw new Error(`unknown texture format 0x${fmt.toString(16)}`);
      if (c === undefined || i >= px.length * (fmt === FMT.CI4 || fmt === FMT.GA4 ? 2 : 1)) c = [255, 0, 255, 255];
      out.set(c, o);
    }
  }
  return out;
}

const MAX_TW = 64, MAX_TH = 32;

// Sprite item: u16 w, u16 h, u16 fmt, u16 -, u32 paletteOff, u16 tileCount, u16 -, u32 tilesOff;
// tile table entries are u16 w, u16 h, u32 pixelsOff; tiles lay out on a 64x32 grid, row-major.
export function decodeSprite(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = dv.getUint16(0), h = dv.getUint16(2), fmt = dv.getUint16(4);
  const palOff = dv.getUint32(8), n = dv.getUint16(12), tilesOff = dv.getUint32(16);
  const four = fmt === FMT.CI4 || fmt === FMT.GA4;
  const palette = fmt === FMT.CI4 ? readPalette(bytes, palOff, 16) : fmt === FMT.CI8 ? readPalette(bytes, palOff, 256) : null;
  const gw = Math.ceil(w / MAX_TW);
  const out = new Uint8Array(w * h * 4);
  const tiles = [];
  for (let t = 0; t < n; t++) tiles.push({ w: dv.getUint16(tilesOff + 8 * t), h: dv.getUint16(tilesOff + 8 * t + 2), off: dv.getUint32(tilesOff + 8 * t + 4) });
  for (let t = 0; t < n; t++) {
    const { w: tw, h: th, off } = tiles[t];
    const end = t + 1 < n ? tiles[t + 1].off : bytes.length;
    const pad = four ? 16 : fmt === FMT.RGBA32 ? 2 : 8; // N64 rows are 8-byte aligned
    const rgba = decodePixels(fmt, bytes.subarray(off, end), tw, th, palette, Math.ceil(tw / pad) * pad);
    const ox = (t % gw) * MAX_TW, oy = Math.floor(t / gw) * MAX_TH;
    for (let y = 0; y < th && oy + y < h; y++) for (let x = 0; x < tw && ox + x < w; x++) {
      out.set(rgba.subarray(((th - 1 - y) * tw + x) * 4, ((th - 1 - y) * tw + x) * 4 + 4), ((oy + y) * w + ox + x) * 4);
    }
  }
  return { w, h, fmt, tiles: n, rgba: out, four };
}
