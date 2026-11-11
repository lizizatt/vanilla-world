import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderer} from './world-renderer.js';
import {cancelEvents} from './renderer-events.js';

const resource=()=>({destroyed:0,destroy(){this.destroyed++;}});
const rig=()=>{
  const renderer=Object.create(WorldRenderer.prototype);
  Object.assign(renderer,{manifest:{},sceneRegion:0,instances:[],assets:new Map(),textures:new Map(),items:new Map(),
    buffer:resource,texture:resource,prepareBatches:b=>b});
  return renderer;
};
const scene=n=>({event:'scene',region:0,removedAssets:[],removedTextures:[],
  assets:Array.from({length:n},(_,i)=>({key:`a${i}`,vertices:new Float32Array(12),indices:new Uint32Array([0]),batches:[]})),
  textures:Array.from({length:n},(_,i)=>({key:`t${i}`,width:1,height:1,rgba:new Uint8Array(4)})),instances:[]});
const withUsage=fn=>{const old=globalThis.GPUBufferUsage;globalThis.GPUBufferUsage={VERTEX:1,INDEX:2};try{return fn();}finally{if(old===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=old;}};

test('budgeted scene uploads are deferred, spread over drains and land atomically',()=>withUsage(()=>{
  const r=rig();r.uploadBudget=1;
  r.event(scene(5));
  assert.equal(r.assets.size,0);assert.equal(r.textures.size,0);assert.equal(r.eventQueue.length,1);
  clearTimeout(r.drainTimer);
  let drains=0;
  while(r.eventQueue.length){r.drainEvents(0);drains++;assert(drains<50);}
  assert(drains>=5,`spread over ${drains} drains`);
  assert.equal(r.assets.size,5);assert.equal(r.textures.size,5);
}));

test('budgeted drain keeps event order and sync mode converges to the same state',()=>withUsage(()=>{
  const sync=rig();sync.event(scene(3));sync.event({...scene(0),removedAssets:['a0'],removedTextures:['t1']});
  const lazy=rig();lazy.uploadBudget=1;
  lazy.event(scene(3));lazy.event({...scene(0),removedAssets:['a0'],removedTextures:['t1']});
  clearTimeout(lazy.drainTimer);lazy.drainEvents(Infinity);
  assert.deepEqual([...lazy.assets.keys()],[...sync.assets.keys()]);
  assert.deepEqual([...lazy.textures.keys()],[...sync.textures.keys()]);
}));

test('cancelEvents (reset) drops queued uploads and releases partial builds',()=>withUsage(()=>{
  const r=rig();r.uploadBudget=1;
  const made=[];r.texture=()=>{const t=resource();made.push(t);return t;};
  r.event(scene(4));
  r.drainEvents(0);r.drainEvents(0);
  assert.equal(made.length,2);
  cancelEvents(r);
  assert(made.every(t=>t.destroyed===1));
  assert.equal(r.eventQueue.length,0);assert.equal(r.drainTimer,undefined);
  r.drainEvents(Infinity);assert.equal(r.assets.size,0);
}));
test('a failing deferred event reports through onEventError with its payload and the queue continues',()=>withUsage(()=>{
  const r=rig();r.uploadBudget=1;const errors=[];
  r.onEventError=(error,data)=>errors.push([error.message,data.event]);
  r.event({...scene(1),instances:null});
  r.event(scene(1));
  clearTimeout(r.drainTimer);r.drainEvents(Infinity);
  assert.deepEqual(errors,[['Invalid scene instances','scene']]);
  assert.equal(r.assets.size,1);
}));
