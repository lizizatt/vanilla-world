// Elune asset source (design/elune.md M2): serves a generated WDT/WDL/ADT set for the map "Elune" from moon-terrain, like demo-source does for the demo world. No game data.
import {chunk,join,ver,demoBlp} from './demo-source.js';
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

export function moonSource(seed=MOON_SEED) {
  const base=`world\\maps\\${ELUNE_MAP}\\${ELUNE_MAP}`.toLowerCase(),blp=demoBlp();
  const files=new Map([[base+'.wdt',moonWdt()],[base+'.wdl',moonWdl(seed)]]);
  const cache=new Map();
  return {
    fingerprint:`elune-procedural-v1-${seed}`,archives:[],stats:{},
    async read(path) {
      const key=path.replaceAll('/','\\').toLowerCase(),hit=files.get(key);
      if(hit)return hit;
      if(key.endsWith('.blp'))return blp;
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
