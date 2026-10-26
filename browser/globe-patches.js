// Whole-planet lat/lon patch tree (M4 spike). Selects quadtree patches [lat0,lat1,lon0,lon1] (radians) around the eye so the
// globe is a real mesh whose detail rises near the camera, instead of one analytic sphere. Rendered behind settings.globeMesh.
import {PLANET_RADIUS,subPoint} from './space.js';
import {wrapAngle} from './math.js';

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
    } else out.push([la0,la1,lo0,lo1,level]);
  };
  for(let i=0;i<4;i++)for(let j=0;j<2;j++)visit(-HALF+j*HALF,j*HALF,-Math.PI+i*HALF,-Math.PI+(i+1)*HALF,0);
  return stitch(out,limit);
}

// Square cells: at level L both lat and lon span HALF/2^L.
const FINE=1<<MAX_LEVEL,cellKey=(level,lat,lon)=>{const k=MAX_LEVEL-level;return level*4194304+(Math.floor((lat+HALF)/HALF*FINE)>>k)*2048+(Math.floor((lon+Math.PI)/HALF*FINE)>>k);};

/**
 * Balances the leaves to a 2:1 edge ratio and appends coarse-neighbour flags [south,north,west,east] (1 = neighbour is one level
 * coarser) so the vertex shader can snap odd edge vertices onto the coarser neighbour's edge and close LOD T-junctions exactly.
 */
function stitch(leaves,limit) {
  const wrap=wrapAngle;
  const index=()=>new Set(leaves.map(p=>cellKey(p[4],(p[0]+p[1])/2,(p[2]+p[3])/2)));
  // Level of the leaf containing (lat,lon), or -1 when culled / past a pole.
  const levelAt=(set,lat,lon)=>{
    if(lat<=-HALF||lat>=HALF)return -1;
    lon=wrap(lon);
    const r=Math.floor((lat+HALF)/HALF*FINE),c=Math.floor((lon+Math.PI)/HALF*FINE);
    for(let l=0;l<=MAX_LEVEL;l++){const k=MAX_LEVEL-l;if(set.has(l*4194304+(r>>k)*2048+(c>>k)))return l;}
    return -1;
  };
  // Neighbour level across each edge [south,north,west,east], probed a quarter and three quarters along it.
  const edgeLevels=(set,p,out)=>{
    const s=p[1]-p[0],e=s*1e-3,a=p[0]+s/4,b=p[0]+3*s/4,c=p[2]+s/4,d=p[2]+3*s/4;
    out[0]=Math.max(levelAt(set,p[0]-e,c),levelAt(set,p[0]-e,d));
    out[1]=Math.max(levelAt(set,p[1]+e,c),levelAt(set,p[1]+e,d));
    out[2]=Math.max(levelAt(set,a,p[2]-e),levelAt(set,b,p[2]-e));
    out[3]=Math.max(levelAt(set,a,p[3]+e),levelAt(set,b,p[3]+e));
    return out;
  };
  const lv=[0,0,0,0];  for(let pass=0;pass<12;pass++){
    const set=index(),next=[];let changed=false;
    for(const p of leaves){
      if(p[4]<MAX_LEVEL&&next.length+leaves.length<limit&&edgeLevels(set,p,lv).some(l=>l>p[4]+1)){
        const lm=(p[0]+p[1])/2,om=(p[2]+p[3])/2,l=p[4]+1;
        next.push([p[0],lm,p[2],om,l],[p[0],lm,om,p[3],l],[lm,p[1],p[2],om,l],[lm,p[1],om,p[3],l]);changed=true;
      } else next.push(p);
    }
    leaves=next;if(!changed)break;
  }
  const set=index();
  return leaves.map(p=>{const l=edgeLevels(set,p,lv);return [p[0],p[1],p[2],p[3],p[4],l[0]>=0&&l[0]<p[4]?1:0,l[1]>=0&&l[1]<p[4]?1:0,l[2]>=0&&l[2]<p[4]?1:0,l[3]>=0&&l[3]<p[4]?1:0];});
}

/** Patches for a flat eye position (x,z) and altitude. */
export function patchesAt(x,z,altitude,options) {
  const {lat,lon}=subPoint(x,z,options?.centre,options?.radius);
  // Longitude is periodic: wrap the sub-point into [-pi,pi) so the tree sees the nearest copy.
  return selectPatches(lat,wrapAngle(lon),altitude,options);
}

/** Packs patches into a Float32Array instance buffer (8 floats each: bounds, then coarse-neighbour flags S,N,W,E). */
export function packPatches(patches,out=new Float32Array(MAX_PATCHES*8)) {
  patches.slice(0,MAX_PATCHES).forEach((p,i)=>{out.set(p.slice(0,4),i*8);out.set(p.slice(5,9),i*8+4);});
  return out;
}

export const patchArea=p=>(p[3]-p[2])*(Math.sin(p[1])-Math.sin(p[0]));
