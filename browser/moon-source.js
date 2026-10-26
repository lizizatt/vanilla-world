// Elune asset source (design/elune.md M2): serves a generated WDT/WDL/ADT set for the map "Elune" from moon-terrain, like demo-source does for the demo world. No game data.
import {chunk,join,ver} from './demo-source.js';
import {moonAdt,moonHeightChart,MOON_TILES_X,MOON_TILES_Y} from './moon-terrain.js';
import {ADT_TILE} from './adt-synth.js';

export const ELUNE_MAP='Elune';
export const MOON_SEED=0x1e11e;
const present=(x,y)=>x>=0&&y>=0&&x<MOON_TILES_X&&y<MOON_TILES_Y;
const OX=MOON_TILES_X/2,OY=MOON_TILES_Y/2;

export function moonWdt() {
  const main=new Uint8Array(4096*8);
  for(let i=0;i<4096;i++)if(present(i%64,i>>6))main[i*8]=1;
  return join([ver(),chunk('MPHD',new Uint8Array(32)),chunk('MAIN',main)]);
}

export function moonWdl(seed=MOON_SEED) {
  const maof=new Uint8Array(4096*4),mv=new DataView(maof.buffer),tiles=[];
  let at=ver().length+8+4096*4;
  const hAt=(x,y,c,r)=>Math.round(moonHeightChart(seed,(x+c-OX)*ADT_TILE,(y+r-OY)*ADT_TILE));
  for(let i=0;i<4096;i++) {
    const x=i%64,y=i>>6;if(!present(x,y))continue;
    const h=new Uint8Array(545*2),hv=new DataView(h.buffer);
    for(let r=0;r<17;r++)for(let c=0;c<17;c++)hv.setInt16((r*17+c)*2,hAt(x,y,c/16,r/16),true);
    for(let r=0;r<16;r++)for(let c=0;c<16;c++)hv.setInt16((289+r*16+c)*2,hAt(x,y,(c+.5)/16,(r+.5)/16),true);
    mv.setUint32(i*4,at,true);const mare=chunk('MARE',h);tiles.push(mare);at+=mare.length;
  }
  return join([ver(),chunk('MAOF',maof),...tiles]);
}

/** Solid regolith-coloured 64x64 palettised BLP2, used as the minimap of procedural moon tiles that sit beside real ones. */
export function regolithBlp(size=64,rgb=[165,152,112]) {
  const out=new Uint8Array(148+1024+size*size),v=new DataView(out.buffer);
  out.set([0x42,0x4c,0x50,0x32]);v.setUint32(4,1,true);out[8]=1;v.setUint32(12,size,true);v.setUint32(16,size,true);
  v.setUint32(20,148+1024,true);v.setUint32(84,size*size,true);
  out.set([rgb[2],rgb[1],rgb[0],255],148);
  return out;
}

/** Mottled grey-tan regolith ground texture: 64x64 palettised BLP2 with 32 shades and tileable value noise plus small pits, so procedural tiles never fall back to the demo green checker. */
export function regolithGroundBlp(size=64) {
  const out=new Uint8Array(148+1024+size*size),v=new DataView(out.buffer),shades=32;
  out.set([0x42,0x4c,0x50,0x32]);v.setUint32(4,1,true);out[8]=1;v.setUint32(12,size,true);v.setUint32(16,size,true);
  v.setUint32(20,148+1024,true);v.setUint32(84,size*size,true);
  const lo=[88,84,80],hi=[170,162,150];
  for(let i=0;i<shades;i++){const t=i/(shades-1);out.set([0,1,2].map(k=>Math.round(lo[2-k]+(hi[2-k]-lo[2-k])*t)).concat(255),148+i*4);}
  const hash=(x,y)=>{let h=Math.imul(x*374761393+y*668265263,1274126177);h^=h>>>13;h=Math.imul(h,1103515245);return ((h^h>>>16)>>>0)/4294967296;};
  const cell=8,n=size/cell,lat=(x,y)=>hash((x+n)%n,(y+n)%n),smooth=t=>t*t*(3-2*t);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const gx=x/cell,gy=y/cell,ix=Math.floor(gx),iy=Math.floor(gy),fx=smooth(gx-ix),fy=smooth(gy-iy);
    const a=lat(ix,iy)+(lat(ix+1,iy)-lat(ix,iy))*fx,b=lat(ix,iy+1)+(lat(ix+1,iy+1)-lat(ix,iy+1))*fx;
    let s=.35+.45*(a+(b-a)*fy)+.2*(hash(x,y)-.5);
    if(hash(x>>1,y>>1)>.97)s-=.25;
    out[1172+y*size+x]=Math.max(0,Math.min(shades-1,Math.round(s*(shades-1))));
  }
  return out;
}

export function moonSource(seed=MOON_SEED) {
  const base=`world\\maps\\${ELUNE_MAP}\\${ELUNE_MAP}`.toLowerCase(),ground=regolithGroundBlp(),minimap=regolithBlp();
  const files=new Map([[base+'.wdt',moonWdt()],[base+'.wdl',moonWdl(seed)]]);
  const cache=new Map();
  return {
    fingerprint:`elune-procedural-v2-${seed}`,archives:[],stats:{},
    async read(path) {
      const key=path.replaceAll('/','\\').toLowerCase(),hit=files.get(key);
      if(hit)return hit;
      if(key.endsWith('.blp'))return key.includes('minimap')?minimap:ground;
      const m=/^world\\maps\\elune\\elune_(\d+)_(\d+)\.adt$/.exec(key);
      if(m&&present(+m[1],+m[2])){
        if(!cache.has(key)){if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,moonAdt(seed,+m[1],+m[2]));}
        return cache.get(key);
      }
      throw Object.assign(new Error(`File not on Elune: ${path}`),{code:'NOT_FOUND'});
    },
    close() {},
  };
}
