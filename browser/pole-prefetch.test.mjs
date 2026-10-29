import test from 'node:test';
import assert from 'node:assert/strict';
import {hopTargets,frameOfPoint,poleLanding} from './pole-prefetch.js';
import {POLE_FRAME_SPEC} from './pole-source.js';
import {dirToChart,chartToDir,bodyLat,POLE_ANCHORS,trueLength} from './frames.js';

const spec=POLE_FRAME_SPEC.azeroth,margin=2500/spec.radius,deg=Math.PI/180;
const at=latDeg=>{const l=latDeg*deg;return dirToChart('E',[Math.cos(l),Math.sin(l),0],spec.centre,spec.radius,0);};

test('far from the boundary nothing is prefetched', () => {
  assert.deepEqual(hopTargets(spec,0,at(40),margin),[]);
  assert.deepEqual(hopTargets(spec,0,at(-40),margin),[]);
});
test('approaching the handoff in E targets the pole chart at the hop landing point', () => {
  const t=hopTargets(spec,0,at(71),margin);
  assert.equal(t.length,2);
  const [x,z]=t[0],a=POLE_ANCHORS.N,d=chartToDir('N',x-a[0],z-a[1],spec.centre,spec.radius);
  assert.ok(Math.abs(bodyLat(d)-spec.handoff)<1e-9,'lands on the handoff circle');
  assert.ok(Math.hypot(x-a[0],z-a[1])<spec.radius*(Math.PI/2-spec.handoff)+1,'inside the pole chart');
});
test('the south pole uses the S anchor', () => {
  const [x,z]=hopTargets(spec,0,at(-71),margin)[0];
  assert.ok(Math.hypot(x-POLE_ANCHORS.S[0],z-POLE_ANCHORS.S[1])<spec.radius*(Math.PI/2-spec.handoff)+1);
});
test('inside the pole frame near the boundary targets E below the handoff', () => {
  const a=POLE_ANCHORS.N,l=72.5*deg,c=dirToChart('N',[Math.cos(l),Math.sin(l),0],spec.centre,spec.radius);
  assert.ok(c.length===2);
  const t=hopTargets(spec,1,[c[0]+a[0],c[1]+a[1]],margin);
  assert.equal(t.length,2);
});
test('deep in the pole frame nothing is prefetched', () => {
  const a=POLE_ANCHORS.N;assert.deepEqual(hopTargets(spec,1,[a[0]+100,a[1]+100],margin),[]);
});
test('frameOfPoint reads the region a point sits in', () => {
  const manifest={regions:[{frame:0,placement:[-9000,-9000],tile_count:[64,64]},{frame:0,placement:[0,-9000],tile_count:[64,64]},{frame:1,placement:[POLE_ANCHORS.N[0]-5333,POLE_ANCHORS.N[1]-5333],tile_count:[20,20]}],ocean:[-9000,-9000,9000,9000]};
  assert.equal(frameOfPoint(manifest,[0,0]),0);
  assert.equal(frameOfPoint(manifest,[POLE_ANCHORS.N[0]+10,POLE_ANCHORS.N[1]+10]),1);
});

test('a landing equatorward of the handoff stays in E; poleward it is re-expressed in the pole chart with the same speed', () => {
  assert.equal(poleLanding(spec,[...at(60),0].slice(0,1).concat([5,at(60)[1]]),0,[1,0,2]),undefined);
  const p=at(74),land=poleLanding(spec,[p[0],5,p[1]],0.3,[3,1,-4]);
  assert.equal(land.pose[4],1);
  assert.equal(land.pose[1],5);
  const trueSpeed=trueLength('E',p[0],p[1],3,-4,spec.centre,spec.radius),polar=trueLength('N',land.pose[0],land.pose[2],land.velocity[0],land.velocity[2],spec.centre,spec.radius);
  assert.ok(Math.abs(polar-trueSpeed)<.02*trueSpeed,`true ground speed is preserved (${polar} vs ${trueSpeed})`);
  assert.equal(poleLanding(undefined,[0,0,0],0,[0,0,0]),undefined);
});