import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WaterStream,validLiquidGeometry,deepOceanBacking} from './water-stream.js';
import {WorldRenderer} from './world-renderer.js';
const manifest={spawn:[0,0,0],regions:[{map:'Test',placement:[0,0],tile_origin:[0,0]}],
  tiles:[0,1,2].map(x=>({region:0,x,y:0,file:`Test_${x}_0.adt`}))};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const geometry=()=>Float32Array.from({length:42},(_,i)=>i%7===4?1:i%7===6?2:0);
function oceanBoundaryFixture() {
  const bytes=new Uint8Array(12+8+128+588+812),v=new DataView(bytes.buffer),base=20;
  const tag=(p,s)=>bytes.set(new TextEncoder().encode(s),p);
  tag(0,'REVM');v.setUint32(4,4,true);v.setUint32(8,18,true);
  tag(12,'KNCM');v.setUint32(16,bytes.length-base,true);
  v.setUint32(base,9,true);v.setUint32(base+4,15,true);v.setUint32(base+8,2,true);
  v.setUint32(base+0x14,128,true);v.setUint32(base+0x60,716,true);v.setUint32(base+0x64,812,true);
  v.setFloat32(base+0x70,-503.43399,true);
  tag(base+128,'TVCM');v.setUint32(base+132,580,true);
  tag(base+716,'QLCM');v.setUint32(base+720,804,true);
  const cells=base+716+8+656;
  for(let row=0;row<8;row++)bytes.set([1,15,15,15,15,15,15,1],cells+row*8);
  return {bytes,v,base,cells};
}
test('deep exterior dry strips get visual backing without changing authored cells',()=>{
  const {bytes}=oceanBoundaryFixture(),original=bytes.slice(),backing=deepOceanBacking(bytes,2);
  assert.equal(backing.length,42);assert(validLiquidGeometry(backing));
  assert(Math.abs(backing[0]-504.1666667)<.001);assert(Math.abs(backing[7]-529.1666667)<.001);
  assert(backing.filter((_,i)=>i%7===6).every(m=>m===4));
  assert.deepEqual(bytes,original);
});
test('Kalimdor_44_37 MCNK (15,2) sea-level dry strip gets only bounded exterior backing',()=>{
  const {bytes,v,base}=oceanBoundaryFixture();
  const floor=v.getFloat32(base+0x70,true);
  for(let i=0;i<145;i++)v.setFloat32(base+136+i*4,i%17===0?0:-floor,true);
  const original=bytes.slice();
  assert.equal(deepOceanBacking(bytes,2).length,42);
  assert.deepEqual(bytes,original);
  assert.equal(deepOceanBacking(bytes,0).length,0,'No exterior connectivity');
  v.setFloat32(base+136+2*4,-floor+.02,true);
  const backing=deepOceanBacking(bytes,2);
  assert(backing.length>0);
  const point=[(15*8+1.5)*1600/384, (2*8+.5)*1600/384];
  for(let i=0;i<backing.length;i+=42)assert(!(point[0]>backing[i]&&point[0]<backing[i+7]
    &&point[1]>backing[i+2]&&point[1]<backing[i+16]),'Above-sea dry cell remains unfilled');
});
test('inland dry cells, lakes, shallow terrain, holes and disconnected ocean edges get no backing',()=>{
  assert.equal(deepOceanBacking(oceanBoundaryFixture().bytes,0).length,0);
  for(const change of [
    f=>f.v.setUint32(f.base+4,8,true),
    f=>f.v.setUint32(f.base,4,true),
    f=>f.v.setFloat32(f.base+0x70,.02,true),
    f=>{f.v.setFloat32(f.base+0x70,-10,true);for(let row=0;row<8;row++)f.bytes[f.cells+row*8]=15;},
    f=>f.v.setUint16(f.base+0x3c,1,true),
    f=>{for(let row=0;row<8;row++)f.bytes[f.cells+row*8+7]=15;},
    f=>f.v.setFloat32(f.base+716+8+12,.1,true),
  ]){
    const f=oceanBoundaryFixture();change(f);assert.equal(deepOceanBacking(f.bytes,2).length,0);
  }
  assert.throws(()=>deepOceanBacking(new Uint8Array(2),2),/Invalid ocean backing ADT/);
});
test('only actual exterior geometry supplies ocean connectivity',()=>{
  const f=fixture(),tile={region:0,x:44,y:37},outside=new Float32Array(42);
  assert.equal(f.stream.exteriorEdges(tile),0);
  outside[0]=45*1600/3;outside[2]=37*1600/3;f.stream.setExterior(0,outside);
  assert.equal(f.stream.exteriorEdges(tile),2);
  assert.equal(f.stream.exteriorEdges({...tile,x:40}),0);
  f.stream.clear();assert.equal(f.stream.exteriorEdges(tile),0);
});
function fixture() {
  const reads=[],events=[],pending=[];
  let parses=0;
  const stream=new WaterStream({read:path=>{reads.push(path);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}},
    {coast_liquids:()=>{parses++;return geometry();}},manifest,
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
test('coastal WDL hints only prioritize reads; authored dry tiles still emit no ocean',async()=>{
  const f=fixture();f.stream.coastalTile(2);
  f.stream.pump();f.pending[0].resolve(new Uint8Array(1));await settle();f.stream.pump();
  f.stream.pump();assert.match(f.reads[1],/Test_2_0/);
  f.stream.wasm.coast_liquids=()=>new Float32Array();
  f.pending[1].resolve(new Uint8Array(1));await settle();f.stream.pump();
  assert.equal(f.events.length,1);assert.equal(f.stream.snapshot().dry,1);
});
test('cached water validation rejects changed materials, invalid coordinates and non-finite heights',()=>{
  assert(validLiquidGeometry(geometry()));assert(validLiquidGeometry(new Float32Array()));
  for(const [index,value] of [[0,600],[1,Infinity],[4,0],[6,3]]){
    const vertices=geometry();vertices[index]=value;assert(!validLiquidGeometry(vertices));
  }
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
  Object.assign(rig,{tiles:new Map(),seams:new Map(),horizon:[],water:[],flags:[],gates:[],indices:new Map(),assets:new Map(),
    textures:new Map(),items:new Map(),poses:new Map(),materialPending:new Map(),minimapAtlases:[]});
  rig.reset();
  assert.equal(rig.coastBytes,0);assert.equal(rig.coast.size,0);assert.equal(released.length,2);
});
test('near-water backing shares its bounded GPU buffer and draws only the appended vertices',()=>{
  const draws=[],rig=Object.create(WorldRenderer.prototype),vertices=new Float32Array(84);
  vertices.set(geometry());vertices.set(deepOceanBacking(oceanBoundaryFixture().bytes,2),42);
  Object.assign(rig,{manifest,coast:new Map(),coastBytes:0,terrainBundleBuilds:0,
    drawable:(v,placement)=>({placement,count:v.length/7,buffer:{size:v.byteLength,destroy(){}}}),
    device:{createRenderBundleEncoder:()=>({setPipeline(){},setBindGroup(){},setVertexBuffer(){},
      draw:(...args)=>draws.push(args),finish:()=>({})})}});
  rig.event({event:'coast-water',index:0,removed:[],vertices});
  const item=rig.coast.get(0);
  assert.equal(item.backing.buffer,item.buffer);assert.equal(rig.coastBytes,vertices.byteLength);
  rig.drawTerrain({executeBundles(){}},[item.backing]);
  assert.deepEqual(draws,[[6,1,6]]);
});
