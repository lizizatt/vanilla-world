import test from 'node:test';
import assert from 'node:assert/strict';
import { nearChunksReady, NEAR_TIMEOUT_MS, ARRIVAL,arrivalReadiness,arrivalResources } from './loading-gate.js';

test('arrival requires exact terrain, critical collision, nearest geometry and its textures',()=>{
  const renderer={tiles:new Map([[2,{}],[3,{}]]),assets:new Map([['tree',{}]]),textures:new Map()};
  const state={resident:[2,3],arrival:{tiles:[2,3],ground:true,waiting:0,
    resources:{selected:true,roots:[],keys:['tree'],textures:['texture:leaf'],loaded:1,critical:0,models:1,npcs:0}}};
  assert.equal(arrivalReadiness(state,renderer,0).ready,false,'Cutout geometry without a texture is not a visible placeholder');
  renderer.textures.set('leaf',{});
  assert.equal(arrivalReadiness(state,renderer,0).ready,true);
  state.arrival.resources.roots=['unexpanded-building'];
  assert.equal(arrivalReadiness(state,renderer,0).checks.scenery,false);
  state.arrival.resources.roots=[];
  state.arrival.tiles=[2,4];
  assert.equal(arrivalReadiness(state,renderer,0).checks.terrain,false,'Departure tiles do not satisfy destination coverage');
  state.arrival.tiles=[2,3];state.arrival.waiting=1;
  assert.equal(arrivalReadiness(state,renderer,0).checks.ground,false);
  state.arrival.waiting=0;state.arrival.resources.critical=1;
  assert.equal(arrivalReadiness(state,renderer,0).checks.critical,false);
  const timeout=arrivalReadiness(state,renderer,ARRIVAL.timeoutMs);
  assert.equal(timeout.ready,false);assert.equal(timeout.proceed,true);assert.equal(timeout.timedOut,true);
  assert.equal(arrivalReadiness(undefined,renderer,0).proceed,false);
});

test('nearest model and NPC quotas are separate, deduplicated and bounded to the arrival radius',()=>{
  const scene={visualPosition:[0,0,0],position:[0,0,0],map:1,visualMap:1,placementRevision:1,visualPlacementRevision:1,cache:new Map(),requests:new Map(),failures:new Map(),
    instances:Array.from({length:20},(_,i)=>({id:`model:${i}`,key:`m${i}`,score:20-i}))};
  scene.instances.push(...Array.from({length:8},(_,i)=>({id:`1:npc:${i}`,key:'person',score:i})));
  scene.instances.push({id:'outside',key:'outside',score:129});
  scene.cache.set('person',{value:{batches:[{texture:'skin'}]}});
  scene.requests.set('required',{key:'required',required:true});scene.failures.set('required',{});
  const ready=arrivalResources(scene);
  assert.equal(ready.models,8);assert.equal(ready.npcs,4);
  assert.equal(ready.keys.length,9);assert.equal(ready.loaded,1);
  assert(!ready.keys.includes('outside'));assert.deepEqual(ready.textures,['texture:skin']);
  assert.equal(ready.critical,1);assert.equal(ready.failed,1);
  assert.equal(ready.selected,true);scene.position=[1000,0,0];
  assert.equal(arrivalResources(scene).selected,false,'Old visual selection is not destination readiness');
  scene.position=[0,0,0];scene.placementRevision++;
  assert.equal(arrivalResources(scene).selected,false,'Newly arrived placement metadata must be selected first');
  scene.placementRevision--;scene.revision=2;scene.visualRevision=1;
  assert.equal(arrivalResources(scene).selected,false,'New WMO metadata must expand into group instances first');
  scene.requests.set('building',{key:'building',kind:'wmo',score:40});
  assert.deepEqual(arrivalResources(scene).roots,['building']);
});

test('waits for the first handful of nearby chunks, bounded by a timeout', () => {
  assert.equal(nearChunksReady({ total: 9, resident: 3 }, 0), false);
  assert.equal(nearChunksReady({ total: 9, resident: 4 }, 0), true);
  assert.equal(nearChunksReady({ total: 2, resident: 2 }, 0), true, 'edge of the world needs fewer');
  assert.equal(nearChunksReady({ total: 0, resident: 0 }, 0), true);
  assert.equal(nearChunksReady({ total: 9, resident: 0 }, NEAR_TIMEOUT_MS), true, 'timeout releases');
  assert.equal(nearChunksReady(undefined, 0), true, 'older engines report nothing');
});
