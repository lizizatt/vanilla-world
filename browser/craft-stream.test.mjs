import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadCraft} from './craft-stream.js';
import {craftMatrix} from './world-renderer.js';
import {cameraView} from './world-camera.js';

test('pitched craft forward axis and cockpit match engine direction at every yaw and bank',()=>{
  for(const pitch of [-20,0,20])for(const yaw of [-2,0,2])for(const bank of [-.3,0,.3]){
    const state=Array(18).fill(0);state[0]=1e9;state[2]=-1e9;state[3]=yaw;state[4]=bank;state[17]=pitch*Math.PI/180;
    const m=craftMatrix(state,[1e9,-1e9],1);
    const expected=[-Math.sin(yaw)*Math.cos(state[17]),Math.sin(state[17]),-Math.cos(yaw)*Math.cos(state[17])];
    assert(expected.every((n,i)=>Math.abs(n-m[i])<1e-7),'Bank must not change the pitched thrust direction');
    const rig={craft:{metadata:{scale:1},anchor:[0,0,.75]},clipCamera:(_a,b)=>b};
    const view=cameraView(rig,state,undefined,0,[1e9,-1e9],{cockpit:true});
    assert(view.look.every((n,i)=>Math.abs(n-expected[i])<1e-7));
    assert(rig.camera.every(Number.isFinite));
  }
});

test('craft model forward, scale, banking and floating origin match the physics body',()=>{
  const m=craftMatrix([10000,2,-20000,0,0],[9999,-20002],1);
  assert.deepEqual([...m.slice(0,3)].map(x=>x||0),[0,0,-1]);
  assert.deepEqual([...m.slice(4,7)].map(x=>x||0),[-1,0,0]);
  assert.deepEqual([...m.slice(8,11)].map(x=>x||0),[0,1,0]);
  assert.deepEqual([...m.slice(12)],[1,2,2,1]);
  const turned=craftMatrix([0,0,0,Math.PI/2,.2],[0,0],2);
  assert(Math.abs(turned[0]+2)<1e-6);
  assert(Math.abs(Math.hypot(...turned.slice(8,11))-2)<1e-6);
});

// Craft model space is +x forward, +y left, +z up for every skin (rocket, GLB, SWE1R via toCraft), so one
// EngineL/EngineR pair at y=+/-1 covers them all. Bank signs come from the real physics for A (steer +1) and D.
test('steering banks every skin into the turn: left steer puts the left engine lower, right steer the right',()=>{
  const engine=(m,y)=>m[13]+m[5]*y; // world Y of the model point (0,y,0)
  for(const [steer,wantLeftLower] of [[1,true],[-1,false]]) {
    const m=craftMatrix([0,0,0,0,-steer*.3],[0,0],1); // physics: bank_target = -steer * ...
    assert.equal(engine(m,1)<engine(m,-1),wantLeftLower);
  }
});

function fixture() {
  let freed=0;
  const wasm={
    scene_craft_display:()=>JSON.stringify({display:10318,path:'Creature\\Car.mdx',skins:[],scale:1}),
    scene_craft_metadata:()=>JSON.stringify({attachment0:{bone:74,position:[1,2,3]},pose:'bind-pose',cockpitAvailable:false}),
    SceneModel:{craft:()=>({vertices:()=>new Float32Array(36),indices:()=>new Uint32Array([0,1,2]),
      metadata:()=>JSON.stringify({animation:'stand-frame-0',posedAttachment0:{bone:74,position:[4,5,6]},
        batches:[{texture:'Shared.BLP'},{texture:'shared.blp'}]}),free(){freed++;}})},
    SceneTexture:class {metadata(){return '{"width":1,"height":1}';}rgba(){return new Uint8Array([1,2,3,255]);}free(){freed++;}},
  };
  return {wasm,get freed(){return freed;}};
}
test('craft resolves locally, deduplicates authored textures and transfers only complete results',async()=>{
  const f=fixture(),reads=[],messages=[];
  const source={read:async path=>{reads.push(path);return new Uint8Array(1);}};
  const result=await loadCraft(source,f.wasm,(message,transfer)=>messages.push(structuredClone(message,{transfer})));
  assert.equal(result.triangles,1);
  assert.equal(result.textureCount,1);
  assert.equal(messages[0].asset.indices.length,3);
  assert.equal(reads.filter(p=>p==='shared.blp').length,1);
  assert.equal(messages[0].metadata.cockpitAvailable,false);
  assert.equal(messages[0].metadata.pose,'stand-frame-0');
  assert.deepEqual(messages[0].metadata.posedAttachment0.position,[4,5,6]);
  assert.equal(f.freed,2);
});
test('missing craft texture fails explicitly without publishing a partial model',async()=>{
  const f=fixture(),messages=[];
  const source={read:async path=>{if(path==='shared.blp')throw Error('missing local texture');return new Uint8Array(1);}};
  await assert.rejects(loadCraft(source,f.wasm,message=>messages.push(message)),/missing local texture/);
  assert.equal(messages.length,1);
  assert.equal(messages[0].event,'craft-error');
  assert.match(messages[0].error,/missing local texture/);
});
test('cancelled craft loading stops before the next database read and emits no stale craft error',async()=>{
  const f=fixture(),messages=[],reads=[];let resolve,obsolete=false,defer;
  const source={read:(path,{shouldDefer})=>{
    reads.push(path);defer=shouldDefer;return new Promise(done=>resolve=done);
  }};
  const load=loadCraft(source,f.wasm,message=>messages.push(message),()=>obsolete);
  obsolete=true;assert.equal(defer(),true);resolve(new Uint8Array(1));
  await assert.rejects(load,{code:'DEFERRED'});
  assert.equal(reads.length,1);assert.equal(f.freed,0);assert.deepEqual(messages,[]);
});
test('an unsupported Stand rig fails rather than publishing the old sideways bind pose',async()=>{
  const f=fixture(),messages=[];
  f.wasm.SceneModel.craft=()=>{throw Error('unsupported Stand rig');};
  await assert.rejects(loadCraft({read:async()=>new Uint8Array(1)},f.wasm,m=>messages.push(m)),/unsupported Stand rig/);
  assert.deepEqual(messages.map(m=>m.event),['craft-error']);
});
