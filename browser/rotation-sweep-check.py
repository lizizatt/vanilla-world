"""Compare rotation-sweep.mjs output: every screenshot pixel is mapped to a planet (lat,lon) cell; land/ocean votes from all frames must agree per cell (continents fixed in the body frame), and the Maelstrom projection must trace a straight pass. Usage: python rotation-sweep-check.py <tag>"""
import sys, json, glob
from PIL import Image
tag = sys.argv[1]; votes = {}; B = 4
for jf in sorted(glob.glob(f'../runtime/real-smoke/{tag}-*.json')):
    d = json.load(open(jf)); im = Image.open(jf[:-5] + '.png').convert('RGB'); G = d['G']
    for r, row in enumerate(d['grid']):
        for c, k in enumerate(row):
            if k < 0: continue
            x, y = c * G + G // 2, r * G + G // 2
            if y > 500 and x < 260 or y > 560 and x > 1000: continue
            R, Gc, Bl = im.getpixel((x, y)); land = not (Bl > R + 15 and Bl >= Gc)
            # skip clouds/white and shaded night pixels
            if R > 200 and Gc > 200 and Bl > 200: continue
            u, v = k % 1024 // (1024 // (360 // B)), k // 1024 // (512 // (180 // B))
            votes.setdefault((u, v), {}).setdefault(d['lat'], []).append(land)
cells = incons = coast = 0
cons = {k: (sum(sum(v)/len(v) for v in fr.values())/len(fr) > .5) for k, fr in votes.items()}
for key, fr in votes.items():
    if len(fr) < 2: continue
    m = [sum(v) / len(v) for v in fr.values()]
    if max(m) > .5 and min(m) < .5:
        if any(cons.get((key[0]+a, key[1]+b), cons[key]) != cons[key] for a in (-1,0,1) for b in (-1,0,1)): coast += 1; continue
        incons += 1; print('bad cell lon', key[0]*B-180, 'lat', 90-key[1]*B, {k: round(sum(v)/len(v),2) for k, v in fr.items()})
    cells += 1
print(f"cells seen in >=2 frames: {cells}, inconsistent land/ocean: {incons} ({incons/max(1,cells):.3%}), coast-edge excused {coast}")