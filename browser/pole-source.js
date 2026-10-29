// Pole-frame tile synthesis (design/poles.md 5/7): synthetic ADTs for the N and S pole charts, from the same pure heightfields as the rest of the body.
// Azeroth: the procedural ice cap (pole-cap.js). Elune: the existing moon terrain sampled through the rotated chart (moon-terrain.js), no cap.
// Chart origin (0, 0) is the pole; tile (POLE_TILES/2, POLE_TILES/2) starts at the origin, so the pole sits on a tile corner. No data, no loading.
import {synthAdt,ADT_TILE} from './adt-synth.js';
import {chartToDir} from './frames.js';
import {capHeight,capAlbedo} from './pole-cap.js';
import {moonHeightDir,moonAlbedo} from './moon-terrain.js';
import {MOON_SEED,regolithBlp,regolithGroundBlp,moonMinimapHash} from './moon-source.js';
import {chunk,join,ver} from './demo-source.js';
import {PLANET_RADIUS,WORLD_CENTRE} from './space.js';
import {ELUNE_RADIUS} from './bodies.js';
import {poleFlagChunks} from './pole-flag.js';

export const POLE_TILES=16,POLE_AREA=90002;
const SPEC={
  azeroth:{radius:PLANET_RADIUS,centre:WORLD_CENTRE,height:d=>capHeight(d),albedo:d=>capAlbedo(d),texture:'Tileset\\Pole\\Ice.blp'},
  elune:{radius:ELUNE_RADIUS,centre:[0,0],height:d=>moonHeightDir(MOON_SEED,...d),albedo:d=>moonAlbedo(MOON_SEED,...d),texture:'Tileset\\Elune\\Regolith.blp'},
};
export const poleSpec=body=>{const s=SPEC[body];if(!s)throw new Error(`No pole spec for body ${body}`);return s;};
/** Chart (x, z) of the pole frame -> height (yd above sea; Elune: above the mean sphere). */
export const poleHeightChart=(body,frame,x,z)=>{const s=poleSpec(body);return s.height(chartToDir(frame,x,z,s.centre,s.radius));};
export const poleAlbedoChart=(body,frame,x,z)=>{const s=poleSpec(body);return s.albedo(chartToDir(frame,x,z,s.centre,s.radius));};
export const poleTileOrigin=(tx,ty,n=POLE_TILES)=>[(tx-n/2)*ADT_TILE,(ty-n/2)*ADT_TILE];

/** Height lattice (2.08 yd with a one-cell border) of one pole tile; vertices and normals share it so normals are continuous across tile borders. */
export function poleLattice(body,frame,tx,ty,n=POLE_TILES) {
  const [ox,oz]=poleTileOrigin(tx,ty,n),S=ADT_TILE/256,N=259,H=new Float32Array(N*N);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++)H[j*N+i]=poleHeightChart(body,frame,ox+(i-1)*S,oz+(j-1)*S);
  return {H,N,S};
}
const POLE_MAP='Elune';// the body manifest (version 4) accepts only this map name, so a pole frame is served as a 16x16 "Elune" region whose chart origin is the pole
const poleTiles=function*(){for(let y=0;y<POLE_TILES;y++)for(let x=0;x<POLE_TILES;x++)yield [x,y];};
export function poleWdt() {
  const main=new Uint8Array(4096*8);
  for(const [x,y] of poleTiles())main[(y*64+x)*8]=1;
  return join([ver(),chunk('MPHD',new Uint8Array(32)),chunk('MAIN',main)]);
}
export function poleWdl(body,frame) {
  const maof=new Uint8Array(4096*4),mv=new DataView(maof.buffer),tiles=[];
  let at=ver().length+8+4096*4;
  const hAt=(x,y,c,r)=>Math.round(poleHeightChart(body,frame,(x+c-POLE_TILES/2)*ADT_TILE,(y+r-POLE_TILES/2)*ADT_TILE));
  for(const [x,y] of poleTiles()) {
    const h=new Uint8Array(545*2),hv=new DataView(h.buffer);
    for(let r=0;r<17;r++)for(let c=0;c<17;c++)hv.setInt16((r*17+c)*2,hAt(x,y,c/16,r/16),true);
    for(let r=0;r<16;r++)for(let c=0;c<16;c++)hv.setInt16((289+r*16+c)*2,hAt(x,y,(c+.5)/16,(r+.5)/16),true);
    mv.setUint32((y*64+x)*4,at,true);const mare=chunk('MARE',h);tiles.push(mare);at+=mare.length;
  }
  return join([ver(),chunk('MAOF',maof),...tiles]);
}
/** Asset source for one pole frame, shaped like moonSource so the unmodified engine opens it as a body-world. `spec` is 'elune:N' | 'azeroth:S' ... */
export function poleBodySource(spec) {
  const [body,frame]=String(spec).split(':');poleSpec(body);if(frame!=='N'&&frame!=='S')throw new Error(`Bad pole frame ${spec}`);
  const base=`world\\maps\\${POLE_MAP}\\${POLE_MAP}`.toLowerCase(),ground=regolithGroundBlp(),rgb=body==='azeroth'?[225,232,240]:[128,128,128],minimap=regolithBlp(64,rgb);
  const files=new Map([[base+'.wdt',poleWdt()],[base+'.wdl',poleWdl(body,frame)]]),cache=new Map();
  const rows=()=>{let t='';for(const [x,y] of poleTiles())t+=`${POLE_MAP}\\map${x}_${y}.blp\t${moonMinimapHash(x,y)}\n`;return new TextEncoder().encode(t);};
  return {
    fingerprint:`pole-${body}-${frame}-v1`,archives:[],stats:{},
    async read(path) {
      const key=path.replaceAll('/','\\').toLowerCase(),hit=files.get(key);
      if(hit)return hit.slice();
      if(key==='textures\\minimap\\md5translate.trs')return rows();
      if(key.endsWith('.blp'))return (key.includes('minimap')?minimap:ground).slice();
      const m=/^world\\maps\\elune\\elune_(\d+)_(\d+)\.adt$/.exec(key);
      if(m&&+m[1]<POLE_TILES&&+m[2]<POLE_TILES){
        if(!cache.has(key)){if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,poleAdt(body,frame,+m[1],+m[2]));}
        return cache.get(key).slice();
      }
      throw Object.assign(new Error(`File not in pole frame: ${path}`),{code:'NOT_FOUND'});
    },
    close() {},
  };
}
/** Synthetic ADT bytes for pole tile (tx, ty in 0..POLE_TILES-1) of `frame` ('N'|'S'). */
export function poleAdt(body,frame,tx,ty,n=POLE_TILES) {
  const {H,N,S}=poleLattice(body,frame,tx,ty,n),cell=(lx,lz)=>(Math.round(lz/S)+1)*N+Math.round(lx/S)+1;
  const normal=(lx,lz)=>{const k=cell(lx,lz),dx=(H[k+1]-H[k-1])/(2*S),dz=(H[k+N]-H[k-N])/(2*S),m=Math.hypot(dx,dz,1);return [dz/m,dx/m,1/m];};
  const extra=tx===Math.floor(n/2)&&ty===Math.floor(n/2)?poleFlagChunks(frame,poleHeightChart(body,frame,0,0),Math.floor(n/2)):[];
  return synthAdt((lx,lz)=>H[cell(lx,lz)],tx,ty,poleSpec(body).texture,POLE_AREA,normal,extra);
}

