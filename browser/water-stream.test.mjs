import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WaterStream} from './water-stream.js';
import {WorldRenderer} from './world-renderer.js';
const manifest={spawn:[0,0,0],regions:[{map:'Test',placement:[0,0],tile_origin:[0,0]}],
  tiles:[0,1,2].map(x=>({region:0,x,y:0,file:`Test_${x}_0.adt`}))};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture() {
  const reads=[],events=[],pending=[];
  let parses=0;
  const stream=new WaterStream({read:path=>{reads.push(path);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}},
    {coast_liquids:()=>{parses++;return new Float32Array(42);}},manifest,
    (event,transfer)=>events.push(structuredClone(event,{transfer})));
  return {stream,reads,events,pending,parses:()=>parses};
}
test('water reads stage once; only a later pump parses and transfers geometry',async()=>{
  const f=fixture();
  f.stream.pump(0);f.stream.pump(100);
  assert.equal(f.reads.length,1);assert.equal(f.parses(),0);
  f.pending[0].resolve(new Uint8Array(1));await settle();
  assert.equal(f.parses(),0);assert.equal(f.events.length,0);
  f.stream.pump(100);
  assert.equal(f.parses(),1);assert.equal(f.events.length,1);
  assert.equal(f.stream.snapshot().bytes,168,'Transferred buffers retain their accounted size');
});
test('water cache stays bounded and evicts farther geometry when focus moves',async()=>{
  const f=fixture();f.stream.limit=336;
  for(let i=0;i<3;i++){
    f.stream.pump(i*100);f.pending[i].resolve(new Uint8Array(1));await settle();f.stream.pump(i*100+1);
  }
  assert.equal(f.stream.snapshot().bytes,336);assert(f.stream.snapshot().limited);
  f.stream.setFocus([1200,0,0]);f.stream.pump(500);
  f.pending[3].resolve(new Uint8Array(1));await settle();f.stream.pump(501);
  assert.equal(f.stream.snapshot().bytes,336);
  assert.deepEqual(f.events.at(-1).removed,[0]);assert.equal(f.events.at(-1).index,2);
});
test('read/parse errors remain explicit and retryable; closed sources cannot publish stale water',async()=>{
  const f=fixture();f.stream.pump(0);
  f.pending[0].reject(Error('local read failed'));await settle();f.stream.pump(1);
  assert.match(f.stream.snapshot().errors[0],/local read failed/);
  f.stream.retry();f.stream.pump(100);
  f.stream.wasm.coast_liquids=()=>new Float32Array(1);
  f.pending[1].resolve(new Uint8Array(1));await settle();f.stream.pump(101);
  assert.match(f.stream.snapshot().errors[0],/Invalid distant liquid geometry/);
  f.stream.retry();f.stream.pump(200);f.stream.clear();
  f.pending[2].resolve(new Uint8Array(1));await settle();f.stream.pump(201);
  assert.equal(f.events.length,0);
});
test('dry authored tiles are remembered without fake water or repeated reads',async()=>{
  const f=fixture();f.stream.wasm.coast_liquids=()=>new Float32Array();
  f.stream.pump(0);f.pending[0].resolve(new Uint8Array(1));await settle();f.stream.pump(1);
  assert.equal(f.stream.snapshot().dry,1);assert.equal(f.events.length,0);
  f.stream.setFocus([600,0,0]);f.stream.pump(100);
  assert.match(f.reads.at(-1),/Test_1_0/);
});
test('ordinary focus changes never rescan completed water tiles',async()=>{
  const f=fixture();
  for(let i=0;i<3;i++){
    f.stream.pump(i*100);
    f.pending[i].resolve(new Uint8Array(4));await settle();f.stream.pump(i*100+1);
  }
  for(const x of [1200,-600,3000,0]){f.stream.setFocus([x,0,0]);f.stream.pump(1000);}
  assert.equal(f.reads.length,3);assert.equal(f.parses(),3);
  assert.equal(f.stream.snapshot().pending,0);assert.equal(f.stream.snapshot().sourceBytes,12);
});
test('source backpressure defers rather than loses or falsely fails a water tile',async()=>{
  const f=fixture();f.stream.pump(0);
  f.pending[0].reject(Object.assign(Error('foreground assets pending'),{code:'DEFERRED'}));
  await settle();f.stream.pump(1);
  assert.equal(f.stream.snapshot().deferred,1);assert.deepEqual(f.stream.snapshot().errors,[]);
  f.stream.pump(100);assert.equal(f.reads[0],f.reads[1]);
  f.pending[1].resolve(new Uint8Array(1));await settle();f.stream.pump(101);
  assert.equal(f.events.length,1);
});
test('GPU water replacements release old resources and use exact detailed-tile placement',()=>{
  const released=[],rig=Object.create(WorldRenderer.prototype);
  Object.assign(rig,{manifest,coast:new Map(),coastBytes:0,
    drawable:(v,placement)=>({placement,buffer:{size:v.byteLength,destroy:()=>released.push(placement)}})});
  rig.event({event:'coast-water',index:0,removed:[],vertices:new Float32Array(42)});
  rig.event({event:'coast-water',index:1,removed:[0],vertices:new Float32Array(42)});
  assert.equal(rig.coastBytes,168);assert.equal(rig.coast.size,1);
  assert.deepEqual(rig.coast.get(1).placement,[1600/3,0]);assert.equal(released.length,1);
  assert.throws(()=>rig.event({event:'coast-water',index:1,removed:[1],vertices:new Float32Array(42)}));
  assert.equal(rig.coastBytes,168);
  Object.assign(rig,{tiles:new Map(),seams:new Map(),horizon:[],water:[],indices:new Map(),assets:new Map(),
    textures:new Map(),items:new Map(),materialPending:new Map(),minimapAtlases:[]});
  rig.reset();
  assert.equal(rig.coastBytes,0);assert.equal(rig.coast.size,0);assert.equal(released.length,2);
});
