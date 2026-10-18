// Authored terrain work is visual-only; callers pump it outside the collision readiness queue.
export const TERRAIN_TEXTURE_SIZE=256, MINIMAP_SIZE=32, TERRAIN_CACHE_LIMIT=64;
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
    this.tiles=new Map();this.cache=new Map();this.errors=new Map();this.missingMinimaps=new Map();this.far=[];this.farDone=new Set();this.failedFar=[];
    this.loads=0;this.cacheHits=0;this.minimaps=0;this.busy=false;this.generation=0;
  }
  async init(manifest) {
    this.manifest=manifest;
    try {this.catalog=minimapCatalog(await this.source.read('textures\\Minimap\\md5translate.trs'));}
    catch(error){this.errors.set('minimap-catalog',`Minimap catalog: ${error.message||error}`);}
  }
  setTile(index,material) {
    try {
      const paths=JSON.parse(material.paths());
      if(!paths.length||paths.length>64)throw Error('Terrain tile exceeds texture budget');
      this.tiles.set(index,{index,vertices:material.vertices(),indices:material.indices(),
        masks:material.masks(),paths,layers:[],cursor:0,done:false});
      this.errors.delete(`tile:${index}`);
    } finally {material.free();}
  }
  removeTile(index){this.tiles.delete(index);this.errors.delete(`tile:${index}`);}
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
  async pump() {
    if(this.busy)return;
    this.busy=true;
    const generation=this.generation;
    try {
      const tile=[...this.tiles.values()].find(t=>!t.done&&!this.errors.has(`tile:${t.index}`));
      if(tile){
        const path=key(tile.paths[tile.cursor]);
        try {
          let mips=this.cache.get(path);
          if(mips){this.cacheHits++;this.cache.delete(path);}
          else {mips=terrainMips(this.decode(await this.source.read(path)));this.loads++;}
          if(generation!==this.generation)return;
          this.cache.set(path,mips);
          while(this.cache.size>TERRAIN_CACHE_LIMIT)this.cache.delete(this.cache.keys().next().value);
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
        } catch(error){this.errors.set(`tile:${tile.index}`,`Terrain texture ${path}: ${error.message||error}`);}
      }else if(this.catalog&&this.far.length){
        const patch=this.far.shift(),id=`${patch.region}:${patch.x}:${patch.y}`;
        if(this.farDone.has(id))return;
        this.farDone.add(id);
        const map=this.manifest.regions[patch.region].map;
        const path=this.catalog.get(key(`${map}\\map${patch.x}_${patch.y}.blp`));
        if(!path){this.missingMinimaps.set(id,`${map} ${patch.x},${patch.y}`);this.failedFar.push(patch);return;}
        try {
          const texture=this.decode(await this.source.read(path,{background:true}));
          if(generation!==this.generation)return;
          const rgba=resizeRgba(texture.width,texture.height,texture.rgba,MINIMAP_SIZE);
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
      bytes:[...this.cache.values()].reduce((sum,mips)=>sum+mips.reduce((n,m)=>n+m.byteLength,0),0),
      loads:this.loads,cacheHits:this.cacheHits,minimaps:this.minimaps,farPending:this.far.length,
      errors:[...this.errors.values()],missingMinimaps:[...this.missingMinimaps.values()]};
  }
  async retry() {
    this.errors.clear();this.missingMinimaps.clear();
    if(!this.catalog)await this.init(this.manifest);
    for(const patch of this.failedFar)this.farDone.delete(`${patch.region}:${patch.x}:${patch.y}`);
    this.far.push(...this.failedFar);this.failedFar=[];
  }
  clear() {
    this.generation++;this.tiles.clear();this.cache.clear();this.errors.clear();this.missingMinimaps.clear();
    this.far=[];this.farDone.clear();this.failedFar=[];this.catalog=undefined;
  }
}
