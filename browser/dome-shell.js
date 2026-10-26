// Faint druidic dome (design/elune.md): an additive hemispherical shell drawn through the prop path (vertex stride 12: pos, normal, uv, rgba).
// The soft Fresnel rim is baked into vertex alpha (brightest low on the horizon where a viewer inside looks through the most shell) and a longitudinal
// banding pattern that the renderer rotates slowly gives the shimmer, so no new pipeline or shader is needed.
import {SITES,domeCentre,domeMask} from './elune-sites.js';
import {MOON_SEED} from './moon-source.js';
import {moonHeightChart} from './moon-terrain.js';

const TEAL=[.35,.95,.75],GOLD=[1,.85,.45];

export function domeShellAsset(radius,{rings=12,segs=48,rim=.2,base=.012}={}) {
  const vertices=[],indices=[];
  for(let i=0;i<=rings;i++) {
    const phi=i/rings*Math.PI/2,y=Math.cos(phi)*radius,rr=Math.sin(phi)*radius,fres=Math.pow(1-Math.cos(phi),3);// phi from zenith to horizon
    for(let j=0;j<=segs;j++) {
      const lon=j/segs*Math.PI*2,band=.5+.5*Math.sin(lon*6),k=Math.min(1,.35+.65*band),a=base+rim*fres*(.6+.4*band);
      const col=TEAL.map((t,c)=>t+(GOLD[c]-t)*(1-k));
      vertices.push(Math.cos(lon)*rr,y,Math.sin(lon)*rr,-Math.cos(lon)*rr/radius,-y/radius,-Math.sin(lon)*rr/radius,j/segs,i/rings,col[0],col[1],col[2],a);
    }
  }
  for(let i=0;i<rings;i++)for(let j=0;j<segs;j++) {const a=i*(segs+1)+j,b=a+segs+1;indices.push(a,b,a+1,a+1,b,b+1);}
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),
    batches:[{firstIndex:0,indexCount:indices.length,texture:null,blend:'add',doubleSided:true,noDepthWrite:true,emissive:1}]};
}

/** Dome membership 0..1 at a world position [x,y,z] on `bodyId` (altitude measured above the site's ground); 0 where the body has no dome. */
export function domeLevel(bodyId,pos) {
  const p=domePlacement(bodyId);return p&&pos?domeMask(bodyId,pos[0],pos[2],30,15,pos[1]-p.pos[1]):0;
}

/** The dome to draw on `bodyId`: chart centre on the ground, radius and the shimmer rotation at `time`; undefined when the body has no site. */
export function domePlacement(bodyId,time=0,cx=30,cy=15) {
  const site=SITES[bodyId]?.[0];if(!site?.dome)return undefined;
  const [x,z]=domeCentre(site,cx,cy);
  return {id:site.id,radius:site.dome.radius,pos:[x,moonHeightChart(MOON_SEED,x,z),z],yaw:time*.04};
}
