"""Tiny x87-folding pseudo-decompiler for the MSVC non-optimised code in Rogue Squadron.EXE (dump from dump-exe.py).

usage: python lift.py <mem.bin> <hexaddr> [maxbytes]
Prints one line per instruction; x87 expression trees are folded into `[dst] = expr` lines, float/double constants are
resolved from the image, calls/jumps are kept as-is. It is a reading aid, not a real decompiler.
"""
import struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32, x86_const as X

BASE = 0x400000


def mem_str(op, d):
    m = op.mem
    parts = []
    if m.base:
        parts.append(ins_reg(m.base))
    if m.index:
        parts.append(f'{ins_reg(m.index)}*{m.scale}' if m.scale != 1 else ins_reg(m.index))
    s = '+'.join(parts)
    if m.disp:
        if not parts:
            return f'[{m.disp & 0xffffffff:#x}]'
        s += f'{m.disp:+#x}' if m.disp > 0 else f'-{-m.disp:#x}'
    return f'[{s}]'


_md = Cs(CS_ARCH_X86, CS_MODE_32)


def ins_reg(r):
    return _md.reg_name(r)


def const(op, d, size):
    m = op.mem
    if not m.base and not m.index:
        a = (m.disp & 0xffffffff) - BASE
        if 0 <= a < len(d) - 8:
            try:
                v = struct.unpack_from('<f' if size == 4 else '<d', d, a)[0]
            except struct.error:
                return None
            return f'{v:.6g}'
    return None


def lift(d, va, maxb=0x1000, out=print):
    md = _md
    md.detail = True
    off = va - BASE
    st = []
    for ins in md.disasm(d[off:off + maxb], va):
        mn, ops = ins.mnemonic, ins.operands
        text = None
        def src(o, sz):
            if o.type == X.X86_OP_MEM:
                c = const(o, d, sz)
                return c if c is not None else f'{"f32" if sz == 4 else "f64"}{mem_str(o, d)}'
            return ins.op_str
        try:
            if mn in ('fld', 'fild') and ops and ops[0].type == X.X86_OP_MEM:
                sz = ops[0].size
                st.append((f'(float){mem_str(ops[0], d)}' if mn == 'fild' else src(ops[0], sz)))
            elif mn == 'fld1': st.append('1')
            elif mn == 'fldz': st.append('0')
            elif mn == 'fldpi': st.append('PI')
            elif mn == 'fld' and ops[0].type == X.X86_OP_REG: st.append(st[-1])
            elif mn in ('fmul', 'fadd', 'fsub', 'fsubr', 'fdiv', 'fdivr') and ops and ops[0].type == X.X86_OP_MEM:
                a, b = st[-1], src(ops[0], ops[0].size)
                sym = {'fmul': '*', 'fadd': '+', 'fsub': '-', 'fdiv': '/'}.get(mn)
                st[-1] = f'({a} {sym} {b})' if sym else (f'({b} - {a})' if mn == 'fsubr' else f'({b} / {a})')
            elif mn in ('fmulp', 'faddp', 'fsubp', 'fsubrp', 'fdivp', 'fdivrp', 'fmul', 'fadd', 'fsub', 'fdiv'):
                if len(st) >= 2:
                    b, a = st.pop(), st.pop() if mn.endswith('p') else st[-2]
                    if not mn.endswith('p'): st.pop(-1); st.pop() if False else None
                    sym = {'fmul': '*', 'fadd': '+', 'fsub': '-', 'fdiv': '/'}.get(mn.rstrip('p'))
                    st.append(f'({a} {sym} {b})' if sym else f'({b} {"-" if "sub" in mn else "/"} {a})')
            elif mn in ('fstp', 'fst') and ops and ops[0].type == X.X86_OP_MEM:
                text = f'    {mem_str(ops[0], d)} = {st[-1]};'
                if mn == 'fstp': st.pop()
            elif mn == 'fchs': st[-1] = f'-{st[-1]}'
            elif mn == 'fabs': st[-1] = f'abs({st[-1]})'
            elif mn == 'fsqrt': st[-1] = f'sqrt({st[-1]})'
            elif mn in ('fsin', 'fcos'): st[-1] = f'{mn[1:]}({st[-1]})'
            elif mn in ('fcomp', 'fcom', 'fcompp', 'fucompp', 'fnstsw', 'fstsw', 'fxch', 'fnstcw', 'fldcw', 'fistp'):
                text = f'    ; {mn} {ins.op_str}   st={st[-2:]}'
        except Exception as e:  # keep going on odd stack states
            text = f'    ; lift-error {mn} {ins.op_str}: {e}'
        out(f'{ins.address:08x}  {mn:7} {ins.op_str}' + (f'\n{text}' if text else ''))
        if mn == 'ret' and ins.address > va:
            break


if __name__ == '__main__':
    d = open(sys.argv[1], 'rb').read()
    lift(d, int(sys.argv[2], 16), int(sys.argv[3], 16) if len(sys.argv) > 3 else 0x1000)