// ---- Engine overlay (L3): the real body world plus the N and S pole regions that wasm `with_poles` appends. ----
/** Per-body frame spec fed to wasm `with_poles` (radians, chart yards). Azeroth hands over at 72 deg (ramp from 62), Elune at 60 deg (ramp from 40). */
export const POLE_FRAME_SPEC={
  azeroth:{radius:PLANET_RADIUS,centre:WORLD_CENTRE,handoff:72*Math.PI/180,hysteresis:Math.PI/180,ramp_start:62*Math.PI/180,wrap:2*Math.PI*PLANET_RADIUS,tiles:[20,20]},
  elune:{radius:ELUNE_RADIUS,centre:[0,0],handoff:Math.PI/3,hysteresis:Math.PI/180,ramp_start:40*Math.PI/180,wrap:2*Math.PI*ELUNE_RADIUS,tiles:[12,12]},
};
export const poleFrameSpec=body=>{const s=POLE_FRAME_SPEC[body];if(!s)throw new Error(`No pole frame spec for body ${body}`);return s;};
const POLE_REGION=/^world\\maps\\pole([ns])\\pole[ns]_(\d+)_(\d+)\.adt$/;
const POLE_MINIMAP=/^textures\\minimap\\0{22}([\da-f]{4})([\da-f]{4})f([12])\.blp$/;
export const poleMinimapHash=(frame,tx,ty)=>`${'0'.repeat(22)}${tx.toString(16).padStart(4,'0')}${ty.toString(16).padStart(4,'0')}f${frame==='N'?1:2}.blp`;
const concat=(a,b)=>{const out=new Uint8Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;};
/** Wrap an asset source so the pole regions' tiles, minimaps and ice texture are synthesised on demand; every other path goes to `inner` unchanged. No data, no loading. */
export function withPoleTiles(inner,body) {
  const [nx,ny]=poleFrameSpec(body).tiles,spec=poleSpec(body),cache=new Map(),ice=regolithBlp(64,body==='azeroth'?[225,232,240]:[128,128,128]);
  const rows=()=>{let t='';for(const f of ['N','S'])for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)t+=`Pole${f}\\map${x}_${y}.blp\t${poleMinimapHash(f,x,y)}\n`;return new TextEncoder().encode(t);};
  return {
    get fingerprint(){return inner.fingerprint;},get archives(){return inner.archives;},get stats(){return inner.stats;},
    async read(path,options) {
      const key=path.replaceAll('/','\\').toLowerCase();
      if(key==='textures\\minimap\\md5translate.trs'){const base=await inner.read(path,options);return concat(base,rows());}
      if(POLE_MINIMAP.test(key))return ice.slice();
      if(key==='tileset\\pole\\ice.blp')return ice.slice();
      const m=POLE_REGION.exec(key);
      if(m&&+m[2]<nx&&+m[3]<ny) {
        if(!cache.has(key)){if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,poleAdt(body,m[1].toUpperCase(),+m[2],+m[3],nx));}
        return cache.get(key).slice();
      }
      return inner.read(path,options);
    },
    close() {return inner.close?.();},
  };
}
