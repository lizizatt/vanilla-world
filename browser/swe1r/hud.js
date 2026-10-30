// Optional HUD dial built from SWE1R sprites 28 (ring half) and 29 (filled face half); each is the LEFT half of a
// 64 px circle, mirrored here for the right half. Sprite names drift in the community lists, so dimensions are checked.
import { readBlock } from './block.js';
import { decodeSprite } from './image.js';

const RING = 28, FACE = 29, HEAT_RING = 32, HEAT_FACE = 30, COUNTDOWN = { 1: 19, 2: 20, 3: 21 };
// Real in-race pieces (block index = community swrSprite id): engdisp3 panel, dial_speed_wire capsule, dial_meter_only D, dial_gradient arc, lightflash lamp.
const REAL = { panel: [49, 27, 62], capsule: [104, 71, 59], meter: [166, 40, 58], grad: [99, 36, 51], lamp: [101, 30, 30] };

export async function loadHudSprites(reader) {
  const items = readBlock(await reader.read('out_spriteblock.bin'), 'sprite');
  const [ring, face] = [RING, FACE].map(i => items[i] && decodeSprite(items[i][0]));
  if (!(ring?.w === 64 && ring.h === 64 && face?.w === 64 && face.h === 64)) return null;
  const [heatRing, heatFace] = [HEAT_RING, HEAT_FACE].map(i => items[i] && decodeSprite(items[i][0]));
  const heat = heatRing?.w === 64 && heatRing.h === 64 && heatFace?.w === 64 && heatFace.h === 64 ? { ring: heatRing, face: heatFace } : null;
    const real = {};
  for (const [k, [i, w, h]] of Object.entries(REAL)) { const s = items[i] && decodeSprite(items[i][0]); if (s?.w !== w || s.h !== h) { real.ok = false; break; } real[k] = s; }
  return { ring, face, heat, real: real.ok === false ? null : real };
}

// Race countdown digits (sprites 19-21, 64x64). Returns { 1: canvas, 2: canvas, 3: canvas } or null if the sprites don't match.
export async function loadCountdownSprites(reader) {
  const items = readBlock(await reader.read('out_spriteblock.bin'), 'sprite');
  const out = {};
  for (const [n, i] of Object.entries(COUNTDOWN)) {
    const s = items[i] && decodeSprite(items[i][0]);
    if (s?.w !== 64 || s.h !== 64) return null;
    out[n] = bitmap(s);
  }
  return out;
}

// Persistent in-race lap readout; the lap number never exceeds the total.
export const lapText = (lap, laps) => `Lap ${Math.min(Math.max(1, lap), laps)}/${laps}`;

// Top-banner LAP cell: current/total, never above the total (one-lap and point-to-point races read 1/1).
export const lapCount = (lap, laps) => { const n = Math.max(1, Math.floor(laps) || 1); return `${Math.min(Math.max(1, lap), n)}/${n}`; };

// Last and best completed lap, only meaningful for multi-lap races.
export const lapTimesText = (times, fmt) => times.length ? `Last ${fmt(times.at(-1))}  Best lap ${fmt(Math.min(...times))}` : '';

// Banner for a lap just started: LAP RECORD when it beat every earlier lap, FINAL LAP on the last one.
export function lapBanner(lap, laps, times) {
  const record = times.length > 1 && times.at(-1) < Math.min(...times.slice(0, -1));
  return [record && 'LAP RECORD', lap === laps ? 'FINAL LAP' : !record && `LAP ${lap}`].filter(Boolean).join(' - ');
}
export const finishBanner = beatBest => beatBest ? 'NEW BEST TIME' : 'FINISH';

// 270 degree sweep from lower-left (225 deg, canvas clockwise) around the top to lower-right.
export const needleAngle = f => (0.75 + 1.5 * Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0))) * Math.PI;

