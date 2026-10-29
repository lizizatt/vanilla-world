// Authored terrain work is visual-only; callers pump it outside the collision readiness queue.
import {BudgetedCache} from './memory-budget.js';
import {farMinimap} from './world-store.js';
export const TERRAIN_TEXTURE_SIZE=256, MINIMAP_SIZE=32, TERRAIN_CACHE_LIMIT=64;
export const TERRAIN_MIP_BYTES=349524,TERRAIN_CACHE_BYTES=TERRAIN_CACHE_LIMIT*TERRAIN_MIP_BYTES;
const mipBytes=mips=>mips.reduce((n,m)=>n+m.byteLength,0);
const key=path=>path.replaceAll('/','\\').toLowerCase();

export function resizeRgba(width,height,rgba,size) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>2048||height>2048||
    rgba.length!==width*height*4||!Number.isInteger(size)||size<1||size>256)throw Error('Invalid bounded terrain texture');
  const out=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const x0=Math.floor(x*width/size),x1=Math.max(x0+1,Math.floor((x+1)*width/size));
    const y0=Math.floor(y*height/size),y1=Math.max(y0+1,Math.floor((y+1)*height/size));
    const sum=[0,0,0,0];
    for(let row=y0;row<y1;row++)for(let col=x0;col<x1;col++)
      for(let c=0;c<4;c++)sum[c]+=rgba[(row*width+col)*4+c];
    for(let c=0;c<4;c++)out[(y*size+x)*4+c]=Math.round(sum[c]/((x1-x0)*(y1-y0)));
  }
  return out;
}
export function terrainMips(texture) {
  const mips=[resizeRgba(texture.width,texture.height,texture.rgba,TERRAIN_TEXTURE_SIZE)];
  for(let size=TERRAIN_TEXTURE_SIZE;size>1;size/=2)mips.push(resizeRgba(size,size,mips.at(-1),size/2));
  return mips;
}
export function minimapCatalog(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),entries=new Map();
  for(const raw of text.split('\n')){
    const line=raw.trim();
    if(!line||line.startsWith('dir:'))continue;
    const [name,hash,...rest]=line.split('\t');
    if(rest.length||!name||!/^[a-f\d]{32}\.blp$/i.test(hash))throw Error('Invalid minimap translation row');
    entries.set(key(name),`textures\\Minimap\\${hash}`);
  }
  if(!entries.size)throw Error('Empty minimap translation catalog');
  return entries;
}

