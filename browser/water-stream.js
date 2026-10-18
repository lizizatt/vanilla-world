import {worldLiquids} from './world-store.js';
export const COAST_GPU_LIMIT=64*1024*1024;
const TILE=1600/3;

export function validLiquidGeometry(vertices) {
  return vertices instanceof Float32Array && vertices.length%21===0 && vertices.byteLength<=8*1024*1024
    && vertices.every((v,i)=>Number.isFinite(v)&&(i%7===0||i%7===2?v>=-.02&&v<=TILE+.02:
      i%7===1?Math.abs(v)<1e9:v===[0,1,0,2][i%7-3]));
}

// One staged file and one post-physics parse at a time; no terrain/material construction.
export class WaterStream {
  constructor(source,wasm,manifest,post) {
    Object.assign(this,{source,wasm,manifest,post,limit:COAST_GPU_LIMIT,bytes:0,peakBytes:0,
      loads:0,deferred:0,sourceBytes:0,maxParseMs:0,cursor:0,limited:false,closed:false,cacheHits:0});
    this.cacheEnabled=!!source.fingerprint;this.cacheMisses=new Set();this.coastal=new Set();
    this.cached=new Map();this.dry=new Set();this.errors=new Map();
    this.order=manifest.tiles.map((_,i)=>i);
    this.ranks=new Uint32Array(this.order.length);this.scores=new Float64Array(this.order.length);
    this.positions=manifest.tiles.map(t=>{
      const r=manifest.regions[t.region];
      return [r.placement[0]+(t.x-r.tile_origin[0])*TILE,r.placement[1]+(t.y-r.tile_origin[1])*TILE];
    });
    this.setFocus(manifest.spawn);
  }
  setFocus(p) {
    const key=`${Math.floor(p[0]/TILE)}:${Math.floor(p[2]/TILE)}`;
    if(key===this.key)return;
    this.key=key;this.point=[p[0],p[2]];this.reorder=true;
  }
  clear() {this.closed=true;this.pending=undefined;this.cached.clear();this.dry.clear();this.errors.clear();}
  retry() {this.errors.clear();this.cursor=0;this.limited=false;}
  coastalTile(index) {if(index>=0){this.coastal.add(index);this.reorder=true;}}
  cacheFailure(error) {
    this.cacheEnabled=false;
    this.cacheError=`Local water cache unavailable; reading authored Data instead: ${error.message||error}`;
  }
  pump() {
    if(this.closed)return;
    if(this.reorder){
      for(let i=0;i<this.positions.length;i++){
        const p=this.positions[i],dx=Math.max(p[0]-this.point[0],0,this.point[0]-p[0]-TILE),
          dz=Math.max(p[1]-this.point[1],0,this.point[1]-p[1]-TILE);
        this.scores[i]=dx*dx+dz*dz;
      }
      const band=i=>this.scores[i]<TILE*TILE?0:this.coastal.has(i)?1:2;
      this.order.sort((a,b)=>band(a)-band(b)||this.scores[a]-this.scores[b]||a-b);
      this.order.forEach((index,rank)=>{this.ranks[index]=rank;});
      this.cursor=0;this.limited=false;this.reorder=false;
    }
    if(this.pending?.ready){
      const {index,bytes,cached,error}=this.pending;this.pending=undefined;
      const tile=this.manifest.tiles[index];
      try {
        if(error)throw error;
        const start=performance.now(),vertices=cached??this.wasm.coast_liquids(bytes,tile.x,tile.y);
        if(cached)this.cacheHits++;
        else {
          this.sourceBytes+=bytes.byteLength;this.loads++;
          this.maxParseMs=Math.max(this.maxParseMs,performance.now()-start);
        }
        if(!validLiquidGeometry(vertices))
          throw Error('Invalid distant liquid geometry');
        if(!cached&&this.cacheEnabled) {
          const write=worldLiquids(this.source.fingerprint,`${tile.region}:${tile.x}:${tile.y}`,vertices.slice())
            .catch(error=>this.cacheFailure(error));
          this.cacheWrite=write;
          void write.finally(()=>{if(this.cacheWrite===write)this.cacheWrite=undefined;});
        }
        if(!vertices.length){this.dry.add(index);return;}
        const removed=[];let size=this.bytes+vertices.byteLength;
        for(let rank=this.order.length-1;size>this.limit&&rank>this.ranks[index];rank--){
          const old=this.order[rank],bytes=this.cached.get(old);
          if(bytes){removed.push(old);size-=bytes;}
        }
        if(size>this.limit){this.limited=true;return;}
        const length=vertices.byteLength;
        this.post({event:'coast-water',index,removed,vertices},[vertices.buffer]);
        for(const old of removed)this.cached.delete(old);
        this.cached.set(index,length);this.bytes=size;this.peakBytes=Math.max(this.peakBytes,size);
      } catch(error) {
        if(error.code==='DEFERRED'){this.deferred++;this.cursor=0;return;}
        this.errors.set(index,`Distant water ${tile.file}: ${error.code||'PARSE'} ${error.message||error}`);
      }
      return;
    }
    if(this.pending||this.cacheWrite||this.limited)return;
    while(this.cursor<this.order.length){
      const index=this.order[this.cursor++];
      if(this.cached.has(index)||this.dry.has(index)||this.errors.has(index))continue;
      const tile=this.manifest.tiles[index],region=this.manifest.regions[tile.region];
      const read=this.pending={index,ready:false};
      void (async()=>{
        if(this.cacheEnabled&&!this.cacheMisses.has(index)) {
          try {
            const cached=await worldLiquids(this.source.fingerprint,`${tile.region}:${tile.x}:${tile.y}`);
            if(cached!==undefined) {
              if(!validLiquidGeometry(cached))throw Error(`Damaged cached water for ${tile.file}`);
              read.cached=cached;return;
            }
            this.cacheMisses.add(index);
          } catch(error){this.cacheFailure(error);}
        }
        if(!this.closed)read.bytes=await this.source.read(`World\\Maps\\${region.map}\\${tile.file}`,{background:true});
      })().catch(error=>{read.error=error;}).finally(()=>{read.ready=true;});
      break;
    }
  }
  snapshot() {
    const next=this.pending?.index??this.order[Math.max(0,this.cursor-(this.limited?1:0))];
    return {resident:this.cached.size,dry:this.dry.size,total:this.order.length,
      pending:this.order.length-this.cached.size-this.dry.size-this.errors.size,
      bytes:this.bytes,peakBytes:this.peakBytes,limit:this.limit,limited:this.limited,
      loads:this.loads,deferred:this.deferred,sourceBytes:this.sourceBytes,maxParseMs:this.maxParseMs,reading:this.pending?.index,
      cacheHits:this.cacheHits,cacheError:this.cacheError,
      nextDistance:next===undefined?null:Math.sqrt(this.scores[next]),errors:[...this.errors.values()]};
  }
}
