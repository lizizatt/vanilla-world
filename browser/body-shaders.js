// Per-body shader sets (design/elune.md step D1). Azeroth's set is byte-identical to the module-level constants in space.js,
// so the renderer's Azeroth output is unchanged; Elune gets the same shaders at its own radius and chart centre.
import {bendShaderFor,spaceShaderFor,patchShaderFor} from './space.js';
import {AZEROTH,ELUNE,bodyOf} from './bodies.js';
import {atmosphericDisc} from './body-sky.js';
import {frameCentre} from './frames.js';

/** The body this page's chart renders: ?body=elune boots the moon, anything else Azeroth; setActiveBody switches it in-page (the renderer rebuilds its radius-baked pipelines via useBody). */
let current;
export const activeBody=()=>current??(typeof location!=='undefined'&&new URLSearchParams(location.search).get('body')==='elune'?ELUNE:AZEROTH);
export const setActiveBody=body=>{current=body;};
let frameId='E',framed;
/** Which frame ('E','N','S') the camera's chart coordinates are in; E is the authored chart and leaves every body untouched. */
export const setActiveFrame=id=>{frameId=id||'E';};
export const activeFrame=()=>frameId;
/** The active body with its centre carried into the active frame: every (centre, radius) consumer becomes frame-aware; identical object to the base body in E. */
export function activeFramedBody() {
  const base=activeBody();if(frameId==='E')return base;
  if(!framed||framed.base!==base||framed.id!==frameId)framed={base,id:frameId,body:{...base,centre:frameCentre(frameId,base.centre)}};
  return framed.body;
}
export const wgslNumber=x=>Number.isInteger(x)?x+'.0':String(x);

const cache=new Map();
export function shaderSetFor(body) {
  let set=cache.get(body.id);
  if(!set){
    const o={airless:!(body.atmosphereEdge>0),atmosphericDisc:!!body.parent&&atmosphericDisc(bodyOf(body.parent))};
    set={bend:bendShaderFor(body.radius,body.centre),space:spaceShaderFor(body.radius,o),patch:patchShaderFor(body.radius,o)};
    cache.set(body.id,set);
  }
  return set;
}
