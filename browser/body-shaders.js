// Per-body shader sets (design/elune.md step D1). Azeroth's set is byte-identical to the module-level constants in space.js,
// so the renderer's Azeroth output is unchanged; Elune gets the same shaders at its own radius and chart centre.
import {bendShaderFor,spaceShaderFor,patchShaderFor} from './space.js';
import {AZEROTH,ELUNE} from './bodies.js';

/** The body this page's chart renders: ?body=elune boots the moon, anything else Azeroth; setActiveBody switches it in-page (the renderer rebuilds its radius-baked pipelines via useBody). */
let current;
export const activeBody=()=>current??(typeof location!=='undefined'&&new URLSearchParams(location.search).get('body')==='elune'?ELUNE:AZEROTH);
export const setActiveBody=body=>{current=body;};
export const wgslNumber=x=>Number.isInteger(x)?x+'.0':String(x);

const cache=new Map();
export function shaderSetFor(body) {
  let set=cache.get(body.id);
  if(!set){
    set={bend:bendShaderFor(body.radius,body.centre),space:spaceShaderFor(body.radius),patch:patchShaderFor(body.radius)};
    cache.set(body.id,set);
  }
  return set;
}
