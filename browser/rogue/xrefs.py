"""Static helpers over a dumped Rogue Squadron image (see dump-exe.py). Everything it reads lives in browser/rogue-data (git-ignored).

usage:
  python xrefs.py <mem.bin> files              list source files referenced by assert strings with xref counts / code ranges
  python xrefs.py <mem.bin> disasm <hexaddr> [n]   disassemble n instructions at a VA (image base 0x400000)
  python xrefs.py <mem.bin> floats <hexaddr> <len> list float32 immediates / .rdata loads referenced by a code range
"""
import re, struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

BASE = 0x400000
TEXT = (0x401000, 0x5bf000)


def load(p):
    return open(p, 'rb').read()


def strings_with_paths(d):
    return {m.start() + BASE: m.group().decode() for m in re.finditer(rb'[A-Z]:[\x20-\x7e]*?\.(?:c|h|cpp)\x00', d)}


def code_xrefs(d, targets):
    lo, hi = TEXT[0] - BASE, TEXT[1] - BASE
    code = d[lo:hi]
    out = {t: [] for t in targets}
    for i in range(len(code) - 4):
        if code[i] in (0x68, 0xB8, 0xB9, 0xBA, 0xBB, 0xBE, 0xBF, 0xBD, 0xBC):
            v = struct.unpack_from('<I', code, i + 1)[0]
            if v in out:
                out[v].append(lo + i + BASE)
    return out


def function_starts(d):
    lo, hi = TEXT[0] - BASE, TEXT[1] - BASE
    code = d[lo:hi]
    return [lo + m.start() + BASE for m in re.finditer(rb'\x55\x8b\xec', code)]


def disasm(d, va, n=60):
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = False
    off = va - BASE
    for ins in list(md.disasm(d[off:off + n * 8], va))[:n]:
        print(f'{ins.address:08x}  {ins.mnemonic:6} {ins.op_str}')


if __name__ == '__main__':
    d = load(sys.argv[1])
    cmd = sys.argv[2]
    if cmd == 'files':
        paths = strings_with_paths(d)
        xr = code_xrefs(d, set(paths))
        fs = function_starts(d)
        import bisect
        for va, p in sorted(paths.items(), key=lambda kv: kv[1]):
            if xr[va]:
                funcs = sorted({fs[bisect.bisect(fs, x) - 1] for x in xr[va]})
                print(f'{p.split(chr(92))[-1]:22} refs={len(xr[va]):3} funcs={len(funcs):3} {hex(funcs[0])}..{hex(funcs[-1])}')
    elif cmd == 'disasm':
        disasm(d, int(sys.argv[3], 16), int(sys.argv[4]) if len(sys.argv) > 4 else 60)
