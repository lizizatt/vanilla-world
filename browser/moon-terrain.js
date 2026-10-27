// Procedural Elune terrain (design/elune.md M1): a pure function of (seed, unit direction), so tiles agree on every shared edge and across the lon wrap.
// Integer hashing only in the noise lattice; output is rounded to 1/64 yd so JS and any later wasm port can match bit for bit.
import {synthAdt,ADT_TILE} from './adt-synth.js';
import {ELUNE_RADIUS} from './bodies.js';

export const MOON_TILES_X=60,MOON_TILES_Y=30;
const R=ELUNE_RADIUS;

const hash3=(seed,x,y,z)=>{
  let h=Math.imul(seed|0,0x9e3779b1)^Math.imul(x,0x85ebca6b)^Math.imul(y,0xc2b2ae35)^Math.imul(z,0x27d4eb2f);
  h^=h>>>15;h=Math.imul(h,0x2c1b3c6d);h^=h>>>12;h=Math.imul(h,0x297a2d39);h^=h>>>15;
  return (h>>>0)/4294967296;
};
const fade=t=>t*t*(3-2*t);
/** Smooth value noise in [0,1) on the 3D lattice. */
export function noise3(seed,x,y,z) {
  const xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z),fx=fade(x-xi),fy=fade(y-yi),fz=fade(z-zi);
  const c=(a,b,d)=>hash3(seed,xi+a,yi+b,zi+d),l=(a,b,t)=>a+(b-a)*t;
  return l(l(l(c(0,0,0),c(1,0,0),fx),l(c(0,1,0),c(1,1,0),fx),fy),l(l(c(0,0,1),c(1,0,1),fx),l(c(0,1,1),c(1,1,1),fx),fy),fz);
}
export const fbm=(seed,x,y,z,octaves)=>{let s=0,a=.5,f=1,n=0;for(let i=0;i<octaves;i++){s+=a*(noise3(seed+i*101,x*f,y*f,z*f)-.5);n+=a;a*=.5;f*=2;}return s/n;};

/** Crater layers: [cells around the globe, rim-to-centre radius as a fraction of a cell, depth yd, spawn chance]. */
const LAYERS=[[7,.42,150,.55],[17,.4,60,.6],[43,.38,22,.65],[109,.36,7,.7]];
function craters(seed,x,y,z) {
  let h=0;
  for(let L=0;L<LAYERS.length;L++) {
    const [n,rf,depth,p]=LAYERS[L],sx=x*n,sy=y*n,sz=z*n,reach=1.6*rf+1e-9,s=seed+L*7919;
    // A crater centre sits in [i+.2,i+.8] and reaches at most 1.6*rf cells, so only the cells within reach of the point can contribute (about 2 per axis, not 3).
    const x0=Math.ceil(sx-.8-reach),x1=Math.floor(sx-.2+reach),y0=Math.ceil(sy-.8-reach),y1=Math.floor(sy-.2+reach),z0=Math.ceil(sz-.8-reach),z1=Math.floor(sz-.2+reach);
    for(let ix=x0;ix<=x1;ix++)for(let iy=y0;iy<=y1;iy++)for(let iz=z0;iz<=z1;iz++) {
      if(hash3(s,ix,iy,iz)>p)continue;
      const px=ix+.2+.6*hash3(s+1,ix,iy,iz),py=iy+.2+.6*hash3(s+2,ix,iy,iz),pz=iz+.2+.6*hash3(s+3,ix,iy,iz);
      const r0=rf*(.5+.5*hash3(s+4,ix,iy,iz)),d=Math.hypot(sx-px,sy-py,sz-pz)/r0;
      if(d>1.6)continue;
      const dp=depth*(.5+.5*hash3(s+5,ix,iy,iz));
      // bowl inside the rim, raised lip at d~1, ejecta falling off outside
      h+=d<1?-dp*(1-d*d)*(1-.25*d)+dp*.18*d**4:dp*.18*Math.exp(-(d-1)*(d-1)*14);
    }
  }
  return h;
}

/** Height in yd above the mean sphere at a unit direction (x toward lon 0/lat 0, y north, z toward lon +90deg). */
export function moonHeightDir(seed,x,y,z) {
  const mare=fbm(seed+11,x*1.6,y*1.6,z*1.6,3),inMare=Math.min(1,Math.max(0,(mare+.02)*18));// broad basins, flat floors
  const base=60*fbm(seed,x*3,y*3,z*3,5)+(1-inMare)*70*fbm(seed+3,x*5,y*5,z*5,4)-inMare*90;
  const rough=(1-.8*inMare)*(1+.5*fbm(seed+7,x*40,y*40,z*40,3));
  return Math.round((base+craters(seed,x,y,z)*(1-.6*inMare)*rough+(inMare?0:0))*64)/64;
}
/** Mare weight 0..1 (for albedo). */
export const moonMare=(seed,x,y,z)=>Math.min(1,Math.max(0,(fbm(seed+11,x*1.6,y*1.6,z*1.6,3)+.02)*18));

/** Chart position (yd, chart centre [0,0], x east, z south) -> unit direction (planet-frame.js convention). */
export function chartDir(x,z) {
  const lon=x/R,lat=-z/R,cl=Math.cos(lat);
  return [cl*Math.cos(lon),Math.sin(lat),cl*Math.sin(lon)];
}
export const moonHeightChart=(seed,x,z)=>moonHeightDir(seed,...chartDir(x,z));

/** Synthetic ADT bytes for tile (tx 0..59, ty 0..29); tile 30,15 starts at the chart centre. */
export const ELUNE_AREA=90001;// synthetic AreaTable id, resolved in JS (no DBC row)
export function moonAdt(seed,tx,ty,{height=(x,z,h)=>h,area=ELUNE_AREA}={}) {
  const ox=(tx-MOON_TILES_X/2)*ADT_TILE,oz=(ty-MOON_TILES_Y/2)*ADT_TILE;
  // One height lattice (2.08 yd, plus a one-cell border) serves both vertices and normals, so normals are continuous across tile and chunk borders.
  const S=ADT_TILE/256,N=259,H=new Float32Array(N*N);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){const x=ox+(i-1)*S,z=oz+(j-1)*S;H[j*N+i]=height(x,z,moonHeightChart(seed,x,z));}
  const cell=(lx,lz)=>(Math.round(lz/S)+1)*N+Math.round(lx/S)+1;
  const normal=(lx,lz)=>{const k=cell(lx,lz),dx=(H[k+1]-H[k-1])/(2*S),dz=(H[k+N]-H[k-N])/(2*S),m=Math.hypot(dx,dz,1);return [dz/m,dx/m,1/m];};
  return synthAdt((lx,lz)=>H[cell(lx,lz)],tx,ty,'Tileset\\Elune\\Regolith.blp',area,normal);
}

/** Regolith albedo (rgb 0..1): neutral grey highlands and darker grey maria, matching the ground texture and per-tile minimap (no colour cast). */
export function moonAlbedo(seed,x,y,z) {
  const m=moonMare(seed,x,y,z),g=.5+.5*fbm(seed+19,x*25,y*25,z*25,3);
  const hi=[.62,.62,.62],lo=[.33,.33,.33];
  return hi.map((v,i)=>(v+(lo[i]-v)*m)*(.85+.3*g));
}
