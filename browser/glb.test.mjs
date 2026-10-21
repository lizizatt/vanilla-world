import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGlb,buildVehicle,vehicleMetadata,toModel} from './glb.js';
import {makeGlb,sampleVehicle} from './glb-fixture.mjs';

test('sample GLB converts to craft layout with markers in model space',()=>{
  const v=buildVehicle(parseGlb(sampleVehicle([.5,.25,1,1])));
  assert.equal(v.vertices.length%12,0);assert.equal(v.indices.length,3*36);assert.equal(v.batches.length,1);
  assert.deepEqual(Array.from(v.vertices.slice(8,12)),[.5,.25,1,1]);
  assert.ok(v.indices.every(i=>i<v.vertices.length/12));
  // Cockpit at glTF (0,1.2,-.2) is .2 ahead (model +x), 1.2 up (model +z).
  assert.deepEqual(v.markers.cockpit.map(n=>+n.toFixed(6)),[.2,0,1.2]);
  assert.deepEqual(v.markers.exhausts.map(e=>e.side).sort(),['L','R']);
  assert.ok(v.markers.exhausts.every(e=>e.at[0]<0),'exhausts are behind the craft (glTF +z)');
  assert.equal(v.markers.engines[0].side,'L');
  const m=vehicleMetadata(v);
  assert.equal(m.exhausts.length,2);assert.equal(m.posedAttachment0.position[2],1.2-.75);
});
test('axis conversion is a proper rotation: forward -z -> +x, right +x -> -y(left)',()=>{
  const t=(...a)=>toModel(...a).map(n=>n+0);assert.deepEqual(t(0,0,-1),[1,0,0]);assert.deepEqual(t(1,0,0),[0,-1,0]);assert.deepEqual(t(0,1,0),[0,0,1]);
});
test('node transforms apply to geometry',()=>{
  const g=parseGlb(sampleVehicle());g.json.nodes[1].translation=[0,0,-10];
  const v=buildVehicle(g),xs=[];for(let i=0;i<v.vertices.length;i+=12)xs.push(v.vertices[i]);
  assert.ok(Math.max(...xs)>10);
});
test('malformed or unsupported files are rejected, not half-loaded',()=>{
  assert.throws(()=>parseGlb(new ArrayBuffer(8)),/not a GLB/);
  assert.throws(()=>parseGlb(makeGlb({asset:{version:'2.0'}}).slice(0,30)),/truncated/);
  const g=parseGlb(sampleVehicle());g.json.accessors[1].count=1e6;
  assert.throws(()=>buildVehicle(g),/past the buffer/);
  const h=parseGlb(sampleVehicle());h.json.meshes[0].primitives[0].mode=1;
  assert.throws(()=>buildVehicle(h),/triangle/);
  const s=parseGlb(sampleVehicle());s.json.scenes=[];s.json.scene=0;
  assert.throws(()=>buildVehicle(s),/no scene/);
});
