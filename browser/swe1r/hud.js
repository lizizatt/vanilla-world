// Optional HUD dial built from SWE1R sprites 28 (ring half) and 29 (filled face half); each is the LEFT half of a
// 64 px circle, mirrored here for the right half. Sprite names drift in the community lists, so dimensions are checked.
import { readBlock } from './block.js';
import { decodeSprite } from './image.js';

const RING = 28, FACE = 29, COUNTDOWN = { 1: 19, 2: 20, 3: 21 };

export async function loadHudSprites(reader) {
  const items = readBlock(await reader.read('out_spriteblock.bin'), 'sprite');
  const [ring, face] = [RING, FACE].map(i => items[i] && decodeSprite(items[i][0]));
  return ring?.w === 64 && ring.h === 64 && face?.w === 64 && face.h === 64 ? { ring, face } : null;
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

// 270 degree sweep from lower-left (225 deg, canvas clockwise) around the top to lower-right.
export const needleAngle = f => (0.75 + 1.5 * Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0))) * Math.PI;

function bitmap(sprite) {
  const c = document.createElement('canvas');
  c.width = sprite.w; c.height = sprite.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sprite.rgba), sprite.w, sprite.h), 0, 0);
  return c;
}

export function createDial(sprites, canvas) {
  const ring = bitmap(sprites.ring), face = bitmap(sprites.face), ctx = canvas.getContext('2d');
  const S = canvas.width, h = S / 2;
  const half = (img, flip) => { ctx.save(); if (flip) { ctx.translate(S, 0); ctx.scale(-1, 1); } ctx.drawImage(img, 0, 0, 32, 64, 0, 0, h, S); ctx.restore(); };
  return (speed01, boost01) => {
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = .55; half(face, false); half(face, true); ctx.globalAlpha = 1;
    half(ring, false); half(ring, true);
    const a = needleAngle(speed01);
    ctx.strokeStyle = '#ffb34d'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(h, h); ctx.lineTo(h + Math.cos(a) * h * .8, h + Math.sin(a) * h * .8); ctx.stroke();
    ctx.fillStyle = '#4ddbcc'; ctx.fillRect(S * .2, S - 8, S * .6 * Math.min(1, Math.max(0, boost01)), 5);
  };
}
