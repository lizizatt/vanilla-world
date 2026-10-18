"""Developer-only read-only sector census, not the browser runtime.

Maps each archive read-only without copying its contents; retains only its block
table. Examines every compressed sector's actual method byte, but does not prove
every payload decompresses. asset-smoke.mjs supplies native/browser byte parity.
"""
import argparse
import collections
import json
import mmap
import os
import struct
import sys

table = [0] * 1280
seed = 0x100001
for i in range(256):
    for j in range(5):
        seed = (seed * 125 + 3) % 0x2AAAAB
        high = (seed & 65535) << 16
        seed = (seed * 125 + 3) % 0x2AAAAB
        table[i + j * 256] = high | (seed & 65535)


def decrypt(data, key):
    out = []
    seed = 0xEEEEEEEE
    for value, in struct.iter_unpack("<I", data):
        seed = (seed + table[0x400 + (key & 255)]) & 0xFFFFFFFF
        plain = value ^ ((key + seed) & 0xFFFFFFFF)
        out.append(plain)
        key = (((~key << 21) + 0x11111111) | (key >> 11)) & 0xFFFFFFFF
        seed = (plain + seed + (seed << 5) + 3) & 0xFFFFFFFF
    return out


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("data", help="Player-owned WoW 1.12 Data directory (read-only)")
args = parser.parse_args()
names = sorted(os.listdir(args.data))
base = ["dbc", "speech", "fonts", "interface", "misc", "sound", "wmo", "terrain", "texture", "model", "patch"]
order = [next((name for name in names if name.lower() == item + ".mpq"), None) for item in base]
order += sorted((name for name in names if name.lower().startswith("patch-")
                 and name.lower().endswith(".mpq") and len(name) == 11), key=str.lower)
order += [next((name for name in names if name.lower() == "speech2.mpq"), None)]
total = collections.Counter()
for name in filter(None, order):
    counts = collections.Counter()
    flags_seen = collections.Counter()
    with open(os.path.join(args.data, name), "rb") as file:
        with mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ) as data:
            signature, header_size, archive_size, version, shift, hp, bp, hc, bc = struct.unpack_from("<IIIHHIIII", data)
            assert signature == 0x1A51504D and version in (0, 1)
            if version == 1:
                high_blocks, hash_high, block_high = struct.unpack_from("<QHH", data, 32)
                assert high_blocks == 0
                bp += block_high << 32
            blocks = decrypt(data[bp:bp + bc * 16], 0xEC83B3A3)
            sector_size = 512 << shift
            for i in range(bc):
                pos, packed, size, flags = blocks[i * 4:i * 4 + 4]
                flags_seen[hex(flags)] += 1
                counts["blocks"] += 1
                if not flags & 0x80000000 or flags & 0x02000000 or size == 0:
                    counts["empty_deleted_or_unused"] += 1
                    continue
                assert pos + packed <= len(data)
                if flags & 0x00010000:
                    counts["encrypted_uninspected"] += 1
                    continue
                if flags & 0x100:
                    counts["implode_blocks"] += 1
                if not flags & 0x300:
                    counts["stored_blocks"] += 1
                    continue
                if flags & 0x01000000:
                    counts["single_unit_blocks"] += 1
                    sectors = [(0, packed, size)]
                else:
                    sector_count = (size + sector_size - 1) // sector_size
                    offsets = struct.unpack_from("<" + "I" * (sector_count + 1), data, pos)
                    sectors = ((offsets[j], offsets[j + 1], min(sector_size, size - j * sector_size))
                               for j in range(sector_count))
                for start, end, want in sectors:
                    assert 0 <= start < end <= packed
                    if end - start >= want:
                        counts["stored_sectors"] += 1
                    else:
                        codec = data[pos + start] if flags & 0x200 else 8
                        counts["codec_" + hex(codec)] += 1
    total.update(counts)
    print(json.dumps({"archive": name, "flags": dict(flags_seen), "counts": dict(counts)}), flush=True)
print(json.dumps({"total": dict(total)}), flush=True)
if not total["blocks"] or total["encrypted_uninspected"] or any(
        key.startswith("codec_") and key != "codec_0x2" for key in total):
    sys.exit("Census incomplete or contains unsupported codecs; inspect the reported counts")
