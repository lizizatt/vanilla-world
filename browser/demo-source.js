// Procedural demo world: a virtual asset source that serves generated WDT/WDL/ADT files, so the hosted build runs with no game data.
import {synthAdt,ADT_TILE} from './adt-synth.js';

const MAPS={Kalimdor:{centre:[39,43]},Azeroth:{centre:[28,51]}},REACH=2;
const DEMO_ID='demo-procedural-v1';

/** Island height in yd at tile-space coordinates (tiles, fractional) for a map. */
export function demoHeight(map,tx,ty) {
  const [cx,cy]=MAPS[map].centre,d=Math.hypot(tx-cx-.5,ty-cy-.5)/(REACH+.5),k=Math.max(0,1-d*d);
  return 90*(1-d*d)-8+14*Math.sin(tx*7.3)*Math.cos(ty*5.1)*(k>0?1:0);
}

export const chunk=(magic,body)=>{const out=new Uint8Array(8+body.length),v=new DataView(out.buffer);
  for(let i=0;i<4;i++)out[i]=magic.charCodeAt(3-i);v.setUint32(4,body.length,true);out.set(body,8);return out;};
export const join=parts=>{const out=new Uint8Array(parts.reduce((n,a)=>n+a.length,0));let p=0;for(const a of parts){out.set(a,p);p+=a.length;}return out;};
export const ver=()=>{const b=new Uint8Array(4);b[0]=18;return chunk('MVER',b);};
const present=(map,x,y)=>{const [cx,cy]=MAPS[map].centre;return Math.abs(x-cx)<=REACH&&Math.abs(y-cy)<=REACH;};

/** Palettized BLP2, size x size, two-tone grass-like checker; stands in for every texture the world asks for. */
export function demoBlp(size=64) {
  const out=new Uint8Array(148+1024+size*size),v=new DataView(out.buffer);
  out.set([0x42,0x4c,0x50,0x32]);v.setUint32(4,1,true);out[8]=1;v.setUint32(12,size,true);v.setUint32(16,size,true);
  v.setUint32(20,148+1024,true);v.setUint32(84,size*size,true);
  out.set([70,110,60,255],148);out.set([90,130,70,255],152);// BGRA
  for(let i=0;i<size*size;i++)out[1172+i]=((i%size>>3)+(i/size>>3))&1;
  return out;
}

export function demoWdt(map) {
  const main=new Uint8Array(4096*8);
  for(let i=0;i<4096;i++)if(present(map,i%64,i>>6))main[i*8]=1;
  return join([ver(),chunk('MPHD',new Uint8Array(32)),chunk('MAIN',main)]);
}

export function demoWdl(map) {
  const maof=new Uint8Array(4096*4),mv=new DataView(maof.buffer),tiles=[];
  let at=ver().length+8+4096*4;
  for(let i=0;i<4096;i++) {
    const x=i%64,y=i>>6;if(!present(map,x,y))continue;
    const h=new Uint8Array(545*2),hv=new DataView(h.buffer);
    for(let r=0;r<17;r++)for(let c=0;c<17;c++)hv.setInt16((r*17+c)*2,Math.round(demoHeight(map,x+c/16,y+r/16)),true);
    for(let r=0;r<16;r++)for(let c=0;c<16;c++)hv.setInt16((289+r*16+c)*2,Math.round(demoHeight(map,x+(c+.5)/16,y+(r+.5)/16)),true);
    mv.setUint32(i*4,at,true);const mare=chunk('MARE',h);tiles.push(mare);at+=mare.length;
  }
  return join([ver(),chunk('MAOF',maof),...tiles]);
}

export function demoSource() {
  const files=new Map(),blp=demoBlp(),notFound=path=>Object.assign(new Error(`File not in demo world: ${path}`),{code:'NOT_FOUND'});
  for(const map of Object.keys(MAPS)) {
    files.set(`world\\maps\\${map}\\${map}.wdt`.toLowerCase(),demoWdt(map));
    files.set(`world\\maps\\${map}\\${map}.wdl`.toLowerCase(),demoWdl(map));
  }
  return {
    fingerprint:DEMO_ID,archives:[],stats:{},
    async read(path) {
      const key=path.replaceAll('/','\\').toLowerCase(),hit=files.get(key);
      if(hit)return hit;
      if(key.endsWith('.blp'))return blp;
      const m=/^world\\maps\\(kalimdor|azeroth)\\\w+_(\d+)_(\d+)\.adt$/.exec(key);
      if(m) {
        const map=m[1]==='kalimdor'?'Kalimdor':'Azeroth',x=+m[2],y=+m[3];
        if(present(map,x,y))return synthAdt((lx,lz)=>demoHeight(map,x+lx/ADT_TILE,y+lz/ADT_TILE),x,y);
      }
      throw notFound(path);
    },
    close() {},
  };
}