export class TerrainStream {
  constructor(source,wasm,emit) {
    this.source=source;this.wasm=wasm;this.emit=emit;
    this.tiles=new Map();this.cache=new BudgetedCache(TERRAIN_CACHE_BYTES);this.errors=new Map();this.missingMinimaps=new Map();this.far=[];this.farDone=new Set();this.failedFar=[];
    this.farMisses=new Set();this.cachedMinimaps=0;this.farCacheOff=false;
    this.loads=0;this.cacheHits=0;this.minimaps=0;this.busy=false;this.generation=0;
    this.preparing=new Map();
  }
  async init(manifest) {
    this.manifest=manifest;
    const generation=this.generation,shouldDefer=()=>generation!==this.generation;
    try {
      const bytes=await this.source.read('textures\\Minimap\\md5translate.trs',{shouldDefer});
      if(!shouldDefer())this.catalog=minimapCatalog(bytes);
    }
    catch(error){if(!shouldDefer())this.errors.set('minimap-catalog',`Minimap catalog: ${error.message||error}`);}
  }
  setTile(index,material) {
    this.preparing.delete(index);
    try {
      const parts=this.materialParts(index,material);let result;
      do{result=parts.next();}while(!result.done);
      this.tiles.set(index,result.value);
      this.errors.delete(`tile:${index}`);
    } finally {material.free();}
  }
  *materialParts(index,material) {
    const paths=JSON.parse(material.paths());
    if(!paths.length||paths.length>64)throw Error('Terrain tile exceeds texture budget');
    const tile={index,paths,layers:[],cursor:0,done:false};
    for(const name of ['vertices','indices','masks']){tile[name]=material[name]();yield;}
    return tile;
  }
  async prepareTile(index,material,step) {
    const token={};this.preparing.set(index,token);
    try {
      const parts=this.materialParts(index,material);let building=!!step;
      for(;;){
        if(this.yieldMaterial)await this.yieldMaterial();
        else if(globalThis.scheduler?.postTask)await scheduler.postTask(()=>{},{priority:'background'});
        else await new Promise(resolve=>setTimeout(resolve,0));
        if(this.preparing.get(index)!==token)return;
        if(building){
          const start=performance.now();
          for(let i=0;i<16&&performance.now()-start<4;i++)if(step()){building=false;break;}
          continue;
        }
        const result=parts.next();
        if(result.done){this.tiles.set(index,result.value);this.errors.delete(`tile:${index}`);return;}
      }
    } finally {
      if(this.preparing.get(index)===token)this.preparing.delete(index);
      material.free();
    }
  }
  removeTile(index){this.preparing.delete(index);this.tiles.delete(index);this.errors.delete(`tile:${index}`);}
  addHorizon(region,x,y){this.far.push({region,x,y});}
  prioritize(region,x,y) {
    this.far.sort((a,b)=>(a.region===region?0:10000)+Math.hypot(a.x-x,a.y-y)-
      (b.region===region?0:10000)-Math.hypot(b.x-x,b.y-y));
  }
  decode(bytes) {
    const texture=new this.wasm.SceneTexture(bytes);
    try{return {...JSON.parse(texture.metadata()),rgba:texture.rgba()};}
    finally{texture.free();}
  }
  /** Emits up to 64 locally cached minimaps at once so the whole far horizon is coloured from the first frames on a repeat visit. Returns whether any were applied. */
  async drainCachedFar(generation) {
    if(!this.far.length||!this.source.fingerprint||this.farCacheOff)return false;
    const batch=[];
    for(const patch of this.far){
      if(batch.length>=64)break;
      const id=`${patch.region}:${patch.x}:${patch.y}`;
      if(!this.farMisses.has(id)&&!this.farDone.has(id))batch.push([id,patch]);
    }
    if(!batch.length)return false;
    const found=await Promise.all(batch.map(([id])=>farMinimap(this.source.fingerprint,id).catch(()=>{this.farCacheOff=true;})));
    if(generation!==this.generation)return false;
    let hit=false;
    batch.forEach(([id,patch],i)=>{
      const rgba=found[i];
      if(!(rgba instanceof Uint8Array)||rgba.length!==MINIMAP_SIZE*MINIMAP_SIZE*4){this.farMisses.add(id);return;}
      if(this.farDone.has(id))return;
      this.farDone.add(id);this.far=this.far.filter(p=>p!==patch);
      this.emit({event:'horizon-material',...patch,rgba},[rgba.buffer]);this.minimaps++;this.cachedMinimaps++;hit=true;
    });
    return hit;
  }
  async pump() {
    if(this.busy)return;
    this.busy=true;
    const generation=this.generation;
    try {
      if(!this.nearOnly&&this.far.length&&this.source.fingerprint&&!this.farCacheOff){
        if(await this.drainCachedFar(generation))return true;
        if(generation!==this.generation)return;
      }
      const tile=[...this.tiles.values()].find(t=>!t.done&&!this.errors.has(`tile:${t.index}`));
      if(tile){
        const path=key(tile.paths[tile.cursor]);
        const shouldDefer=()=>generation!==this.generation||this.tiles.get(tile.index)!==tile;
        try {
          let mips=this.cache.get(path);
          if(mips){this.cacheHits++;}
          else {
            mips=this.source.readTexture?(await this.source.readTexture(path,'mips',shouldDefer)).mips
              :terrainMips(this.decode(await this.source.read(path,{shouldDefer})));
            this.loads++;
          }
          if(generation!==this.generation)return;
          this.cache.set(path,mips,mipBytes(mips));
          if(this.tiles.get(tile.index)!==tile)return;
          tile.layers.push({mips});tile.cursor++;
          if(tile.cursor===tile.paths.length){
            const layers=tile.layers.map(layer=>({mips:layer.mips.map(m=>m.slice())}));
            const message={event:'terrain-material',index:tile.index,vertices:tile.vertices,
              indices:tile.indices,masks:tile.masks,layers};
            this.emit(message,[message.vertices.buffer,message.indices.buffer,message.masks.buffer,
              ...layers.flatMap(l=>l.mips.map(m=>m.buffer))]);
            tile.done=true;tile.vertices=tile.indices=tile.masks=tile.layers=undefined;
          }
        } catch(error){
          if(generation!==this.generation)return;
          if(error.code==='DEFERRED')return true;
          this.errors.set(`tile:${tile.index}`,`Terrain texture ${path}: ${error.message||error}`);
        }
      }else if(!this.nearOnly&&this.catalog&&this.far.length){
        const patch=this.far.shift(),id=`${patch.region}:${patch.x}:${patch.y}`;
        if(this.farDone.has(id))return;
        this.farDone.add(id);
        const map=this.manifest.regions[patch.region].map;
        const path=this.catalog.get(key(`${map}\\map${patch.x}_${patch.y}.blp`));
        if(!path){this.missingMinimaps.set(id,`${map} ${patch.x},${patch.y}`);this.failedFar.push(patch);return;}
        try {
          const shouldDefer=()=>generation!==this.generation;
          const texture=this.source.readTexture?await this.source.readTexture(path,'minimap',shouldDefer)
            :this.decode(await this.source.read(path,{background:true,shouldDefer}));
          if(generation!==this.generation)return;
          const rgba=this.source.readTexture?texture.rgba:resizeRgba(texture.width,texture.height,texture.rgba,MINIMAP_SIZE);
          if(this.source.fingerprint&&!this.farCacheOff)farMinimap(this.source.fingerprint,`${patch.region}:${patch.x}:${patch.y}`,rgba.slice()).catch(()=>{this.farCacheOff=true;});
          this.emit({event:'horizon-material',...patch,rgba},[rgba.buffer]);this.minimaps++;
        }catch(error){
          if(generation!==this.generation)return;
          if(error.code==='DEFERRED'){this.farDone.delete(id);this.far.unshift(patch);return true;}
          this.errors.set(id,`Minimap ${map} ${patch.x},${patch.y}: ${error.message||error}`);this.failedFar.push(patch);
        }
      }
    }finally{this.busy=false;}
    return [...this.tiles.values()].some(t=>!t.done&&!this.errors.has(`tile:${t.index}`));
  }
  snapshot() {
    return {pending:[...this.tiles.values()].filter(t=>!t.done).length,cache:this.cache.size,
      bytes:this.cache.bytes,limit:this.cache.budget.limit,evictions:this.cache.budget.evictions,
      loads:this.loads,cacheHits:this.cacheHits,minimaps:this.minimaps,cachedMinimaps:this.cachedMinimaps,farPending:this.far.length,
      errors:[...this.errors.values()],missingMinimaps:[...this.missingMinimaps.values()]};
  }
  setBudget(bytes) {this.cache.setLimit(Math.max(bytes,8*TERRAIN_MIP_BYTES));}
  async retry() {
    this.errors.clear();this.missingMinimaps.clear();
    if(!this.catalog)await this.init(this.manifest);
    for(const patch of this.failedFar)this.farDone.delete(`${patch.region}:${patch.x}:${patch.y}`);
    this.far.push(...this.failedFar);this.failedFar=[];
  }
  clear() {
    this.preparing.clear();
    this.generation++;this.tiles.clear();this.cache.clear();this.errors.clear();this.missingMinimaps.clear();
    this.far=[];this.farDone.clear();this.farMisses.clear();this.failedFar=[];this.catalog=undefined;
  }
}
