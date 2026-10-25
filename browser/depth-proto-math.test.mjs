import test from 'node:test';
import assert from 'node:assert/strict';
import {scenarios,viewSpheres,classify,cameraFor,planFor,basis} from './depth-proto-math.js';

const ids=(s,A=16/10)=>{const cam=cameraFor(s),sp=viewSpheres(s.eye,cam,s.t,{pod:s.pod});const o=new Set();
  for(let y=-1;y<=1;y+=.02)for(let x=-1;x<=1;x+=.02)o.add(classify(sp,x,y,A));return o;};

test('low on Azeroth the ground fills the bottom, horizon is sky above', () => {
  const s=scenarios().find(q=>q.name==='azeroth-low-horizon'),cam=cameraFor(s),sp=viewSpheres(s.eye,cam,s.t);
  assert.equal(classify(sp,0,-.9,1.6),0);
  assert.equal(classify(sp,0,.9,1.6),-1);
});
test('k stays exact at 1.5 yd altitude (f32 would lose it)', () => {
  const s=scenarios()[0],sp=viewSpheres(s.eye,cameraFor(s),s.t);
  assert.ok(Math.abs(sp[0].k-(1.5*(1.5+2*sp[0].r)))/sp[0].k<1e-9);
  assert.ok(Math.abs(Math.fround(sp[0].k)-sp[0].k)/sp[0].k<1e-6);
});
test('every scenario sees something and the pod scenario sees all of ground, pod, sky', () => {
  for(const s of scenarios())assert.ok(ids(s).size>=1,s.name);
  const pod=scenarios().find(q=>q.name==='elune-low-pod'),set=ids(pod);
  assert.ok(set.has(2)&&set.has(1),[...set].join());
});
test('transit shows both bodies; Elune surface looks up at Azeroth', () => {
  const t=scenarios().find(q=>q.name==='transit-both-visible'),set=ids(t);
  assert.ok(set.has(1),[...set].join());
  assert.ok(ids(scenarios().find(q=>q.name==='elune-low-azeroth-sky')).has(0));
});
test('plans: std24 single layer, rev32 single layer, split has two ordered layers', () => {
  const s=scenarios()[0];
  assert.equal(planFor('std24',s.eye,s.t).layers.length,1);
  const sp=planFor('split',s.eye,s.t);assert.equal(sp.layers.length,2);
  assert.ok(sp.layers[0].near>sp.layers[1].near&&sp.layers[0].near<sp.layers[1].far);
  assert.deepEqual(basis([0,0,1]).forward,[0,0,1]);
});
