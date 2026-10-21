import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadCraft} from './craft-stream.js';
import {craftMatrix} from './world-renderer.js';

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
test('an unsupported Stand rig fails rather than publishing the old sideways bind pose',async()=>{
  const f=fixture(),messages=[];
  f.wasm.SceneModel.craft=()=>{throw Error('unsupported Stand rig');};
  await assert.rejects(loadCraft({read:async()=>new Uint8Array(1)},f.wasm,m=>messages.push(m)),/unsupported Stand rig/);
  assert.deepEqual(messages.map(m=>m.event),['craft-error']);
});
