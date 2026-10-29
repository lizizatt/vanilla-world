// Pole-frame tile synthesis (design/poles.md 5/7): synthetic ADTs for the N and S pole charts, from the same pure heightfields as the rest of the body.
// Azeroth: the procedural ice cap (pole-cap.js). Elune: the existing moon terrain sampled through the rotated chart (moon-terrain.js), no cap.
// Chart origin (0, 0) is the pole; tile (POLE_TILES/2, POLE_TILES/2) starts at the origin, so the pole sits on a tile corner. No data, no loading.
import {synthAdt,ADT_TILE} from './adt-synth.js';
import {chartToDir} from './frames.js';
import {capHeight,capAlbedo} from './pole-cap.js';
import {moonHeightDir,moonAlbedo} from './moon-terrain.js';
import {MOON_SEED} from './moon-source.js';
import {PLANET_RADIUS,WORLD_CENTRE} from './space.js';
import {ELUNE_RADIUS} from './bodies.js';

export const POLE_TILES=16,POLE_AREA=90002;
const SPEC={
  azeroth:{radius:PLANET_RADIUS,centre:WORLD_CENTRE,height:d=>capHeight(d),albedo:d=>capAlbedo(d),texture:'Tileset\\Pole\\Ice.blp'},
  elune:{radius:ELUNE_RADIUS,centre:[0,0],height:d=>moonHeightDir(MOON_SEED,...d),albedo:d=>moonAlbedo(MOON_SEED,...d),texture:'Tileset\\Elune\\Regolith.blp'},
};
export const poleSpec=body=>{const s=SPEC[body];if(!s)throw new Error(`No pole spec for body ${body}`);return s;};
/** Chart (x, z) of the pole frame -> height (yd above sea; Elune: above the mean sphere). */
export const poleHeightChart=(body,frame,x,z)=>{const s=poleSpec(body);return s.height(chartToDir(frame,x,z,s.centre,s.radius));};
export const poleAlbedoChart=(body,frame,x,z)=>{const s=poleSpec(body);return s.albedo(chartToDir(frame,x,z,s.centre,s.radius));};
export const poleTileOrigin=(tx,ty)=>[(tx-POLE_TILES/2)*ADT_TILE,(ty-POLE_TILES/2)*ADT_TILE];

/** Height lattice (2.08 yd with a one-cell border) of one pole tile; vertices and normals share it so normals are continuous across tile borders. */
export function poleLattice(body,frame,tx,ty) {
  const [ox,oz]=poleTileOrigin(tx,ty),S=ADT_TILE/256,N=259,H=new Float32Array(N*N);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++)H[j*N+i]=poleHeightChart(body,frame,ox+(i-1)*S,oz+(j-1)*S);
  return {H,N,S};
}
/** Synthetic ADT bytes for pole tile (tx, ty in 0..POLE_TILES-1) of `frame` ('N'|'S'). */
export function poleAdt(body,frame,tx,ty) {
  const {H,N,S}=poleLattice(body,frame,tx,ty),cell=(lx,lz)=>(Math.round(lz/S)+1)*N+Math.round(lx/S)+1;
  const normal=(lx,lz)=>{const k=cell(lx,lz),dx=(H[k+1]-H[k-1])/(2*S),dz=(H[k+N]-H[k-N])/(2*S),m=Math.hypot(dx,dz,1);return [dz/m,dx/m,1/m];};
  return synthAdt((lx,lz)=>H[cell(lx,lz)],tx,ty,poleSpec(body).texture,POLE_AREA,normal);
}
