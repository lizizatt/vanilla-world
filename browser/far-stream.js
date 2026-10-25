import {SceneStream,SCENE_LIMITS,SCENE_CEILING} from './scene-stream.js';
import {ByteBudget} from './memory-budget.js';
import {validateView,viewChanged} from './world-view.js';

export const FAR_LIMITS=Object.freeze({assets:96,textures:96,bytes:32*1024*1024,instances:256,jobs:1});
const TILE=1600/3;
const keyOf=t=>`${t.region===0?1:0}:${t.x}:${t.y}`;
const visualKey=key=>`far:${key}`;

// This cache is visual-only. No far-worker result can declare a collision ready.
export class FarStream {
  constructor(source,wasm,manifest,send,memory=()=>0) {
    this.source=source;this.manifest=manifest;this.send=send;this.memory=memory;
    this.scene=new SceneStream(source,wasm,FAR_LIMITS);this.scene.visualOnly=true;
    this.scene.discovered=new Map();
    this.resident=new Set();this.failures=new Map();this.wanted=[];
    this.tileBytes=new Map();this.tileBudget=undefined;this.tileLimit=SCENE_LIMITS.distantTiles;this.blocked=new Set();this.wantedKey='';this.evictions=0;
    this.sentAssets=new Set();this.sentTextures=new Set();this.sentInstances=new Map();this.serial=0;this.reset=true;
    this.loads=0;this.peak=0;this.wasmPeakBytes=0;this.selectionMs=0;
    this.publications=0;this.transferPeakBytes=0;
    this.positions=manifest.tiles.map(t=>{
      const r=manifest.regions[t.region];
      return [r.placement[0]+(t.x-r.tile_origin[0])*TILE,r.placement[1]+(t.y-r.tile_origin[1])*TILE];
    });
  }
  focus({epoch,region,position,enabled,view}) {
    if(!Number.isSafeInteger(epoch)||![0,1].includes(region)||!Array.isArray(position)||
      position.length!==3||!position.every(Number.isFinite)||typeof enabled!=='boolean')
      throw Error('Invalid distant worker focus');
    if(view!==undefined)validateView(view);
    if(this.region!==undefined && region!==this.region) {
      this.scene.clear();this.resident.clear();this.tileBytes.clear();if(this.tileBudget)this.tileBudget.used=0;this.blocked.clear();this.failures.clear();this.reset=true;
    } else if(epoch!==this.epoch) {
      this.scene.generation++;
    }
    if(epoch!==this.epoch)this.reset=true;
    this.epoch=epoch;this.region=region;this.position=position;this.enabled=enabled;
    const r=this.manifest.regions[region],toSource=v=>[-v[2],-v[0],v[1]];
    const nextView=view?{...view,right:toSource(view.right),up:toSource(view.up),look:toSource(view.look),
      eye:[-view.eye[2]+r.placement[1]+(32-r.tile_origin[1])*TILE,
        -view.eye[0]+r.placement[0]+(32-r.tile_origin[0])*TILE,view.eye[1]]}:undefined;
    if(viewChanged(this.scene.view,nextView))this.scene.revision++;
    this.scene.view=nextView;
    if(!enabled){this.wanted=[];return;}
    const distance=i=>{
      const p=this.positions[i];
      return Math.hypot(Math.max(p[0]-position[0],0,position[0]-p[0]-TILE),
        Math.max(p[1]-position[2],0,position[2]-p[1]-TILE));
    };
    this.wanted=this.manifest.tiles.map((t,i)=>({t,i,distance:t.region===region?distance(i):Infinity}))
      .filter(t=>t.distance<SCENE_LIMITS.distantRadius).sort((a,b)=>a.distance-b.distance)
      .slice(0,this.tileLimit).map(t=>t.i);
    if(view){
      const behind=i=>{
        const p=this.positions[i];
        return (p[0]+TILE/2-view.eye[0])*view.look[0]+(p[1]+TILE/2-view.eye[2])*view.look[2]<-TILE;
      };
      this.wanted.sort((a,b)=>Number(behind(a))-Number(behind(b))||distance(a)-distance(b));
    }
    const wantedKey=this.wanted.join();
    if(wantedKey!==this.wantedKey){this.wantedKey=wantedKey;this.blocked.clear();}
    for(const index of this.resident)if(!this.wanted.includes(index))this.dropTile(index);
  }
  dropTile(index) {
    this.scene.removeDistantTile(keyOf(this.manifest.tiles[index]));this.resident.delete(index);
    this.tileBudget?.remove(this.tileBytes.get(index)||0);this.tileBytes.delete(index);
  }
  /** Tile metadata admission: past the limit, evict farther tiles down to the target; never displace nearer ones. */
  admitTile(index,size) {
    const budget=this.tileBudget;if(!budget)return true;
    let need=budget.deficit(size);if(!need)return true;
    const rank=i=>this.wanted.indexOf(i),mine=rank(index);
    const victims=[...this.resident].filter(i=>rank(i)>mine).sort((a,b)=>rank(b)-rank(a));
    if(budget.used-victims.reduce((n,i)=>n+(this.tileBytes.get(i)||0),0)+size>budget.limit)return false;
    for(const i of victims){if(need<=0)break;need-=this.tileBytes.get(i)||0;this.dropTile(i);this.evictions++;}
    return true;
  }
  /** Total far budget: tile metadata gets a quarter, the model/texture cache the rest. */
  setBudget(bytes) {
    this.tileBudget?this.tileBudget.setLimit(bytes/4):this.tileBudget=new ByteBudget(bytes/4);
    this.scene.setBudget(bytes*3/4);this.scene.limits.distantTiles=this.tileLimit=SCENE_CEILING.distantTiles;
    this.blocked.clear();
  }
  select() {
    if(this.selectedPosition===this.position&&this.selectedRegion===this.region&&
      this.scene.selectionRevision===this.scene.revision)return;
    const r=this.manifest.regions[this.region],p=this.position;
    const placements=this.scene.placementList(this.scene.distantTiles,this.region===0?1:0);
    if(placements!==this.discoveryPlacements) {
      const keys=new Set(placements.filter(p=>p.kind==='m2').map(p=>p.key));
      for(const key of this.scene.discovered.keys())if(!keys.has(key))this.scene.discovered.delete(key);
      this.discoveryPlacements=placements;
    }
    const position=[-p[2]+r.placement[1]+(32-r.tile_origin[1])*TILE,
      -p[0]+r.placement[0]+(32-r.tile_origin[0])*TILE,p[1]];
    const start=performance.now();
    this.scene.update(this.region===0?1:0,position,position,0,0);
    this.selectedPosition=this.position;this.selectedRegion=this.region;
    this.selectionMs+=performance.now()-start;
  }
  near(ids) {
    if(!Array.isArray(ids)||ids.length>SCENE_LIMITS.instances||ids.some(id=>typeof id!=='string'||id.length>256))
      throw Error('Invalid near visual ownership');
    this.scene.nearVisible=new Set(ids);this.scene.revision++;
  }
  async step() {
    if(!this.enabled || this.busy)return;
    this.busy=true;
    const epoch=this.epoch;
    try {
      const index=this.wanted.find(i=>!this.resident.has(i)&&!this.failures.has(i)&&!this.blocked.has(i));
      if(index!==undefined) {
        const tile=this.manifest.tiles[index];
        try {
          const bytes=await this.source.read(`World\\Maps\\${this.manifest.regions[tile.region].map}\\${tile.file}`);
          if(epoch===this.epoch && this.wanted.includes(index)) {
            if(!this.admitTile(index,bytes.byteLength))this.blocked.add(index);
            else {
              this.scene.setDistantTile(keyOf(tile),bytes);this.resident.add(index);this.loads++;
              this.tileBytes.set(index,bytes.byteLength);this.tileBudget?.add(bytes.byteLength);
              this.peak=Math.max(this.peak,this.resident.size);
            }
          }
        } catch(error) {
          if(epoch===this.epoch && error.code!=='DEFERRED') {
            this.failures.set(index,`Distant metadata ${tile.file}: ${error.code||'PARSE'} ${error.message||error}`);
            this.scene.revision++;
          }
        }
      }
      if(epoch!==this.epoch || !this.enabled)return;
      this.select();
      await this.scene.pump(true);
      if(epoch!==this.epoch || !this.enabled)return;
      if(this.scene.selectionRevision!==this.scene.revision)this.select();
      this.publish();
    } finally {this.busy=false;}
  }
  publish() {
    this.wasmPeakBytes=Math.max(this.wasmPeakBytes,this.memory());
    if(this.awaitingAck || !this.reset&&this.publicationRevision===this.scene.revision&&
      this.publicationPosition===this.position&&this.publicationCapacity===this.scene.capacityBlocked)return;
    const state=this.scene.snapshot(),assets=[],textures=[],transfers=[];
    const removedAssets=[...this.sentAssets].filter(key=>!state.assets.has(key)).map(visualKey);
    const removedTextures=[...this.sentTextures].filter(key=>!state.textures.has(key)).map(visualKey);
    for(const [key,a] of state.assets)if(this.reset||!this.sentAssets.has(key)) {
      const vertices=a.vertices.slice(),indices=a.indices.slice();
      assets.push({key:visualKey(key),vertices,indices,bounds:a.bounds,batches:a.batches});
      transfers.push(vertices.buffer,indices.buffer);
    }
    for(const [key,t] of state.textures)if(this.reset||!this.sentTextures.has(key)) {
      const rgba=t.rgba.slice();
      textures.push({key:visualKey(key),width:t.width,height:t.height,rgba});transfers.push(rgba.buffer);
    }
    this.transferPeakBytes=Math.max(this.transferPeakBytes,transfers.reduce((n,b)=>n+b.byteLength,0));
    const token=++this.serial;this.awaitingAck=token;this.publications++;
    const instances=state.instances.filter(i=>{
      const old=this.sentInstances.get(i.id);
      return this.reset||!old||old.key!==i.key||old.matrix!==i.matrix||old.kind!==i.kind;
    }).map(({id,key,matrix,kind})=>({id,key:visualKey(key),matrix,kind,distant:true}));
    this.send({event:'far-scene',epoch:this.epoch,token,region:this.region,reset:!!this.reset,
      instances,instanceOrder:state.instances.map(i=>i.id),
      assets,textures,removedAssets,removedTextures,stats:this.snapshot(state)},transfers);
    this.sentInstances=new Map(state.instances.map(({id,key,matrix,kind})=>[id,{key,matrix,kind}]));
    this.sentAssets=new Set(state.assets.keys());this.sentTextures=new Set(state.textures.keys());this.reset=false;
    this.publicationRevision=this.scene.revision;this.publicationPosition=this.position;
    this.publicationCapacity=this.scene.capacityBlocked;
  }
  ack(token) {if(token===this.awaitingAck)this.awaitingAck=undefined;}
  retry() {this.failures.clear();this.scene.retry();this.reset=true;}
  snapshot(state=this.scene.snapshot()) {
    return {resident:this.resident.size,peak:this.peak,limit:this.tileLimit,loads:this.loads,tileBytes:this.tileBudget?.used||0,tileByteLimit:this.tileBudget?.limit||0,evictions:this.evictions+state.evictions,
      pending:this.wanted.filter(i=>!this.resident.has(i)&&!this.failures.has(i)&&!this.blocked.has(i)).length,
      failures:[...this.failures.values()],scene:{instances:state.instances.length,models:state.cachedModels,
        textures:state.cachedTextures,bytes:state.cachedBytes,pending:state.pending,errors:state.errors,
        capacityBlocked:state.capacityBlocked,decoder:state.timings},
      budgetOmitted:state.budgetOmitted,
      wasmBytes:this.memory(),wasmPeakBytes:this.wasmPeakBytes,selectionMs:this.selectionMs,
      publications:this.publications,transferPeakBytes:this.transferPeakBytes};
  }
}
