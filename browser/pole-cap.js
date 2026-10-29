// Procedural Azeroth pole cap (design/poles.md 5): a pure function of the body-space unit direction, so near tiles, the minimap and the globe all agree and nothing loads.
// Heights are yd above sea level (sea = 0) rounded to 1/64 yd like moonHeightDir; integer hashing only in the lattice.
import {noise3} from './moon-terrain.js';
import {PLANET_RADIUS} from './space.js';

const R=PLANET_RADIUS,deg=Math.PI/180;
export const CAP={
  seed:0x501a2,
  edge:10*deg,edgeJitter:1.5*deg,// ice edge colatitude +- jitter (rad)
  shelfMin:1.09,shelfMax:10.94,// 1..10 m in yd
  seabed:-12,rampRun:1.5,// yd: steep shelf edge so a pod can drive off it
  bergBand:547,bergCell:250,bergChance:.3,bergRadius:[6,25],bergTop:[1,6],// yd
  sastrugi:.15,
};
const hash=(s,x,y,z)=>{let h=Math.imul(s|0,0x9e3779b1)^Math.imul(x,0x85ebca6b)^Math.imul(y,0xc2b2ae35)^Math.imul(z,0x27d4eb2f);h^=h>>>15;h=Math.imul(h,0x2c1b3c6d);h^=h>>>12;h=Math.imul(h,0x297a2d39);h^=h>>>15;return (h>>>0)/4294967296;};
const smooth=(a,b,t)=>{t=Math.min(1,Math.max(0,(t-a)/(b-a)));return t*t*(3-2*t);};
const round64=v=>Math.round(v*64)/64;

/** Shelf edge colatitude (rad) at body direction `d`: lon-only noise around the pole axis, so the coastline is the same from both hemispheres' viewpoints. */
export const edgeColat=(d,seed=CAP.seed)=>{
  const a=Math.hypot(d[0],d[2])||1,cx=d[0]/a,cz=d[2]/a;
  return CAP.edge+CAP.edgeJitter*(2*(.7*noise3(seed+1,cx*2.2+9,cz*2.2+9,d[1]<0?5:0)+.3*noise3(seed+2,cx*6+3,cz*6+3,d[1]<0?5:0))-1);
};

const BERG_FACES=5,TAU=Math.PI*2;
/** Highest iceberg top (yd above sea) at `d`, or -Infinity when no berg covers it. Bergs live on a (colat, lon) grid (cells ~bergCell yd) and only inside the berg belt; the grid is mirrored for the south pole. */
function bergHeight(d,colat,edge,seed) {
  const band=CAP.bergBand/R;
  if(colat<=edge||colat>edge+band+CAP.bergRadius[1]/R)return -Infinity;
  const lon=Math.atan2(d[2],d[0]),cellA=CAP.bergCell/R,row=Math.floor(colat/cellA),y=Math.abs(d[1]);
  let top=-Infinity;
  for(let r=row-1;r<=row+1;r++) {
    if(r<1)continue;
    const rc=(r+.5)*cellA,n=Math.max(1,Math.round(TAU*Math.sin(rc)*R/CAP.bergCell));
    const j0=Math.floor((lon<0?lon+TAU:lon)/TAU*n);
    for(let j=j0-1;j<=j0+1;j++) {
      const jj=((j%n)+n)%n;
      if(hash(seed+11,r,jj,n)>=CAP.bergChance)continue;
      const cc=(r+.15+.7*hash(seed+12,r,jj,n))*cellA,cl=(jj+.15+.7*hash(seed+13,r,jj,n))*TAU/n;
      const c=[Math.sin(cc)*Math.cos(cl),Math.cos(cc),Math.sin(cc)*Math.sin(cl)];
      const radius=CAP.bergRadius[0]+(CAP.bergRadius[1]-CAP.bergRadius[0])*hash(seed+15,r,jj,n);
      const ce=edgeColat(c,seed);
      if(cc<ce+radius/R+4/R||cc>ce+band)continue;// berg centre inside the belt, clear of the shelf
      const dx=(d[0]-c[0])*R,dy=(y-c[1])*R,dz=(d[2]-c[2])*R;
      if(Math.hypot(dx,dy,dz)>radius*1.05)continue;
      const e1=[-Math.sin(cl),0,Math.cos(cl)],e2=[Math.cos(cc)*Math.cos(cl),-Math.sin(cc),Math.cos(cc)*Math.sin(cl)];// east, toward the pole
      const p1=dx*e1[0]+dz*e1[2],p2=dx*e2[0]+dy*e2[1]+dz*e2[2],ang0=hash(seed+16,r,jj,n)*TAU;
      let m=0;for(let f=0;f<BERG_FACES;f++){const ang=ang0+f*TAU/BERG_FACES;m=Math.max(m,(p1*Math.cos(ang)+p2*Math.sin(ang))/radius);}
      if(m>=1)continue;
      const bt=CAP.bergTop[0]+(CAP.bergTop[1]-CAP.bergTop[0])*hash(seed+17,r,jj,n);
      top=Math.max(top,bt+(CAP.seabed-bt)*smooth(.7,1,m)-bt*.3*m);
    }
  }
  return top;
}
/** Ground height in yd above sea level at unit body direction `d` (north cap when d[1]>0, south when <0; both are the same function of colatitude). */
export function capHeight(d,seed=CAP.seed) {
  const colat=Math.acos(Math.min(1,Math.abs(d[1]))),edge=edgeColat(d,seed);
  let h=CAP.seabed;
  if(colat<edge+CAP.rampRun/R) {
    const shelf=CAP.shelfMin+(CAP.shelfMax-CAP.shelfMin)*noise3(seed+3,d[0]*R/2200,d[1]*R/2200+(d[1]<0?7:0),d[2]*R/2200);
    const sastr=CAP.sastrugi*(noise3(seed+4,d[0]*R/9,d[1]*R/9,d[2]*R/9)-.5)*2;
    const ice=shelf+sastr,t=smooth(edge,edge+CAP.rampRun/R,colat);
    h=ice+(CAP.seabed-ice)*t;
  }
  const berg=bergHeight(d,colat,edge,seed);
  if(berg>h)h=berg;
  return round64(h);
}
/** True where the cap function puts ice (shelf or berg) above sea level; used for colour and tests. */
export const capIsIce=(d,seed=CAP.seed)=>capHeight(d,seed)>0;

/** Surface colour (rgb 0..1) of the cap: snow white on the plane, ice blue on bergs and the shelf face. */
export function capAlbedo(d,seed=CAP.seed) {
  const h=capHeight(d,seed);
  if(h<=0)return [.2,.32,.42];// shallow seabed seen through the ocean
  const g=.5+.5*noise3(seed+5,d[0]*R/30,d[1]*R/30,d[2]*R/30),face=h<3;
  const s=.88+.1*g;
  return face?[.62*s,.78*s,.9*s]:[.93*s,.96*s,1*s];
}
