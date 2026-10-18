import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {AssetSource,openAssetSource} from './asset-channel.js';
import {terrainMips,resizeRgba,MINIMAP_SIZE} from './terrain-stream.js';
import {prepareDetail} from './camera-collision.js';

const code=(await readFile(new URL('./asset-worker.js',import.meta.url),'utf8')).replace(/^import .*;\r?$/gm,'');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function worker(source) {
  const messages=[],out=[],fake={messages,out,terminated:false,terminate(){this.terminated=true;}};
  const context=createContext({Uint8Array,performance,terrainMips,resizeRgba,MINIMAP_SIZE,prepareDetail,
    init:async()=>({memory:{buffer:new ArrayBuffer(65536)}}),openDataSource:async()=>source,
    SceneTexture:class {
      constructor(bytes){this.bytes=bytes;}
      metadata(){return JSON.stringify({width:2,height:2});}
      rgba(){return new Uint8Array(16).fill(this.bytes[0]);}
      free(){}
    },
    postMessage:(data,transfer)=>{
      const copy=structuredClone(data,{transfer});
      out.push(copy);queueMicrotask(()=>{if(!fake.terminated)fake.onmessage?.({data:copy});});
    }});
  runInContext(code,context);
  fake.postMessage=data=>{
    if(fake.terminated)throw Error('Terminated worker');
    messages.push(data);context.message=data;runInContext('onmessage({data:message})',context);
  };
  return fake;
}
const dataSource=read=>({read,fingerprint:'fixture',archives:['patch.mpq'],stats:{indexBytes:123}});

test('source worker preserves identity and transfers raw and decoded resources',async()=>{
  const w=worker(dataSource(async()=>new Uint8Array([91])));
  const source=await openAssetSource([] ,()=>w);
  assert.equal(source.fingerprint,'fixture');assert.deepEqual(source.archives,['patch.mpq']);
  assert.deepEqual(await source.read('a'),new Uint8Array([91]));
  assert.deepEqual((await source.readTexture('b')).rgba,new Uint8Array(16).fill(91));
  const {mips}=await source.readTexture('b','mips');
  assert.equal(mips.length,9);assert.equal(mips[0].length,256*256*4);
  assert.equal((await source.readTexture('b','minimap')).rgba.length,32*32*4);
  assert.equal(source.stats.indexBytes,123);assert.equal(source.stats.textureLoads,3);
  assert.equal(source.stats.wasmBytes,65536);
  source.close();assert(w.terminated);
});

test('worker waits for a matching consumption receipt and prioritizes queued required reads',async()=>{
  const reads=[],w=worker(dataSource(async path=>{reads.push(path);return new Uint8Array([1]);}));
  w.postMessage({id:1,action:'open',folder:[]});await settle();
  w.postMessage({id:2,action:'read',path:'optional',background:true});
  w.postMessage({id:3,action:'read',path:'required',background:false});
  w.postMessage({id:4,action:'ack'});await settle();assert.deepEqual(reads,[]);
  w.postMessage({id:1,action:'ack'});await settle();assert.deepEqual(reads,['required']);
  w.postMessage({id:3,action:'ack'});await settle();assert.deepEqual(reads,['required','optional']);
});

test('detail preparation transfers typed camera indices and exact liquid geometry off the renderer',async()=>{
  const w=worker(dataSource(async()=>{throw Error('Detail preparation must not read an archive');}));
  const source=await openAssetSource([],()=>w);
  const vertices=new Float32Array([0,2,0,0,1,0,0, 5,2,0,0,1,0,0, 0,2,5,0,1,0,0,
    0,1,0,0,1,0,2, 5,1,0,0,1,0,2, 0,1,5,0,1,0,2]);
  const result=await source.prepareDetail({event:'detail',tiles:[{index:0,placement:[0,0],vertices}],removed:[],seams:[]});
  const tile=result.tiles[0];
  assert.equal(tile.camera.vertices.length,9);assert.equal(tile.liquid.length,21);
  assert(tile.camera.offsets instanceof Uint32Array);assert(tile.camera.triangles instanceof Uint32Array);
  assert.equal(tile.camera.offsets.at(-1),tile.camera.triangles.length);
  assert.deepEqual([...tile.liquid].filter((_,i)=>i%7===6),[2,2,2]);
  source.close();
});

test('new required demand defers an active optional extraction without losing either request',async()=>{
  let complete;
  const reads=[],w=worker(dataSource(async(path,{shouldDefer})=>{
    reads.push(path);
    if(path==='optional')await new Promise(resolve=>complete=resolve);
    if(shouldDefer())throw Object.assign(Error('yield'),{code:'DEFERRED'});
    return new Uint8Array([2]);
  }));
  const source=await openAssetSource([],()=>w);
  const optional=source.read('optional',{background:true});const checked=assert.rejects(optional,{code:'DEFERRED'});
  await settle();const required=source.read('required');complete();
  await checked;assert.deepEqual(await required,new Uint8Array([2]));
  assert.deepEqual(reads,['optional','required']);source.close();
});

test('source cancellation and late completion reject stale results; corrupt data stays explicit',async()=>{
  let complete,stale=false;
  const w=worker(dataSource(async path=>{
    if(path==='bad')throw Object.assign(Error('damaged archive'),{code:'CORRUPT'});
    return new Promise(resolve=>complete=()=>resolve(new Uint8Array([3])));
  }));
  const source=await openAssetSource([],()=>w);
  const read=source.read('old',{background:true,shouldDefer:()=>stale});
  const checked=assert.rejects(read,{code:'DEFERRED'});
  await settle();stale=true;source.refresh();complete();await checked;
  await assert.rejects(source.read('bad'),{code:'CORRUPT',message:'damaged archive'});
  const pending=source.read('close');const closed=assert.rejects(pending,{code:'CLOSED'});
  source.close();await closed;assert.equal(source.pending.size,0);
});

test('worker construction, send and runtime failures reject instead of leaving requests unresolved',async()=>{
  await assert.rejects(openAssetSource([],()=>{throw Error('no workers');}),/no workers/);
  const source=new AssetSource({postMessage(){throw Error('clone');},terminate(){}});
  await assert.rejects(source.read('a'),/clone/);
  const w=worker(dataSource(()=>new Promise(()=>{}))),other=await openAssetSource([],()=>w);
  const pending=other.read('a'),checked=assert.rejects(pending,/crashed/);
  w.onerror({message:'crashed'});await checked;assert(w.terminated);
});
