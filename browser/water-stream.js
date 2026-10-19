import {worldLiquids} from './world-store.js';
export const COAST_GPU_LIMIT=64*1024*1024;
const TILE=1600/3;

export function deepOceanBacking(bytes,exteriorEdges,sea=0) {
  if(!exteriorEdges)return new Float32Array();
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),out=[];
  const tag=(p,name)=>p>=0&&p+4<=bytes.length&&[...name].every((c,i)=>bytes[p+i]===c.charCodeAt(0));
  if(bytes.length<12||!tag(0,'REVM')||data.getUint32(8,true)!==18)throw Error('Invalid ocean backing ADT');
  for(let offset=12;offset<bytes.length;){
    if(offset+8>bytes.length)throw Error('Truncated ocean backing chunk');
    const base=offset+8,end=base+data.getUint32(offset+4,true),terrain=tag(offset,'KNCM');offset=end;
    if(end>bytes.length)throw Error('Truncated ocean backing payload');
    if(!terrain)continue;
    if(end-base<128)throw Error('Truncated ocean backing MCNK');
    const x=data.getUint32(base+4,true),y=data.getUint32(base+8,true);
    if(x>=16||y>=16)throw Error('Invalid ocean backing MCNK coordinate');
    const edges=exteriorEdges&((x===0?1:0)|(x===15?2:0)|(y===0?4:0)|(y===15?8:0));
    const flags=data.getUint32(base,true);
    if(!edges||!(flags&8)||data.getUint16(base+0x3c,true))continue;
    const sub=(field,name,needed)=>{
      const ofs=data.getUint32(base+field,true);
      const start=[base+ofs,base+ofs-8].find(p=>p>=base+128&&tag(p,name));
      if(start===undefined||start+8+needed>end)throw Error(`Invalid ocean backing ${name}`);
      return start+8;
    };
    const heights=sub(0x14,'TVCM',145*4),floor=data.getFloat32(base+0x70,true);
    let deep=Number.isFinite(floor);
    for(let i=0;i<145;i++){
      const h=floor+data.getFloat32(heights+i*4,true);
      if(!Number.isFinite(h)||h>=sea-32)deep=false;
    }
    const count=[4,8,16,32].filter(bit=>flags&bit).length;
    const liquid=sub(0x60,'QLCM',count*804);
    for(let block=0;block<count;block++){
      const start=liquid+block*804,cells=bytes.subarray(start+656,start+720);
      if(!cells.some(c=>(c&15)===15)||!cells.every(c=>[1,15].includes(c&15)))continue;
      let flat=true;
      for(let i=0;i<81;i++)if(data.getFloat32(start+12+i*8,true)!==sea)flat=false;
      const wet=i=>(cells[i]&15)===1;
      const connected=[0,1,2,3].some(edge=>(edges&(1<<edge))&&
        Array.from({length:8},(_,i)=>edge===0?i*8:edge===1?i*8+7:edge===2?i:56+i).every(wet));
      if(!flat||!connected)continue;
      const exterior=new Uint8Array(64),queue=[];
      const seed=i=>{if(wet(i)&&!exterior[i]){exterior[i]=1;queue.push(i);}};
      for(let i=0;i<8;i++){
        if(edges&1)seed(i*8);if(edges&2)seed(i*8+7);
        if(edges&4)seed(i);if(edges&8)seed(56+i);
      }
      for(let cursor=0;cursor<queue.length;cursor++){
        const i=queue[cursor],col=i%8,row=Math.floor(i/8);
        if(col)seed(i-1);if(col<7)seed(i+1);if(row)seed(i-8);if(row<7)seed(i+8);
      }
      const bounded=(col,row,dx,dy)=>{
        const ends=[];
        for(const sign of [-1,1]){
          let a=col+dx*sign,b=row+dy*sign;
          while(a>=0&&a<8&&b>=0&&b<8&&!wet(b*8+a)){a+=dx*sign;b+=dy*sign;}
          if(a<0||a>=8||b<0||b>=8)return false;
          ends.push(b*8+a);
        }
        return ends.some(i=>exterior[i]);
      };
      const fill=new Uint8Array(64);
      for(let row=0;row<8;row++)for(let col=0;col<8;col++){
        const i=row*8+col;
        if(wet(i))continue;
        const p=row*17+col;
        const submerged=[p,p+1,p+17,p+18,p+9].every(vertex=>{
          const h=floor+data.getFloat32(heights+vertex*4,true);
          return Number.isFinite(h)&&h<=sea+.01;
        });
        // Sea-level placeholder strips need ocean on both sides and a wet path to the exterior.
        if(deep||submerged&&(bounded(col,row,1,0)||bounded(col,row,0,1)))fill[i]=1;
      }
      for(let row=0;row<8;row++)for(let col=0;col<8;col++){
        if(!fill[row*8+col])continue;
        let width=1,height=1;
        while(col+width<8&&fill[row*8+col+width])width++;
        while(row+height<8&&Array.from({length:width},(_,i)=>fill[(row+height)*8+col+i]).every(Boolean))height++;
        for(let r=row;r<row+height;r++)fill.fill(0,r*8+col,r*8+col+width);
        const a=(x*8+col)*TILE/128,b=(y*8+row)*TILE/128;
        const c=(x*8+col+width)*TILE/128,d=(y*8+row+height)*TILE/128;
        for(const [px,pz] of [[a,b],[c,b],[c,d],[a,b],[c,d],[a,d]])out.push(px,sea,pz,0,1,0,4);
      }
      break;
    }
  }
  return new Float32Array(out);
}

