import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundsWithin} from './scene-stream.js';
import {createTerrainIndex} from './world-worker-logic.js';
import {boot,runInContext} from './world-worker-fixtures.mjs';

test('terrain grid preserves exhaustive distance ordering across offsets, edges and source changes',()=>{
  const tile=1600/3;
  for(const offset of [0,173.4,-1269]){
    const placements=Array.from({length:1705},(_,i)=>[(i%41-20)*tile+offset,(Math.floor(i/41)-20)*tile-offset]);
    const index=createTerrainIndex();
    const near=p=>index.nearby(placements,p);
    for(const p of [[0,0],[-850,850],[tile,tile],[offset,offset],[-9000,8200],[1e6,1e6]]){
      const distance=a=>Math.hypot(Math.max(a[0]-p[0],0,p[0]-a[0]-tile),Math.max(a[1]-p[1],0,p[1]-a[1]-tile));
      const expected=placements.map((a,i)=>[i,distance(a)]).filter(([,d])=>d<850)
        .sort((a,b)=>a[1]-b[1]||a[0]-b[0]).map(([i])=>i);
      assert.deepEqual([...near(p)],expected);
    }
    let calls=0;
    const counted=new Proxy(placements,{get(target,key){
      if(/^\d+$/.test(String(key)))calls++;return Reflect.get(target,key);
    }});
    const moving=p=>index.nearby(counted,p);
    moving([0,0]);calls=0;moving([1,1]);
    assert(calls<100,'Moving queries must not scan the whole manifest');
  }
  const index=createTerrainIndex();
  assert.throws(()=>index.nearby([],[Infinity,0]),/Invalid terrain observer/);
  assert.throws(()=>index.nearby([],[1e308,0]),/Invalid terrain observer/);
});


test('cached unresolved broad phase preserves exact moving hull and camera predicates',()=>{
  const context=boot();
  const candidates=Array.from({length:6400},(_,i)=>{
    const p=[(i%80)*25-1000,Math.floor(i/80)*25-1000,i%11*9-45];
    return {kind:i%31?'m2':'wmo',boundsKnown:i%7!==0,bounds:[p,p.map(v=>v+3)]};
  });

  context.candidates=candidates;
  runInContext('sceneState={unresolvedCollision:candidates};globalThis.near=nearUnresolved;',context);
  for(let i=0;i<160;i++) {
    const p=[i*2-150,i-80,i%35-15],radius=i%17+32,vertical=i%19+32;
    const shortlist=context.near(p,i<80?0:1,radius,vertical);
    const exact=x=>(x.kind==='wmo'&&!x.boundsKnown)||boundsWithin(x.bounds,p,x.boundsKnown?radius:Math.max(32,radius),vertical);
    assert.deepEqual(shortlist.filter(exact).map(x=>candidates.indexOf(x)),
      candidates.filter(exact).map(x=>candidates.indexOf(x)));
    const camera=x=>(x.kind==='wmo'&&!x.boundsKnown)||boundsWithin(x.bounds,p,84);
    assert.deepEqual(context.near(p,i<80?0:1).filter(camera).map(x=>candidates.indexOf(x)),
      candidates.filter(camera).map(x=>candidates.indexOf(x)));
  }
  assert(context.near([0,0,0],1).length<640,'The cached filter must actually reduce live work');
  runInContext('sceneState={unresolvedCollision:[]};',context);
  assert.equal(context.near([0,0,0],1).length,0);
});

test('parked pose must be [x,y,z,yaw]; a track-start {pos,yaw} object is rejected with the offending value',async()=>{
  const {validateParkedPose}=await import('./world-worker-logic.js');
  assert.doesNotThrow(()=>validateParkedPose([1,2,3,.5]));
  assert.throws(()=>validateParkedPose({pos:[1,2,3],yaw:.5}),/Invalid parked pose.*pos/);
  assert.throws(()=>validateParkedPose([1,2,3,.5,-.3]),/Invalid parked pose/);
});
