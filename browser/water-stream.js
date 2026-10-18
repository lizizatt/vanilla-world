export const COAST_GPU_LIMIT=64*1024*1024;
const TILE=1600/3;

// One staged file and one post-physics parse at a time; no terrain/material construction.
export class WaterStream {
  constructor(source,wasm,manifest,post) {
    Object.assign(this,{source,wasm,manifest,post,limit:COAST_GPU_LIMIT,bytes:0,peakBytes:0,
      loads:0,deferred:0,sourceBytes:0,maxParseMs:0,lastStart:-Infinity,cursor:0,limited:false,closed:false});
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
  pump(now=performance.now()) {
    if(this.closed)return;
    if(this.reorder){
      for(let i=0;i<this.positions.length;i++){
        const p=this.positions[i],dx=Math.max(p[0]-this.point[0],0,this.point[0]-p[0]-TILE),
          dz=Math.max(p[1]-this.point[1],0,this.point[1]-p[1]-TILE);
        this.scores[i]=dx*dx+dz*dz;
      }
      this.order.sort((a,b)=>this.scores[a]-this.scores[b]||a-b);
      this.order.forEach((index,rank)=>{this.ranks[index]=rank;});
      this.cursor=0;this.limited=false;this.reorder=false;
    }
    if(this.pending?.ready){
      const {index,bytes,error}=this.pending;this.pending=undefined;
      const tile=this.manifest.tiles[index];
      try {
        if(error)throw error;
        this.sourceBytes+=bytes.byteLength;
        const start=performance.now(),vertices=this.wasm.coast_liquids(bytes,tile.x,tile.y);
        this.maxParseMs=Math.max(this.maxParseMs,performance.now()-start);this.loads++;
        if(!(vertices instanceof Float32Array)||vertices.length%21||vertices.byteLength>8*1024*1024)
          throw Error('Invalid distant liquid geometry');
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
    if(this.pending||this.limited||now-this.lastStart<50)return;
    while(this.cursor<this.order.length){
      const index=this.order[this.cursor++];
      if(this.cached.has(index)||this.dry.has(index)||this.errors.has(index))continue;
      const tile=this.manifest.tiles[index],region=this.manifest.regions[tile.region];
      const read=this.pending={index,ready:false};this.lastStart=now;
      void this.source.read(`World\\Maps\\${region.map}\\${tile.file}`,{background:true}).then(
        bytes=>{read.bytes=bytes;read.ready=true;},
        error=>{read.error=error;read.ready=true;});
      break;
    }
  }
  snapshot() {
    const next=this.pending?.index??this.order[Math.max(0,this.cursor-(this.limited?1:0))];
    return {resident:this.cached.size,dry:this.dry.size,total:this.order.length,
      pending:this.order.length-this.cached.size-this.dry.size-this.errors.size,
      bytes:this.bytes,peakBytes:this.peakBytes,limit:this.limit,limited:this.limited,
      loads:this.loads,deferred:this.deferred,sourceBytes:this.sourceBytes,maxParseMs:this.maxParseMs,reading:this.pending?.index,
      nextDistance:next===undefined?null:Math.sqrt(this.scores[next]),errors:[...this.errors.values()]};
  }
}
