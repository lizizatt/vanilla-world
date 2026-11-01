import test from 'node:test';
import assert from 'node:assert/strict';
import {flameAsset,vehiclePayload,loadVehicleModel} from './vehicle-model.js';
import {sampleVehicle} from './glb-fixture.mjs';

test('flame cone is a valid additive, depth-write-free batch behind the exhaust',()=>{
  const f=flameAsset();
  assert.equal(f.vertices.length%12,0);assert.ok(f.indices.every(i=>i<f.vertices.length/12));
  assert.equal(f.batches[0].blend,'add');assert.equal(f.batches[0].noDepthWrite,true);
  assert.ok(Math.min(...Array.from({length:f.vertices.length/12},(_,i)=>f.vertices[i*12]))<0);
});
test('vehicle payload carries exhausts, cockpit seat and flame',()=>{
  const p=vehiclePayload(sampleVehicle());
  assert.equal(p.metadata.exhausts.length,2);assert.ok(p.flame);assert.equal(p.metadata.display,0);
  assert.equal(p.asset.batches.length,1);
});
test('loader rejects HTTP errors and non-GLB bodies (SPA fallback)',async()=>{
  const skin={id:'x',model:'./vehicles/x.glb'};
  await assert.rejects(loadVehicleModel(skin,async()=>new Response('nope',{status:404})),/HTTP 404/);
  await assert.rejects(loadVehicleModel(skin,async()=>new Response('<!doctype html><title>x</title><p>hello world</p>')),/not a GLB/);
  const ok=await loadVehicleModel(skin,async()=>new Response(sampleVehicle()));
  assert.equal(ok.key,'glb:x');assert.deepEqual(ok.textures,[]);
});
