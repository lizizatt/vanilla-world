// Clean-room decoder for the SWE1R "Comp" LZ77 stream (documented in OpenSWE1R/swe1r-re Decompressor.md).
// Layout: "Comp" + 4 more signature bytes, u32 BE decompressed size, then groups of
// [control byte][8 items]. Control bits are read LSB-first: 1 = literal byte, 0 = 2-byte back-reference
// (offset = (b0&15)<<8|b1 into a 0x1000 ring window, length = (b0>>4)+2); offset 0 ends the stream.
const WIN = 0x1000;

export function isComp(b) {
  return b.length >= 12 && b[0] === 0x43 && b[1] === 0x6f && b[2] === 0x6d && b[3] === 0x70;
}

export function decompress(src) {
  if (!isComp(src)) return src;
  const size = ((src[8] << 24) | (src[9] << 16) | (src[10] << 8) | src[11]) >>> 0;
  const out = new Uint8Array(size);
  const win = new Uint8Array(WIN);
  let wp = 1, ip = 12, op = 0;
  while (op < size && ip < src.length) {
    const ctrl = src[ip++];
    for (let bit = 0; bit < 8 && op < size; bit++) {
      if (ctrl & (1 << bit)) {
        if (ip >= src.length) throw new Error('Comp: truncated literal');
        const v = src[ip++];
        out[op++] = v; win[wp] = v; wp = (wp + 1) & (WIN - 1);
      } else {
        if (ip + 1 >= src.length) throw new Error('Comp: truncated token');
        const b0 = src[ip++], b1 = src[ip++];
        let off = ((b0 & 15) << 8) | b1;
        if (off === 0) return finish(out, op, size);
        let len = (b0 >> 4) + 2;
        while (len-- > 0 && op < size) {
          const v = win[off]; off = (off + 1) & (WIN - 1);
          out[op++] = v; win[wp] = v; wp = (wp + 1) & (WIN - 1);
        }
      }
    }
  }
  return finish(out, op, size);
}

function finish(out, op, size) {
  if (op !== size) throw new Error(`Comp: produced ${op} of ${size} bytes`);
  return out;
}
