import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

// Exercise the actual worker queue with synthetic archive/Wasm boundaries, without starting WebGPU.
const worker=(await readFile(new URL('./world-worker.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?$/gm,'');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(xs=[0,1,20,21]) {
  const reads=[],added=[],pending=new Map(),required=[0];
  const context=createContext({init:async()=>({}),performance,postMessage(){}});
  runInContext(worker,context);
  context.dependencies={
    world:{required_tiles:()=>required,add_tile:i=>added.push(i),remove_tile(){},
      geometry:()=>new Float32Array(),horizon_seams:()=>new Float32Array(),terrain_material:()=>({})},
    source:{read:path=>{
      const index=Number(path.match(/tile(\d+)\.adt$/)[1]);
      reads.push(index);
      return new Promise((resolve,reject)=>pending.set(index,{resolve,reject}));
    }},
    manifest:{regions:[{map:'test'}],tiles:xs.map((x,i)=>({region:0,x,y:0,file:`tile${i}.adt`}))},
    placements:xs.map(x=>[x*1600/3,0]),
    scene:{setTile(){},removeTile(){}},terrain:{setTile(){},removeTile(){}},
  };
  runInContext(`({world,source,manifest,placements,scene,terrain}=dependencies);
    resident=new Set([0]);
    globalThis.streamTerrain=stream;
    globalThis.state=()=>({resident:[...resident],failures:[...failures.values()]});`,context);
  return {reads,added,required,pending,stream:context.streamTerrain,
    state:()=>JSON.parse(JSON.stringify(context.state()))};
}

test('slow optional ADT read does not block frames, duplicate reads, or admit terrain asynchronously',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  await f.stream([0,0],true);
  assert.deepEqual(f.reads,[1]);
  assert.deepEqual(f.state().resident,[0]);
  f.pending.get(1).resolve(new Uint8Array([1]));
  await settle();
  assert.deepEqual(f.added,[],'Read completion alone must not change physics or scene metadata');
  await f.stream([0,0],true);
  assert.deepEqual(f.reads,[1]);
  assert.deepEqual(f.added,[1]);
  assert.deepEqual(f.state().resident,[0,1]);
});

test('prefetched ADT becoming required waits for the same read and keeps current support pinned',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  f.required.push(1);
  let done=false;
  const frame=f.stream([0,0],true).then(()=>{done=true;});
  await settle();
  assert.equal(done,false);
  assert.deepEqual(f.reads,[1]);
  assert.deepEqual(f.state().resident,[0]);
  f.pending.get(1).resolve(new Uint8Array([1]));
  await frame;
  assert.deepEqual(f.state().resident,[0,1]);
  assert.deepEqual(f.added,[1]);
});

test('stale optional ADT completion cannot resurrect terrain after flight changes demand',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  await f.stream([20*1600/3,0],false);
  assert.deepEqual(f.reads,[1],'Only one optional raw ADT may be in flight');
  f.pending.get(1).resolve(new Uint8Array([1]));
  await settle();
  await f.stream([20*1600/3,0],false);
  assert.deepEqual(f.reads,[1,2]);
  assert.deepEqual(f.added,[]);
  assert.deepEqual(f.state().resident,[]);
});

test('completed optional ADT is admitted even when a different wanted tile becomes closer',async()=>{
  const f=fixture([0,1,2,3]);
  await f.stream([0,0],true);
  f.pending.get(1).resolve(new Uint8Array([1]));
  await settle();
  await f.stream([1100,0],true);
  assert.deepEqual(f.added,[1]);
  assert.deepEqual(f.state().resident,[0,1]);
  await f.stream([1100,0],true);
  assert.deepEqual(f.reads,[1,2]);
});

test('failed prefetched terrain stays unavailable and exposes its error rather than empty ocean',async()=>{
  const f=fixture();
  await f.stream([0,0],true);
  f.pending.get(1).reject(Object.assign(new Error('missing authored tile'),{code:'NOT_FOUND'}));
  await settle();
  f.required.push(1);
  await f.stream([0,0],true);
  assert.deepEqual(f.added,[]);
  assert.deepEqual(f.state().resident,[0]);
  assert.match(f.state().failures[0],/tile1\.adt: NOT_FOUND missing authored tile/);
  await f.stream([0,0],true);
  assert.deepEqual(f.reads,[1],'Failed expected terrain requires explicit retry');
});
