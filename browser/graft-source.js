// Graft source (design/elune.md M9): wraps a body's procedural asset source and, for the body's sites, serves real source-map ADTs translated onto the body's tile grid.
// Tiles in the apron ring are generated procedurally and meet the graft's own edge heights, so there are no cracks. Everything else (textures, models, DBCs) falls through to
// the real data first, then to the body's own source. Game data is only read at runtime.
import {adtChunks,translateAdt,reshapeAdt} from './graft-adt.js';
import {sitesOf,tilesOf,siteRect,siteCentre,siteMask,siteTiles,APRON_AREA} from './elune-sites.js';
import {ADT_TILE,ADT_CHUNK} from './adt-synth.js';
import {moonAdt,moonHeightChart,MOON_TILES_X,MOON_TILES_Y} from './moon-terrain.js';
import {regolithBlp} from './moon-source.js';

const STEP=ADT_CHUNK/8,CX=MOON_TILES_X/2,CY=MOON_TILES_Y/2;
const srcPath=(site,x,y)=>`World\\Maps\\${site.map}\\${site.map}_${x}_${y}.adt`;

/** Outer-vertex height grid of a site's source tiles (absolute heights before any offset): {width,height,data,mean}. */
export function heightGrid(site,bytesOf) {
  const {w,h}=siteTiles(site),width=w*128+1,height=h*128+1,data=new Float32Array(width*height);let sum=0,n=0;
  tilesOf(site).forEach(({sx,sy},idx)=>{
    const bytes=bytesOf[idx],v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),ti=sx-site.source.x[0],tj=sy-site.source.y[0];
    for(const c of adtChunks(bytes)) {
      if(c.magic!=='MCNK')continue;
      const ix=v.getUint32(c.start+4,true),iy=v.getUint32(c.start+8,true),z=v.getFloat32(c.start+0x70,true);
      for(const s of adtChunks(bytes,c.start+128,c.start+c.size)) {
        if(s.magic!=='MCVT')continue;
        for(let k=0;k<9;k++)for(let col=0;col<9;col++) {
          const value=z+v.getFloat32(s.start+(k*17+col)*4,true);
          data[(tj*128+iy*8+k)*width+ti*128+ix*8+col]=value;sum+=value;n++;
        }
      }
    }
  });
  return {width,height,data,mean:n?sum/n:0};
}
/** Bilinear height at chart (x,z), clamped onto the grid, plus `lift`. */
export function sampleGrid(grid,rect,x,z,lift=0) {
  const gx=Math.min(grid.width-1,Math.max(0,(x-rect[0])/STEP)),gz=Math.min(grid.height-1,Math.max(0,(z-rect[1])/STEP));
  const x0=Math.min(grid.width-2,Math.floor(gx)),z0=Math.min(grid.height-2,Math.floor(gz)),fx=gx-x0,fz=gz-z0,d=grid.data,w=grid.width;
  const a=d[z0*w+x0],b=d[z0*w+x0+1],c=d[(z0+1)*w+x0],e=d[(z0+1)*w+x0+1];
  return a+(b-a)*fx+(c-a)*fz+(a-b-c+e)*fx*fz+lift;
}

export const REGOLITH_HASH='00000000000000000000000000e1e0e1.blp';
/** Tiles of the procedural apron ring around a site (not grafted), as [tx,ty]. */
export function apronTiles(site) {
  const rect=siteRect(site,CX,CY),own=new Set(tilesOf(site).map(t=>`${t.dx},${t.dy}`)),out=[];
  for(let ty=0;ty<MOON_TILES_Y;ty++)for(let tx=0;tx<MOON_TILES_X;tx++) {
    if(own.has(`${tx},${ty}`))continue;
    const x0=(tx-CX)*ADT_TILE,z0=(ty-CY)*ADT_TILE;
    if(Math.hypot(Math.max(rect[0]-(x0+ADT_TILE),0,x0-rect[2]),Math.max(rect[1]-(z0+ADT_TILE),0,z0-rect[3]))<site.apron)out.push([tx,ty]);
  }
  return out;
}
/** The minimap translation table plus one row per grafted tile, aliasing the body's tile to the source tile's real minimap so the horizon and globe carry the real colours; apron tiles get a plain regolith minimap. */
export function graftMinimapRows(bytes,sites,mapName) {
  const text=new TextDecoder().decode(bytes),rows=new Map();
  for(const line of text.split('\n')){const [name,hash]=line.trim().split('\t');if(hash)rows.set(name.toLowerCase(),hash);}
  let extra='';
  for(const site of sites) {
    for(const {sx,sy,dx,dy} of tilesOf(site)) {
      const hash=rows.get(`${site.map}\\map${sx}_${sy}.blp`.toLowerCase());
      if(hash)extra+=`${mapName}\\map${dx}_${dy}.blp\t${hash}\n`;
    }
    for(const [tx,ty] of apronTiles(site))extra+=`${mapName}\\map${tx}_${ty}.blp\t${REGOLITH_HASH}\n`;
  }
  return new TextEncoder().encode(text.replace(/\s*$/,'\n')+extra);
}

