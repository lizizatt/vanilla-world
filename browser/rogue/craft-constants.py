"""Extract the per-craft flight constants from the dumped Rogue Squadron image.

Every craft_*.c init function stores its tunables as immediates into the player struct (stride 0x2a0 @ 0x704d44)
and then calls 0x419f00(speed limits...). This scans for those functions (anything that calls 0x413601 and stores 0xe8..0x174 fields).
usage: python craft-constants.py <mem.bin>   -> prints one block per craft init
"""
import re, struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

BASE = 0x400000
FIELDS = {0xc0: 'hull?', 0xc4: 'hull_max?', 0xe8: 'speed', 0xec: 'speed_target', 0xf0: 'accel', 0xf4: 'decel', 0xf8: 'pitch_rate', 0xfc: 'roll_rate',
          0x100: 'f100', 0x104: 'f104', 0x108: 'f108', 0x10c: 'f10c', 0x110: 'f110', 0x114: 'f114', 0x118: 'f118', 0x11c: 'f11c', 0x120: 'f120', 0x124: 'f124',
          0x128: 'deadzone_x', 0x12c: 'deadzone_y', 0x130: 'f130', 0x134: 'f134', 0x138: 'f138', 0x13c: 'f13c', 0x140: 'f140', 0x144: 'f144', 0x148: 'f148', 0x14c: 'f14c',
          0x150: 'f150', 0x154: 'f154', 0x164: 'f164', 0x168: 'f168', 0x174: 'f174'}


def fl(v):
    f = struct.unpack('<f', struct.pack('<I', v))[0]
    return f if v == 0 or 1e-6 < abs(f) < 1e7 else v


def main(d):
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    text = d[0x1000:0x1bf000]
    starts = [0x401000 + m.start() for m in re.finditer(rb'\x55\x8b\xec', text)]
    for i, f in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else f + 0x1000
        if end - f > 0x2000 or not (0x40b000 <= f < 0x440000):
            continue
        code = d[f - BASE:end - BASE]
        if b'\x01\x36\x41\x00' not in code and b'\x68' not in code:  # cheap pre-filter: calls 0x413601 or anything
            pass
        rel = struct.pack('<i', 0x413601 - 0)  # call targets resolved below
        stores, pushes, calls = {}, [], []
        for ins in md.disasm(code, f):
            if ins.mnemonic == 'mov' and len(ins.operands) == 2 and ins.operands[1].type == 2 and ins.operands[0].type == 3:
                m = ins.operands[0].mem
                if ins.operands[0].size == 4 and 0xc0 <= m.disp <= 0x180 and m.base:
                    stores[m.disp] = ins.operands[1].imm & 0xffffffff
            elif ins.mnemonic == 'push' and ins.operands[0].type == 2:
                pushes.append(ins.operands[0].imm & 0xffffffff)
            elif ins.mnemonic == 'call':
                calls.append(ins.op_str)
                if ins.op_str.lower() == '0x419f00':
                    last6 = [fl(v) for v in pushes[-6:]]
                    stores['limits'] = last6
                pushes = []
        if 0xe8 in stores and 0xf0 in stores:
            print(f'--- init @ {f:#x}')
            for k in sorted(k for k in stores if isinstance(k, int)):
                print(f'   +{k:#05x} {FIELDS.get(k, ""):12} {fl(stores[k])}')
            if 'limits' in stores:
                print('   419f00 args (pushed order, last first):', stores['limits'])


if __name__ == '__main__':
    main(open(sys.argv[1], 'rb').read())
