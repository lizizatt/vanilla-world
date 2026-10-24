// Whole-planet lat/lon patch tree (M4 spike). Selects quadtree patches [lat0,lat1,lon0,lon1] (radians) around the eye so the
// globe is a real mesh whose detail rises near the camera, instead of one analytic sphere. Rendered behind settings.globeMesh.
import {PLANET_RADIUS,subPoint} from './space.js';

export const PATCH_GRID=16,MAX_PATCHES=768,MAX_LEVEL=9,SPLIT_RATIO=.5,MIN_LEVEL=2;
const HALF=Math.PI/2;

// Great-circle angle between two lat/lon points.
const arc=(a,o,b,p)=>Math.acos(Math.min(1,Math.max(-1,Math.sin(a)*Math.sin(b)+Math.cos(a)*Math.cos(b)*Math.cos(o-p))));

/** Roots: 4 longitude bands x 2 latitude bands. Returns patches visible from an eye at `altitude` over (lat,lon). */
export function selectPatches(lat,lon,altitude,{radius=PLANET_RADIUS,cull=true,ratio=SPLIT_RATIO,maxLevel=MAX_LEVEL,limit=MAX_PATCHES}={}) {
  const alt=Math.max(0,altitude),horizon=Math.acos(radius/(radius+alt)),out=[];
  const near=(la0,la1,lo0,lo1)=>{
    const lc=(la0+la1)/2,oc=(lo0+lo1)/2,hs=Math.max(la1-la0,(lo1-lo0)*Math.cos(Math.max(Math.abs(la0),Math.abs(la1))>1.45?0:lc))/2+(la1-la0)/2;
    return {theta:Math.max(0,arc(lat,lon,lc,oc)-hs),size:radius*Math.max(la1-la0,(lo1-lo0)*Math.cos(lc))};
  };
  const visit=(la0,la1,lo0,lo1,level)=>{
    const {theta,size}=near(la0,la1,lo0,lo1);
    if(cull&&theta>horizon)return;
    const e=radius+alt,dist=Math.max(1,Math.sqrt(e*e+radius*radius-2*radius*e*Math.cos(theta))-0);
    if(level<maxLevel&&(level<MIN_LEVEL||size/dist>ratio)&&out.length<limit/2){
      const lm=(la0+la1)/2,om=(lo0+lo1)/2;
      visit(la0,lm,lo0,om,level+1);visit(la0,lm,om,lo1,level+1);visit(lm,la1,lo0,om,level+1);visit(lm,la1,om,lo1,level+1);
    } else out.push([la0,la1,lo0,lo1]);
  };
  for(let i=0;i<4;i++)for(let j=0;j<2;j++)visit(-HALF+j*HALF,j*HALF,-Math.PI+i*HALF,-Math.PI+(i+1)*HALF,0);
  return out;
}

/** Patches for a flat eye position (x,z) and altitude. */
export function patchesAt(x,z,altitude,options) {
  const {lat,lon}=subPoint(x,z);
  // Longitude is periodic: wrap the sub-point into [-pi,pi) so the tree sees the nearest copy.
  return selectPatches(lat,Math.atan2(Math.sin(lon),Math.cos(lon)),altitude,options);
}

/** Packs patches into a Float32Array instance buffer (4 floats each). */
export function packPatches(patches,out=new Float32Array(MAX_PATCHES*4)) {
  patches.slice(0,MAX_PATCHES).forEach((p,i)=>out.set(p,i*4));
  return out;
}

export const patchArea=p=>(p[3]-p[2])*(Math.sin(p[1])-Math.sin(p[0]));
