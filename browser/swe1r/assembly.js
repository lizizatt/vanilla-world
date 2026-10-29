import {parseModel, modelHeader, mulMat, applyMat} from './model.js';
import {decodeTriangles,meshTexture,BEAM_TEXTURE} from './pod.js';

const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0];
function points(meshes) {
  const unique=new Map();
  for (const mesh of meshes) {
    if ([116,117].includes(meshTexture(mesh.body,mesh)?.index)) continue;
    for (const tri of decodeTriangles(mesh.body,mesh)) for (const v of tri) {
      const p=applyMat(mesh.matrix,v.x,v.y,v.z);
      unique.set(p.join(','),p);
    }
  }
  return [...unique.values()];
}

function closest(a,b) {
  let distance=Infinity,pair;
  for (const p of a) for (const q of b) {
    const d=p.reduce((n,x,i)=>n+(x-q[i])**2,0);
    if (d<distance) {distance=d;pair=[p,q];}
  }
  return pair;
}

// The Podd tether template runs from y=0 to y=-100, with a 10-unit square section.
export function tetherMatrix(a,b) {
  const y=a.map((v,i)=>(v-b[i])/100),length=Math.hypot(...y);
  if (!(length>0)) throw new Error('zero length pod tether');
  const h=Math.hypot(y[0],y[1]),x=h?[y[1]/h,-y[0]/h,0]:[1,0,0];
  const z=[-y[2]*x[1]/length,y[2]*x[0]/length,(y[0]*x[1]-y[1]*x[0])/length];
  return [x[0],y[0],z[0],a[0]-5*(x[0]+z[0]),x[1],y[1],z[1],a[1]-5*(x[1]+z[1]),x[2],y[2],z[2],a[2]-5*(x[2]+z[2])];
}

function binder(a,b) {
  const v=(p,z,u,w)=>({x:p[0],y:p[1],z:p[2]+z,u,v:w,r:1,g:1,b:1,a:1});
  const p=[v(a,-80,0,4096),v(b,-80,4096,4096),v(b,80,4096,0),v(a,80,0,0)];
  return {body:new Uint8Array(),matrix:IDENTITY,texture:{index:BEAM_TEXTURE,format:3,width:64,height:16,addressU:'repeat',addressV:'repeat'},
    triangles:[[p[0],p[1],p[2]],[p[0],p[2],p[3]]],path:[0]};
}

export function assemblePod(body, mask, alternate, pose) {
  const {roots}=modelHeader(body);
  if (!pose || pose.parts.length!==5) throw new Error('missing pod pose calibration');
  const meshes=[],parts=[];
  for (let part=1;part<=5;part++) {
    const position=pose.parts[part-1];
    if (!roots[part] && !position) continue;
    if (!roots[part] || !position?.every(Number.isFinite)) throw new Error('incomplete pod assembly');
    // The existing particle renderer owns exhaust plumes, at the preserved anchors.
    const branch=parseModel(body,mask,{alternate,root:roots[part],finest:true,visibleOnly:true}).meshes
      .filter(mesh=>meshTexture(mesh.body,mesh)?.index!==116);
    if (!branch.length) throw new Error('empty pod instance');
    const [x,y,z]=position;
    // Fans and housings must share the same transform. Fitting material envelopes
    // separately inflated Ben's housings and left the borrowed fans behind them.
    const matrix=[250,0,0,x,0,250,0,y,0,0,250,z];
    const instance=branch.map(mesh=>({...mesh,matrix:mulMat(matrix,mesh.matrix),path:[part,...mesh.path]}));
    parts[part]=points(instance);
    meshes.push(...instance);
  }
  if (!meshes.length) throw new Error('empty paired model');
  for (let part=1;part<=4;part++) {
    if (!parts[part] || !roots[part+9]) continue;
    const [a,b]=closest(parts[part],parts[5]);
    // Integrated bodies already meet the cockpit; they do not need a free tether.
    if (Math.hypot(...a.map((v,i)=>v-b[i]))<50) continue;
    const matrix=tetherMatrix(a,b);
    for (const mesh of parseModel(body,mask,{root:roots[part+9],finest:true,visibleOnly:true}).meshes)
      meshes.push({...mesh,matrix:mulMat(matrix,mesh.matrix),path:[part+9,...mesh.path]});
  }
  if (pose.binder!==false) {
    for (const [left,right] of [[1,2],[3,4]]) {
      if (!parts[left] || !parts[right]) continue;
      const [a,b]=closest(parts[left],parts[right]);
      meshes.push(binder(a,b));
    }
  }
  return meshes;
}
