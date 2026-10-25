import init,{SceneTexture} from './pkg/flats_racer_web.js';
import {openDataSource} from './asset-source.js';
import {TILE_CAP_MAX} from './memory-budget.js';
import {terrainMips,resizeRgba,MINIMAP_SIZE} from './terrain-stream.js';
import {prepareDetail} from './camera-collision.js';
import {loadLoadingArt} from './loading-art.js';
import {demoSource} from './demo-source.js';
import {errorFields,isRequestId} from './worker-rpc.js';

let source,wasm,busy=false,receipt,active;
let artStopped=false;
const jobs=[],cancelled=new Set();
const work={decodeMs:0,textureLoads:0,transferPeakBytes:0};
function reply(job,result,error) {
  const transfers=result?.event==='detail'?
    [...result.tiles.flatMap(t=>[t.vertices.buffer,t.liquid.buffer,t.camera.vertices.buffer,
      t.camera.offsets.buffer,t.camera.triangles.buffer]),...result.seams.map(s=>s.vertices.buffer)]
    :result instanceof Uint8Array?[result.buffer]
    :result?.mips?result.mips.map(m=>m.buffer):result?.rgba?[result.rgba.buffer]:[];
  work.transferPeakBytes=Math.max(work.transferPeakBytes,transfers.reduce((n,b)=>n+b.byteLength,0));
  receipt=job.id;
  postMessage({id:job.id,result,...(error&&errorFields(error)),
    stats:{...source?.stats,...work,wasmBytes:wasm?.memory.buffer.byteLength||0}},transfers);
}
async function pump() {
  if(busy||receipt!==undefined||!jobs.length)return;
  busy=true;
  const next=jobs.findIndex(j=>!j.background),job=jobs.splice(next<0?0:next,1)[0];
  active=job.id;
  const defer=()=>cancelled.has(job.id)||job.background&&jobs.some(j=>!j.background);
  try {
    if(job.action==='open') {
      if(source)throw Error('Asset source already open');
      wasm=await init();source=job.folder==='demo'?demoSource():await openDataSource(job.folder,progress=>
        postMessage({event:'progress',stage:'archives',text:'Indexing local archives',...progress}));
      if(job.loadingArt&&!artStopped)void loadLoadingArt(source,bytes=>{
        const texture=new SceneTexture(bytes);
        try{return {...JSON.parse(texture.metadata()),rgba:texture.rgba()};}
        finally{texture.free();}
      },data=>postMessage(data,data.rgba?[data.rgba.buffer]:[]),()=>artStopped,job.map)
        .catch(error=>postMessage({event:'loading-art-warning',message:`Loading artwork: ${error.message||error}`}));
      reply(job,{fingerprint:source.fingerprint,archives:source.archives});
    } else if(job.action==='detail') {
      if(!source)throw Error('Asset source is not open');
      const data=job.detail;
      if(data.tiles.length>TILE_CAP_MAX||data.seams.length>TILE_CAP_MAX||
        [...data.tiles,...data.seams].reduce((n,t)=>n+t.vertices.byteLength,0)> TILE_CAP_MAX * 8 * 1024 * 1024)
        throw Error('Detail preparation exceeds bounded tile payload');
      reply(job,prepareDetail(data));
    } else {
      if(!source)throw Error('Asset source is not open');
      if(!['read','texture'].includes(job.action))throw Error('Unknown asset operation');
      const bytes=await source.read(job.path,{background:job.background,shouldDefer:defer});
      if(bytes.byteLength>64*1024*1024)throw Error('Encoded asset exceeds 64 MiB');
      if(defer())throw Object.assign(Error('Background resource deferred'),{code:'DEFERRED'});
      if(job.action==='read')reply(job,bytes);
      else {
        const start=performance.now(),texture=new SceneTexture(bytes);
        try {
          const decoded={...JSON.parse(texture.metadata()),rgba:texture.rgba()};
          let result;
          if(job.output==='rgba')result=decoded;
          else if(job.output==='mips')result={mips:terrainMips(decoded)};
          else if(job.output==='minimap')result={rgba:resizeRgba(decoded.width,decoded.height,decoded.rgba,MINIMAP_SIZE)};
          else throw Error('Unknown texture output');
          work.decodeMs+=performance.now()-start;work.textureLoads++;
          reply(job,result);
        } finally {texture.free();}
      }
    }
  } catch(error){reply(job,undefined,error);}
  finally {cancelled.delete(job.id);active=undefined;busy=false;}
}
onmessage=({data})=>{
  if(data.action==='stop-art'){artStopped=true;return;}
  if(data.action==='ack'){
    if(data.id===receipt)receipt=undefined;
  } else if(data.action==='cancel') {
    if(data.id===active||jobs.some(j=>j.id===data.id))cancelled.add(data.id);
  }
  else {
    if(!isRequestId(data.id))throw Error('Invalid asset request');
    if(jobs.length>=64)throw Error('Asset request queue exceeds 64 pending operations');
    jobs.push(data);
  }
  void pump();
};
