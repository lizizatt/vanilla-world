import test from 'node:test';
import assert from 'node:assert/strict';
import {gibTrigger,overheatTrigger,splitParts,crumple,partMatrix,craftFrame,appendWreckChunk,wreckFrame} from './wreck.js';

// Body triangle at the rear, plus left (+y) and right (-y) engine triangles far forward; stride 12.
const tri = (x, y) => [[x, y, 0], [x + 1, y, 0], [x, y, 1]].flatMap(p => [...p, 0, 0, 1, 0, 0, 1, 1, 1, 1]);
const vertices = Float32Array.from([...tri(-4, 0), ...tri(4, 2), ...tri(4, -2)]);
const indices = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const batches = [{ firstIndex: 0, indexCount: 9, texture: null }];

test('splitParts separates pod, left engine and right engine', () => {
  const [pod, left, right] = splitParts(vertices, indices, batches);
  assert.deepEqual([pod.indices.length, left.indices.length, right.indices.length], [3, 3, 3]);
  assert.ok(left.center[1] > 0 && right.center[1] < 0 && left.center[0] > pod.center[0]);
  assert.equal(left.batches[0].indexCount, 3);
});

test('a craft with a centred engine has no engine parts', () => {
  const [pod, left, right] = splitParts(Float32Array.from([...tri(-4, 0), ...tri(4, 0)]), Uint32Array.from([0, 1, 2, 3, 4, 5]), [{ firstIndex: 0, indexCount: 6 }]);
  assert.equal(pod.indices.length, 6);
  assert.ok(left.empty && right.empty);
});

test('crumple dents only the front, deterministically, without touching other attributes', () => {
  const a = crumple(vertices, 5), b = crumple(vertices, 5);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, crumple(vertices, 6));
  assert.deepEqual(a.slice(0, 12), vertices.slice(0, 12));
  assert.notEqual(a[36], vertices[36]);
  for (let i = 0; i < a.length; i += 12) assert.deepEqual(a.slice(i + 3, i + 12), vertices.slice(i + 3, i + 12));
});

test('partMatrix places a part centre at the body position', () => {
  const m = partMatrix([10, 5, 20, 0, 0, 0, 1], [2, 0, 0], 0.5, [4, 6]);
  const world = [0, 1, 2].map(a => m[a] * 2 + m[12 + a]);
  assert.deepEqual(world, [6, 5, 14]);
});

test('craftFrame removes the scale', () => {
  const m = new Float32Array(16);
  m.set([0, 0, -.5, 0, -.5, 0, 0, 0, 0, .5, 0, 0, 1, 2, 3, 1]);
  assert.deepEqual(Array.from(craftFrame(m, .5).rot), [0, 0, -1, -1, 0, 0, 0, 1, 0]);
});

test('recorded chunks replay and hold the last frame', () => {
  const w = { frames: [], connected: [] };
  assert.equal(wreckFrame(w, 0), undefined);
  appendWreckChunk(w, Float32Array.from([...Array(14).fill(1), ...Array(14).fill(2), 1, 0]), 2);
  assert.equal(w.frames.length, 2);
  assert.deepEqual(w.connected, [true, false]);
  assert.equal(wreckFrame(w, 0)[0], 1);
  assert.equal(wreckFrame(w, 99)[0], 2);
});

test('gibTrigger fires on a fast contact edge only, once, with cooldown',()=>{
  const mem={},at=(hit,speed)=>[0,0,0,0,0,speed,0,0,hit?3:0];
  assert.equal(gibTrigger(mem,at(false,200),true,100,0),false);
  assert.equal(gibTrigger(mem,at(true,10),true,100,10),true);
  assert.equal(gibTrigger(mem,at(true,10),true,100,20),false);
  gibTrigger(mem,at(false,200),true,100,30);
  assert.equal(gibTrigger(mem,at(true,10),true,100,40),false);
  gibTrigger(mem,at(false,200),true,100,6000);
  assert.equal(gibTrigger(mem,at(true,10),false,100,6010),false);
  gibTrigger(mem,at(false,50),true,100,6020);
  assert.equal(gibTrigger(mem,at(true,10),true,100,12000),false);
  gibTrigger(mem,at(false,200),true,100,12010);
  assert.equal(gibTrigger(mem,at(true,10),true,100,12020,true),false);
});
test('overheatTrigger fires once when heat maxes while boosting, honours option, cooldown and gib cooldown',()=>{
  const mem={},at=heat=>[0,0,0,0,0,150,heat];
  assert.equal(overheatTrigger(mem,at(.5),true,true,0),false);
  assert.equal(overheatTrigger(mem,at(1),true,true,10000),true);
  assert.equal(overheatTrigger(mem,at(1),true,true,10100),false,'held at max: no repeat');
  overheatTrigger(mem,at(.7),true,true,10200);
  assert.equal(overheatTrigger(mem,at(1),true,true,12000),false,'5 s cooldown');
  overheatTrigger(mem,at(.7),true,true,20000);
  assert.equal(overheatTrigger(mem,at(1),false,true,21000),false,'not boosting');
  overheatTrigger(mem,at(.7),true,true,30000);
  assert.equal(overheatTrigger(mem,at(1),true,false,31000),false,'option off');
  overheatTrigger(mem,at(.7),true,true,40000);
  assert.equal(overheatTrigger(mem,at(1),true,true,41000,true),false,'blocked');
  overheatTrigger(mem,at(.7),true,true,50000);
  mem.at=49000;
  assert.equal(overheatTrigger(mem,at(1),true,true,51000),false,'shares the gib cooldown');
});
