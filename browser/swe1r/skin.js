// Garage/race/flight skins from the user's own paired SWE1R Podd/MAlt models.
// No game assets are shipped, and the hosted build never lists these skins.
import { readBlock } from './block.js';
import { decodeTexture, buildPod } from './pod.js';
import { MODEL_NAMES } from './names.js';
import {assemblePod} from './assembly.js';
import {POD_POSES} from './poses.js';

export function podPair(index) {
  const name=MODEL_NAMES[index-NAME_DRIFT]?.replace(/^Part_Racer_Lod1_/,'');
  if (!MODEL_NAMES[index-NAME_DRIFT]?.startsWith('Part_Racer_Lod1_')) return null;
  const resolve=prefix=>{const i=MODEL_NAMES.indexOf(prefix+name);return i<0?-1:i+(i>=230?NAME_DRIFT:0);};
  const pod=resolve('Podd_'),alternate=resolve('MAlt_');
  return pod>=0&&alternate>=0?{pod,alternate}:null;
}

// Model units -> yards. Pods are ~4800 units long (~8 yd); the Rocket is ~5 yd wide.
export const POD_SCALE = 1 / 600;
// Model +y is forward: the engines lead and the pod trails behind them on cables (checked by eye in Edge).
export const FORWARD = 1;

const label = n => n.replace(/^Part_Racer_Lod1_/, '').replaceAll('_', ' ');

// The community name table lags the real model block by one from ~230 on.
// Early Podd/MAlt names are exact; only late names and Lod1 use this drift.
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
  const pair=podPair(skin.index),pose=POD_POSES[skin.index];
  if (!pair || !pose) throw new Error('no calibrated Podd/MAlt pair');
  const [mask,body]=models[pair.pod]??[],alternate=models[pair.alternate]?.[1];
  if (!body||!alternate) throw new Error('paired model unavailable');
  const texture = t => { try { return decodeTexture(textures[t.index], t); } catch { return null; } };
  const meshes=assemblePod(body,mask,alternate,pose);
  const pod=buildPod(body,mask,{texture,meshes});
  if (!pod.asset.indices.length || !pod.asset.vertices.every(Number.isFinite)) throw new Error('invalid paired geometry');
  toCraft(pod.asset,{lo:[0,0,pose.z]});
  const fans=(pose.fans??[]).map(p=>[...p]);
  for (const batch of pod.asset.batches.filter(b=>b.intake)) {
    let nearest=0;
    for (let i=1;i<fans.length;i++)
      if (Math.hypot(...fans[i].map((v,a)=>v-batch.intake[a]))<Math.hypot(...fans[nearest].map((v,a)=>v-batch.intake[a]))) nearest=i;
    const anchor=fans.splice(nearest,1)[0];
    if (!anchor || Math.hypot(...anchor.map((v,a)=>v-batch.intake[a]))>10) throw new Error('pod fan calibration mismatch');
    batch.intake=anchor;
  }
  if (fans.length) throw new Error('missing pod fan');
  return { asset: pod.asset, textures: pod.textures, flame: undefined, key: `swe1r:${skin.index}:paired`, assembly:'paired',
    metadata: { display: 0, scale: skin.scale, pose: 'swe1r', exhausts:pose.exhausts.map(p=>[...p]), posedAttachment0: { space: 'model-local', pose: 'stand-frame-0', position: [0, 0, pose.top] } } };
}

// Race scenery uses a Part lens, not a racer or a missing-pod fallback.
export async function loadPartModel(reader,index) {
  const {models,textures}=await load(reader);
  const [mask,body]=models[index]??[];
  if (podPair(index) || !body || String.fromCharCode(...body.subarray(0,4))!=='Part') throw new Error('model is not a scenery part');
  const pod=buildPod(body,mask,{texture:t=>{try{return decodeTexture(textures[t.index],t);}catch{return null;}}});
  if (!pod.asset.indices.length) throw new Error('empty scenery part');
  toCraft(pod.asset,pod.bounds);
  return {asset:pod.asset,textures:pod.textures};
}
