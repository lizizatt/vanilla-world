"""Dump the unpacked in-memory image of Rogue Squadron.EXE (Steam-stub wrapped; .text is encrypted on disk).

usage: python dump-exe.py <game dir> <out.bin> [wait seconds]
Runs 'Rogue Squadron.EXE' from the ORIGINAL Steam install with SteamAppId=455910 (a copy exits with code 53 because
the Steam stub relaunches the launcher). Side effect: the game writes ROGUE\\PlayerProfiles\\highscores.dat there.
Waits for the stub to decrypt, reads the whole image with ReadProcessMemory, then kills the process. Output is derived from copyrighted code: keep it under browser/rogue-data (git-ignored).
"""
import ctypes, ctypes.wintypes as w, os, struct, subprocess, sys, time

game, out = sys.argv[1], sys.argv[2]
wait = float(sys.argv[3]) if len(sys.argv) > 3 else 8
exe = os.path.join(game, 'Rogue Squadron.EXE')
base = 0x400000
with open(exe, 'rb') as f:
    d = f.read(0x1000)
pe = struct.unpack_from('<I', d, 0x3c)[0]
size = struct.unpack_from('<I', d, pe + 24 + 56)[0]

p = subprocess.Popen([exe], cwd=game)
time.sleep(wait)
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.OpenProcess.restype = w.HANDLE
h = k.OpenProcess(0x1F0FFF, False, p.pid)
got = ctypes.c_size_t()
data = bytearray(size)
for off in range(0, size, 0x1000):
    chunk = (ctypes.c_char * 0x1000)()
    if k.ReadProcessMemory(h, ctypes.c_void_p(base + off), chunk, 0x1000, ctypes.byref(got)):
        data[off:off + got.value] = chunk.raw[:got.value]
open(out, 'wb').write(data)
p.kill()
print('dumped', size, 'bytes;', 'text nonzero' if any(data[0x1000:0x2000]) else 'text empty')
