// Optional HUD dial built from SWE1R sprites 28 (ring half) and 29 (filled face half); each is the LEFT half of a
// 64 px circle, mirrored here for the right half. Sprite names drift in the community lists, so dimensions are checked.
import { readBlock } from './block.js';
import { decodeSprite } from './image.js';

const RING = 28, FACE = 29, HEAT_RING = 32, HEAT_FACE = 30, COUNTDOWN = { 1: 19, 2: 20, 3: 21 };

export async function loadHudSprites(reader) {
  const items = readBlock(await reader.read('out_spriteblock.bin'), 'sprite');
  const [ring, face] = [RING, FACE].map(i => items[i] && decodeSprite(items[i][0]));
  if (!(ring?.w === 64 && ring.h === 64 && face?.w === 64 && face.h === 64)) return null;
  const [heatRing, heatFace] = [HEAT_RING, HEAT_FACE].map(i => items[i] && decodeSprite(items[i][0]));
  const heat = heatRing?.w === 64 && heatRing.h === 64 && heatFace?.w === 64 && heatFace.h === 64 ? { ring: heatRing, face: heatFace } : null;
  return { ring, face, heat };
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

function bitmap(sprite) {
  const c = document.createElement('canvas');
  c.width = sprite.w; c.height = sprite.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sprite.rgba), sprite.w, sprite.h), 0, 0);
  return c;
}

// Left half sprite drawn as the left half of the circle, or mirrored as the right half.
function half(ctx, S, img, flip) { ctx.save(); if (flip) { ctx.translate(S, 0); ctx.scale(-1, 1); } ctx.drawImage(img, 0, 0, 32, 64, 0, 0, S / 2, S); ctx.restore(); }

// Cool teal -> amber -> red as engine heat (0..1) rises.
export const heatColor = heat => { const h = Math.min(1, Math.max(0, Number.isFinite(heat) ? heat : 0)); return `hsl(${Math.round(170 - 170 * h)} 90% 55%)`; };

// Engine heat gauge from sprites 32 (ring) and 30 (face): face tinted by heat, needle sweeps like the speed dial, ring pulses red in the warning zone.
export function createHeatGauge(sprites, canvas) {
  const ring = bitmap(sprites.ring), face = bitmap(sprites.face), ctx = canvas.getContext('2d'), S = canvas.width, h = S / 2;
  return (heat, now = 0) => {
    ctx.clearRect(0, 0, S, S); ctx.imageSmoothingEnabled = false;
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
  return (speed01, boost01) => {
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = .55; half(ctx, S, face, false); half(ctx, S, face, true); ctx.globalAlpha = 1;
    half(ctx, S, ring, false); half(ctx, S, ring, true);
    const a = needleAngle(speed01);
    ctx.strokeStyle = '#ffb34d'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(h, h); ctx.lineTo(h + Math.cos(a) * h * .8, h + Math.sin(a) * h * .8); ctx.stroke();
    ctx.fillStyle = '#4ddbcc'; ctx.fillRect(S * .2, S - 8, S * .6 * Math.min(1, Math.max(0, boost01)), 5);
  };
}

// Red hit flash: a rising obstacle contact (or a wreck, via mem.at) starts a 0.45 s fade; strength follows impact speed.
export function hitFlash(mem,contact,speed,now,floor=30){
  if(contact===3&&!mem.was&&speed>=floor){mem.at=now;mem.strength=Math.min(1,speed/200);}
  mem.was=contact===3;
  return mem.at===undefined?0:Math.max(0,1-(now-mem.at)/.45)*(mem.strength??1);
}

// Boost speed-line overlay intensity 0..1: ramps up while boosting with reserve left, fades when not.
export function boostFx(mem,boosting,reserve,dt){
  const target=boosting&&reserve>0?1:0;
  mem.v=Math.max(0,Math.min(1,(mem.v??0)+Math.sign(target-(mem.v??0))*dt*5));
  return mem.v;
}
