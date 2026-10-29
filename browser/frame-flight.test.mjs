import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyOf,toInertial} from './bodies.js';
import {stepShared,framedBody} from './shared-flight.js';
import {dirToChart} from './frames.js';
import {basis,fromEuler} from './orient.js';

// Fly "north" along the surface at low altitude on each body, stepping the real fly path; the pose must hop E->N at the handoff latitude without moving the camera.
function fly(bodyId,startLatDeg,input,steps,aimOf) {
  const body=bodyOf(bodyId),lat=startLatDeg*Math.PI/180,[x,z]=dirToChart('E',[Math.cos(lat),Math.sin(lat),0],body.centre,body.radius,0);
  let pose=[x,300,z,0,0],space,frame='E',aim=aimOf(pose),t=1000;
  const hops=[],seen=[];
  for(let i=0;i<steps;i++) {
    const before=space?.pos;
    const r=stepShared(space,pose,aim,input,1/30,t,0,bodyId,frame);
    if(r.frame!==frame){hops.push({from:frame,to:r.frame,i});frame=r.frame;}
    space=r.space;pose=r.pose;aim=r.aim;seen.push({frame,pose,before,after:space.pos});
  }
  return {hops,frame,seen,body};
}
const northAim=pose=>basis(fromEuler(0,0));

for(const id of ['azeroth','elune']) {
  test(`${id}: flying north hops E to N once, with the camera's inertial position continuous`,()=>{
    const body=bodyOf(id),start=id==='azeroth'?70:58;
    // look is the chart's up-the-screen (-z) direction = north; fast flight moves ~8 kyd/s at 300 yd on a ~14 kyd radius, so ~600 steps crosses the handoff.
    const r=fly(id,start,{forward:1,fast:true},900,northAim);
    assert.ok(r.hops.length>=1,'hopped');
    assert.deepEqual(r.hops[0],{from:'E',to:'N',i:r.hops[0].i});
    const hop=r.seen[r.hops[0].i],frameBody=framedBody(body,'N');
    const inertialPose=toInertial(frameBody,hop.pose,1000+0);
    const space=hop.after,moved=Math.hypot(...inertialPose.map((v,k)=>v-space[k]));
    assert.ok(moved<body.radius*0.01,`pose re-expressed in N stays at the camera (${moved.toFixed(2)} yd)`);
  });
}

test('flying over the pole hops E to N to E exactly once each (no ping-pong at the handoff)', () => {
  const r=fly('elune',58,{forward:1,fast:true},30,northAim);
  assert.deepEqual(r.hops.map(h=>h.from+h.to),['EN','NE']);
});