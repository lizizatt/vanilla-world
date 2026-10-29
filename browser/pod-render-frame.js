import {toPlanet,fromPlanet,localAxes} from './planet-frame.js';

const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const axes=(body,pose)=>{const a=localAxes(pose,body.centre,body.radius);return [a.east,a.up,a.south];};
const worldVector=(a,v)=>[0,1,2].map(i=>a.reduce((sum,column,j)=>sum+column[i]*v[j],0));

export function podParticleFrame(body,anchor) {
  const a=axes(body,anchor),p=toPlanet(anchor,body.centre,body.radius);
  return {
    point:v=>{const d=worldVector(a,v.map((x,i)=>x-anchor[i]));return p.map((x,i)=>x+d[i]);},
    vector:v=>worldVector(a,v),
  };
}
export function planetRelativeFrame(body,eye) {
  const a=axes(body,eye),p=toPlanet(eye,body.centre,body.radius);
  return position=>{const delta=position.map((v,i)=>v-p[i]);return a.map(axis=>dot(axis,delta));};
}

/** Metric camera offsets and directions, not equirectangular coordinate increments. */
export function podCameraFrame(body,anchor,offset,look,up=[0,1,0]) {
  const a=axes(body,anchor),center=toPlanet(anchor,body.centre,body.radius),delta=worldVector(a,offset);
  const eye=fromPlanet(center.map((v,i)=>v+delta[i]),anchor[0],body.centre,body.radius),b=axes(body,eye);
  const convert=v=>{const w=worldVector(a,v);return b.map(column=>dot(column,w));};
  return {eye,look:convert(look),up:convert(up)};
}

/** Rebase in f64 before upload; rotate a rigid mesh once instead of bending every vertex. */
export function rigidPodMatrix(matrix,anchor,eye,body,offset=[0,0,0]) {
  const a=axes(body,anchor),b=axes(body,eye);
  const p=toPlanet(anchor,body.centre,body.radius),e=toPlanet(eye,body.centre,body.radius);
  const shift=worldVector(a,offset),delta=p.map((v,i)=>v-e[i]+shift[i]),out=new Float32Array(16);
  for(let column=0;column<3;column++){
    const w=worldVector(a,Array.from(matrix.slice(column*4,column*4+3)));
    out.set(b.map(axis=>dot(axis,w)),column*4);
  }
  out.set([...b.map(axis=>dot(axis,delta)),1],12);
  return out;
}