// Resample to tw x th for a device-pixel 1:1 draw. Colour is alpha-weighted (premultiplied) so transparent texels never bleed their
// colour into edges; 1-bit cutout alpha is re-thresholded on the interpolated field, giving a ~1 px anti-aliased edge instead of stairs.
export function resample(sprite, tw, th) {
  tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
  const { w, h, rgba: src } = sprite, out = new Uint8ClampedArray(tw * th * 4), sx = w / tw, sy = h / th;
  let binary = true; for (let i = 3; i < src.length; i += 4) if (src[i] && src[i] !== 255) { binary = false; break; }
  const soft = new Float32Array(w * h); for (let i = 0; i < w * h; i++) soft[i] = src[i * 4 + 3];
  if (binary) for (let pass = 0; pass < 2; pass++) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const prev = soft.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) soft[y * w + x] = (prev[y * w + x] * 2 + prev[y * w + Math.max(0, x - dx) + (Math.max(0, y - dy) - y) * w] + prev[Math.min(w - 1, x + dx) + Math.min(h - 1, y + dy) * w]) / 4;
  }
  // Edge bleed: transparent texels within the alpha blur radius take a neighbour's colour so soft edge pixels never read as black.
  const col = new Uint8ClampedArray(src), has = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) has[i] = src[i * 4 + 3] ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const was = has.slice(), prev = col.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!was[y * w + x]) {
      let c = 0, r = 0, g = 0, b = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const nx = x + i, ny = y + j; if (nx >= 0 && ny >= 0 && nx < w && ny < h && was[ny * w + nx]) { const o = (ny * w + nx) * 4; r += prev[o]; g += prev[o + 1]; b += prev[o + 2]; c++; } }
      if (c) { const o = (y * w + x) * 4; col[o] = r / c; col[o + 1] = g / c; col[o + 2] = b / c; has[y * w + x] = 1; }
    }
  }
  const n = Math.max(1, Math.ceil(Math.max(sx, sy))), gain = Math.max(1, .5 / Math.max(sx, sy));
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let r = 0, g = 0, b = 0, a = 0, ca = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const fx = (x + (i + .5) / n) * sx - .5, fy = (y + (j + .5) / n) * sy - .5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      for (let q = 0; q < 4; q++) {
        const px = Math.min(w - 1, Math.max(0, x0 + (q & 1))), py = Math.min(h - 1, Math.max(0, y0 + (q >> 1))), o = (py * w + px) * 4;
        const wt = ((q & 1) ? tx : 1 - tx) * ((q >> 1) ? ty : 1 - ty), wa = wt * (src[o + 3] || has[py * w + px] * .001);
        r += wa * col[o]; g += wa * col[o + 1]; b += wa * col[o + 2]; ca += wa; a += wt * soft[py * w + px];
      }
    }
    const o = (y * tw + x) * 4, tot = n * n;
    if (ca > 0) { out[o] = r / ca; out[o + 1] = g / ca; out[o + 2] = b / ca; }
    a /= tot * 255;
    out[o + 3] = 255 * (binary ? Math.min(1, Math.max(0, (a - .5) * gain + .5)) : a);
  }
  return { w: tw, h: th, rgba: out };
}

function bitmap(sprite) {
  const c = document.createElement('canvas');
  c.width = sprite.w; c.height = sprite.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sprite.rgba), sprite.w, sprite.h), 0, 0);
  return c;
}

// Left half sprite drawn as the left half of the circle, or mirrored as the right half.
function half(ctx, S, img, flip) { ctx.save(); if (flip) { ctx.translate(S, 0); ctx.scale(-1, 1); } ctx.drawImage(img, 0, 0, img.width / 2, img.height, 0, 0, S / 2, S); ctx.restore(); }

// Cool teal -> amber -> red as engine heat (0..1) rises.
export const heatColor = heat => { const h = Math.min(1, Math.max(0, Number.isFinite(heat) ? heat : 0)); return `hsl(${Math.round(170 - 170 * h)} 90% 55%)`; };

// Engine heat gauge from sprites 32 (ring) and 30 (face): face tinted by heat, needle sweeps like the speed dial, ring pulses red in the warning zone.
export function createHeatGauge(sprites, canvas) {
  const S = canvas.width, ring = bitmap(resample(sprites.ring, S, S)), face = bitmap(resample(sprites.face, S, S)), ctx = canvas.getContext('2d'), h = S / 2;
  return (heat, now = 0) => {
    ctx.clearRect(0, 0, S, S);
    ctx.globalAlpha = .6; half(ctx, S, face, false); half(ctx, S, face, true); ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = .55; ctx.fillStyle = heatColor(heat); ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    half(ctx, S, ring, false); half(ctx, S, ring, true);
    if (heat >= .8 && Math.floor(now * 4) % 2 === 0) { ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(h, h, h - 2, 0, 2 * Math.PI); ctx.stroke(); }
    const a = needleAngle(heat);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(h, h); ctx.lineTo(h + Math.cos(a) * h * .8, h + Math.sin(a) * h * .8); ctx.stroke();
  };
}

export function createDial(sprites, canvas) {
  const ring = bitmap(sprites.ring), face = bitmap(sprites.face), ctx = canvas.getContext('2d');
  const S = canvas.width, h = S / 2;
  return (speed01, heat01) => {
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = .55; half(ctx, S, face, false); half(ctx, S, face, true); ctx.globalAlpha = 1;
    half(ctx, S, ring, false); half(ctx, S, ring, true);
    const a = needleAngle(speed01);
    ctx.strokeStyle = '#ffb34d'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(h, h); ctx.lineTo(h + Math.cos(a) * h * .8, h + Math.sin(a) * h * .8); ctx.stroke();
    ctx.fillStyle = heatColor(heat01); ctx.fillRect(S * .2, S - 8, S * .6 * Math.min(1, Math.max(0, heat01)), 5);
  };
}

