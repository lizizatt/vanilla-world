// Per-body shader sets (design/elune.md step D1). Azeroth's set is byte-identical to the module-level constants in space.js,
// so the renderer's Azeroth output is unchanged; Elune gets the same shaders at its own radius and chart centre.
import {bendShaderFor,spaceShaderFor,patchShaderFor} from './space.js';

const cache=new Map();
export function shaderSetFor(body) {
  let set=cache.get(body.id);
  if(!set){
    set={bend:bendShaderFor(body.radius,body.centre),space:spaceShaderFor(body.radius),patch:patchShaderFor(body.radius)};
    cache.set(body.id,set);
  }
  return set;
}