export function validLiquidGeometry(vertices) {
  return vertices instanceof Float32Array && vertices.length%21===0 && vertices.byteLength<=8*1024*1024
    && vertices.every((v,i)=>Number.isFinite(v)&&(i%7===0||i%7===2?v>=-.02&&v<=TILE+.02:
      i%7===1?Math.abs(v)<1e9:i%7===6?v===2||v===4:v===[0,1,0][i%7-3]));
}

// One staged file and one post-physics parse at a time; no terrain/material construction.
export class WaterStream {
  constructor(source,wasm,manifest,post) {
    Object.assign(this,{source,wasm,manifest,post,limit:COAST_GPU_LIMIT,bytes:0,peakBytes:0,
      loads:0,deferred:0,sourceBytes:0,maxParseMs:0,cursor:0,limited:false,closed:false,cacheHits:0});
    this.cacheEnabled=!!source.fingerprint;this.cacheMisses=new Set();this.coastal=new Set();
    this.cached=new Map();this.dry=new Set();this.errors=new Map();
    this.exterior=new Set();
    this.order=manifest.tiles.map((_,i)=>i);
    this.ranks=new Uint32Array(this.order.length);this.scores=new Float64Array(this.order.length);
    this.positions=manifest.tiles.map(t=>{
      const r=manifest.regions[t.region];
      return [r.placement[0]+(t.x-r.tile_origin[0])*TILE,r.placement[1]+(t.y-r.tile_origin[1])*TILE];
    });
    this.setFocus(manifest.spawn);
  }
  setExterior(region,vertices) {
    for(let i=0;i<vertices.length;i+=42)this.exterior.add(`${region}:${Math.round(vertices[i]/TILE)}:${Math.round(vertices[i+2]/TILE)}`);
  }
  exteriorEdges(tile) {
    return [[-1,0],[1,0],[0,-1],[0,1]].reduce((mask,[dx,dy],edge)=>
      this.exterior.has(`${tile.region}:${tile.x+dx}:${tile.y+dy}`)?mask|(1<<edge):mask,0);
  }
  setFocus(p) {
    const key=`${Math.floor(p[0]/TILE)}:${Math.floor(p[2]/TILE)}`;
    if(key===this.key)return;
    this.key=key;this.point=[p[0],p[2]];this.reorder=true;
  }
  clear() {this.closed=true;this.pending=undefined;this.cached.clear();this.dry.clear();this.errors.clear();this.exterior.clear();}
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
        const start=performance.now();let vertices=cached??this.wasm.coast_liquids(bytes,tile.x,tile.y);
        if(!cached&&vertices.length){
          const backing=deepOceanBacking(bytes,this.exteriorEdges(tile),this.manifest.sea_level??0);
          if(backing.length){
            const combined=new Float32Array(vertices.length+backing.length);
            combined.set(vertices);combined.set(backing,vertices.length);vertices=combined;
          }
        }
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