// Red hit flash: a rising obstacle contact (or a wreck, via mem.at) starts a 0.45 s fade; strength follows impact speed.
export function hitFlash(mem,contact,speed,now,floor=30){
  if(contact===3&&!mem.was&&speed>=floor){mem.at=now;mem.strength=Math.min(1,speed/200);}
  mem.was=contact===3;
  return mem.at===undefined?0:Math.max(0,1-(now-mem.at)/.45)*(mem.strength??1);
}

// Boost speed-line overlay intensity 0..1: ramps up while boosting, fades when not.
export function boostFx(mem,boosting,dt){
  const target=boosting?1:0;
  mem.v=Math.max(0,Math.min(1,(mem.v??0)+Math.sign(target-(mem.v??0))*dt*5));
  return mem.v;
}

// Sprite tinted to one colour keeping its alpha/luma (the original pieces are grey-white outlines).
function tint(sprite, color) {
  const c = bitmap(sprite), x = c.getContext('2d');
  x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  return c;
}
export const engineColor = heat => heat >= .8 ? '#ff4a3a' : heat >= .5 ? '#ffd23a' : '#46e85a';

// Twin engine panels from sprite 49 (27x62) at 2x; outline and fill follow the heat stage, each engine takes the worse of shared heat and its own damage (1 - health).
export function createRealEngines(real, canvas) {
  const ctx = canvas.getContext('2d'), K = canvas.width / 67, w = Math.round(27 * K), h = Math.round(62 * K), gap = Math.round(13 * K), cache = {}, panel = bitmap(resample(real.panel, w, h));
  return (heat, now = 0, left = 1, right = 1) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.imageSmoothingEnabled = false;
    const y = canvas.height - h;
    for (let i = 0; i < 2; i++) {
      const x = i * (w + gap), lvl = Math.max(heat || 0, 1 - (i ? right : left) || 0), col = engineColor(lvl), o = cache[col] ??= tint(resample(real.panel, w, h), col), blink = lvl >= 1 && Math.floor(now * 4) % 2 === 0;
      ctx.globalAlpha = blink ? .9 : .32; ctx.fillStyle = col; ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
      ctx.globalAlpha = 1; ctx.drawImage(panel, x, y); ctx.globalAlpha = .5; ctx.drawImage(o, x, y); ctx.globalAlpha = 1;
    }
  };
}

// Dial from sprite 104 (71x59: speed capsule + D meter + lamp ring); heat fills the gradient arc (99, blue to red) bottom-up; lamp (101) green, red from 80%.
export function createRealDial(real, canvas) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, K = W / 71, cache = {};
  const R = (s, w, h) => resample(s, w * K, h * K), cap = tint(R(real.capsule, 71, 59), '#7fd8ff'), grad = bitmap(R(real.grad, 36, 51)), lampArt = R(real.lamp, 18, 18), ox = 0, oy = 0;
  return (_speed01, heat01, speed = '000', now = 0) => {
    const heat = Math.min(1, Math.max(0, Number.isFinite(heat01) ? heat01 : 0));
    ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = 'rgba(26,74,90,.8)'; ctx.beginPath(); ctx.ellipse(ox + 35 * K, oy + 36 * K, 33 * K, 20 * K, 0, 0, 2 * Math.PI); ctx.fill();
    ctx.drawImage(cap, ox, oy);
    const gh = 51 * K * heat; ctx.save(); ctx.beginPath(); ctx.rect(ox, oy + 56 * K - gh, W, gh); ctx.clip();
    ctx.drawImage(grad, Math.round(ox + 35 * K), Math.round(oy + 5 * K)); ctx.restore();
    const lamp = heat >= .8 ? '#ff3b30' : '#46e85a', l = cache[lamp] ??= tint(lampArt, lamp);
    if (heat < 1 || Math.floor(now * 4) % 2 === 0) ctx.drawImage(l, Math.round(ox + 28 * K), Math.round(oy + 3 * K));
    ctx.font = `italic 800 ${17.8 * K}px "Arial Black", Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.2 * K; ctx.strokeStyle = '#04202c'; ctx.fillStyle = '#d8f6ff';
    ctx.strokeText(speed, ox + 24 * K, oy + 38 * K); ctx.fillText(speed, ox + 24 * K, oy + 38 * K);
  };
}