export function graftSource(base,real,{bodyId,seed}) {
  const sites=sitesOf(bodyId),mapName=bodyId[0].toUpperCase()+bodyId.slice(1),re=new RegExp(`^world\\\\maps\\\\${bodyId}\\\\${bodyId}_(\\d+)_(\\d+)\\.adt$`);
  const trs=`textures\\minimap\\md5translate.trs`;
  const prep=new Map(),cache=new Map();
  const prepare=site=>{
    if(!prep.has(site.id))prep.set(site.id,(async()=>{
      const bytes=await Promise.all(tilesOf(site).map(t=>real.read(srcPath(site,t.sx,t.sy)))),grid=heightGrid(site,bytes),[cx,cz]=siteCentre(site,CX,CY);
      return {bytes,grid,rect:siteRect(site,CX,CY),yOffset:moonHeightChart(seed,cx,cz)-grid.mean};
    })());
    return prep.get(site.id);
  };
  const remember=(key,make)=>{
    if(!cache.has(key)){if(cache.size>=32)cache.delete(cache.keys().next().value);cache.set(key,make());}
    return cache.get(key);
  };
  async function tile(tx,ty) {
    for(const site of sites) {
      const hit=tilesOf(site).findIndex(t=>t.dx===tx&&t.dy===ty);
      if(hit>=0)return remember(`g${tx}_${ty}`,async()=>{
        const p=await prepare(site),t=tilesOf(site)[hit],moved=translateAdt(p.bytes[hit],{from:[t.sx,t.sy],to:[tx,ty],yOffset:p.yOffset});
        // Real terrain ends at the dome circle; beyond it the heights ease into the procedural moon.
        return reshapeAdt(moved,{tile:[tx,ty],cx:CX,cy:CY,height:(x,z,h)=>{const m=siteMask(site,x,z,CX,CY);if(m>=1)return h;const pr=moonHeightChart(seed,x,z);return pr+(h-pr)*m;}});
      });
      const rect=siteRect(site,CX,CY),x0=(tx-CX)*ADT_TILE,z0=(ty-CY)*ADT_TILE;
      const gap=Math.hypot(Math.max(rect[0]-(x0+ADT_TILE),0,x0-rect[2]),Math.max(rect[1]-(z0+ADT_TILE),0,z0-rect[3]));
      if(gap<site.apron)return remember(`a${tx}_${ty}`,async()=>{
        const p=await prepare(site);
        return moonAdt(seed,tx,ty,{area:APRON_AREA,height:(x,z,h)=>{const m=siteMask(site,x,z,CX,CY);return m?h+(sampleGrid(p.grid,p.rect,x,z,p.yOffset)-h)*m:h;}});
      });
    }
  }
  return {
    get fingerprint(){return `${base.fingerprint}+${real.fingerprint}+graft2`;},
    get archives(){return real.archives;},get stats(){return real.stats;},
    async read(path,options) {
      const key=path.replaceAll('/','\\').toLowerCase(),m=re.exec(key);
      // The cache outlives each read and callers may transfer the buffer to another thread, so hand out a copy.
      if(m){const grafted=await tile(+m[1],+m[2]);if(grafted)return grafted.slice();return base.read(path,options);}
      if(key.startsWith(`world\\maps\\${bodyId}\\`))return base.read(path,options);
      if(key===trs)return graftMinimapRows(await real.read(path,options),sites,mapName);
      if(key===`textures\\minimap\\${REGOLITH_HASH}`)return regolithBlp();
      try{return await real.read(path,options);}
      catch(error){if(error?.code!=='NOT_FOUND')throw error;return base.read(path,options);}
    },
    mapName,
    close(){base.close?.();return real.close?.();},
  };
}
