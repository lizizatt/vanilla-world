import json, glob
from PIL import Image
for jf in sorted(glob.glob('../runtime/real-smoke/rp-*.json')):
    d = json.load(open(jf)); s = d['storm']
    if not s['front'] or not (60 < s['x'] < 1220 and 60 < s['y'] < 660): print(d['lat'], 'storm not on screen', round(s['x']), round(s['y']), s['front']); continue
    im = Image.open(jf[:-5] + '.png').convert('RGB')
    def wf(x0, y0, h):
        n = w = 0
        for y in range(max(0, int(y0)-h), min(720, int(y0)+h), 4):
            for x in range(max(0, int(x0)-h), min(1280, int(x0)+h), 4):
                r, g, b = im.getpixel((x, y)); n += 1; w += (r > 170 and g > 170 and b > 170)
        return w / max(1, n)
    print(d['lat'], 'storm', round(s['x']), round(s['y']), 'white near', round(wf(s['x'], s['y'], 50), 2), 'ring', round(wf(s['x'], s['y'], 150), 2), 'frame', round(wf(640, 360, 300), 2))