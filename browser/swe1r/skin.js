// Garage skins from the user's own SWE1R install. Each racer's `Part_Racer_Lod1_*` model is the whole pod
// (cockpit pod + engines + cables, ~400 tris) in one scene graph, so no assembly is needed. Built at runtime
// from the user's folder only; nothing here is shipped, and the hosted build never lists these skins.
import { readBlock } from './block.js';
import { decodeTexture, buildPod } from './pod.js';
import { MODEL_NAMES } from './names.js';

// Model units -> yards. Pods are ~4800 units long (~8 yd); the Rocket is ~5 yd wide.
export const POD_SCALE = 1 / 600;
// Model +y is forward: the engines lead and the pod trails behind them on cables (checked by eye in Edge).
export const FORWARD = 1;

const label = n => n.replace(/^Part_Racer_Lod1_/, '').replaceAll('_', ' ');

// The community name table lags the real model block by one from ~230 on (Podd_Anakin's textures belong to the model after the one named Anakin; the model named Jinn Reeso is a Podd), so the id stays the name's index but the model is the next one.
// Every skin is still re-checked against its model tag when loaded.
export const NAME_DRIFT = 1;
export function podSkinList() {
  const out = [];
  MODEL_NAMES.forEach((n, i) => { if (n.startsWith('Part_Racer_Lod1_')) out.push({ id: `swe1r-${i}`, name: label(n), source: 'swe1r', index: i + NAME_DRIFT, scale: POD_SCALE }); });
  return out;
}

const blocks = new WeakMap();
async function load(reader) {
  if (!blocks.has(reader)) blocks.set(reader, (async () => ({
    models: readBlock(await reader.read('out_modelblock.bin'), 'model'),
    textures: readBlock(await reader.read('out_textureblock.bin'), 'texture'),
  }))());
  return blocks.get(reader);
}

// Model axes -> craft space (+x forward, +y left, +z up); x/y stay on the model origin (the pod) so the camera follows the pod; z = 0 is the lowest point.
export function toCraft(asset, bounds, fwd = FORWARD) {
  const v = asset.vertices, z0 = bounds.lo[2];
  for (let i = 0; i < v.length; i += 12) {
    const x = v[i], y = v[i + 1], z = v[i + 2] - z0, nx = v[i + 3], ny = v[i + 4];
    v[i] = fwd * y; v[i + 1] = -fwd * x; v[i + 2] = z;
    v[i + 3] = fwd * ny; v[i + 4] = -fwd * nx;
  }
  for(const batch of asset.batches)if(batch.intake){
    const [x,y,z]=batch.intake;
    batch.intake=[fwd*y,-fwd*x,z-z0];
  }
  return asset;
}

export async function loadPodModel(reader, skin) {
  const { models, textures } = await load(reader);
  const [mask, body] = models[skin.index] ?? [];
  if (!body || String.fromCharCode(...body.subarray(0, 4)) !== 'Part') throw new Error('model is not a racer pod in this install');
  const pod = buildPod(body, mask, { texture: t => { try { return decodeTexture(textures[t.index], t); } catch { return null; } } });
  if (!pod.asset.indices.length) throw new Error('pod model has no geometry');
  toCraft(pod.asset, pod.bounds);
  const top = pod.bounds.hi[2] - pod.bounds.lo[2];
  return { asset: pod.asset, textures: pod.textures, flame: undefined, key: `swe1r:${skin.index}`,
    metadata: { display: 0, scale: skin.scale, pose: 'swe1r', exhausts: [], posedAttachment0: { space: 'model-local', pose: 'stand-frame-0', position: [0, 0, top] } } };
}
