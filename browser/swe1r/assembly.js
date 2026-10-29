// Static preview of the paired race model. Runtime engine poses are not stored in
// Podd's instance transforms; use the installed Lod1 surfaces as the rest pose.
import {parseModel, modelHeader, applyMat, mulMat} from './model.js';
import {meshTexture, decodeTriangles, BEAM_TEXTURE} from './pod.js';
import {INTAKE_TEXTURES} from './intakes.js';

const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
function surfaces(meshes, accept = () => true) {
  const out = new Map();
  for (const mesh of meshes) {
    const texture = meshTexture(mesh.body, mesh)?.index;
    if (texture === undefined || INTAKE_TEXTURES.has(texture) || texture === BEAM_TEXTURE) continue;
    for (const tri of decodeTriangles(mesh.body, mesh)) for (const v of tri) {
      const p = applyMat(mesh.matrix,v.x,v.y,v.z);
      if (!accept(p)) continue;
      if (!out.has(texture)) out.set(texture,{lo:[Infinity,Infinity,Infinity],hi:[-Infinity,-Infinity,-Infinity]});
      const box = out.get(texture);
      for (let a=0;a<3;a++) { box.lo[a]=Math.min(box.lo[a],p[a]); box.hi[a]=Math.max(box.hi[a],p[a]); }
    }
  }
  return out;
}

function restPose(source, target) {
  const pairs=[...source].filter(([key])=>target.has(key)).map(([key,box])=>[box,target.get(key)]);
  const scales=[];
  for (const [a,b] of pairs) {
    const axis=[0,1,2].sort((x,y)=>(a.hi[y]-a.lo[y])-(a.hi[x]-a.lo[x]))[0];
    if(a.hi[axis]-a.lo[axis]>.1)scales.push((b.hi[axis]-b.lo[axis])/(a.hi[axis]-a.lo[axis]));
  }
  if (scales.length<3) throw new Error('insufficient Lod1 rest-pose anchors');
  const scale=median(scales);
  if (!(scale>10 && scale<2000)) throw new Error('unrecognised Podd rest-pose scale');
  const t=[0,1,2].map(axis=>median(pairs.map(([a,b])=>(b.lo[axis]+b.hi[axis]-scale*(a.lo[axis]+a.hi[axis]))/2)));
  return [scale,0,0,t[0],0,scale,0,t[1],0,0,scale,t[2]];
}

export function assemblePod(body, mask, alternate, reference) {
  const {roots}=modelHeader(body);
  const meshes=[], replaced=new Set();
  // Header references are real engine instances (including Ben's extra pair),
  // unlike the hidden template subtree underneath MainModel.
  for (let part=1;part<=5;part++) {
    if (!roots[part]) continue;
    const branch=parseModel(body,mask,{alternate,root:roots[part],finest:true,visibleOnly:true}).meshes;
    const side=part===1||part===3?-1:1;
    const target=surfaces(reference,p=>part===5 || (p[0]*side>0 && (!roots[3] || (part<=2?p[2]>=0:p[2]<0))));
    // shortcut: texture envelopes approximate the game's dynamic engine poses;
    // keep the feature opt-in until every racer's authored pose is understood.
    const matrix=restPose(surfaces(branch),target);
    for (const mesh of branch) {
      const texture=meshTexture(mesh.body,mesh)?.index;
      // Keep the audited fans, binder and rear glow at their exact Lod1 positions.
      if (INTAKE_TEXTURES.has(texture)||texture===BEAM_TEXTURE||texture===117) continue;
      if (texture!==undefined) replaced.add(texture);
      meshes.push({...mesh,matrix:mulMat(matrix,mesh.matrix),path:[part,...mesh.path]});
    }
  }
  if (!meshes.length) throw new Error('empty paired model');
  return [...reference.filter(mesh=>!replaced.has(meshTexture(mesh.body,mesh)?.index)),...meshes];
}
