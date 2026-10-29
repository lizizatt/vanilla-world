import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyOf,centreAt,toInertial} from './bodies.js';
import {basis} from './orient.js';
import {stepShared,chartAxes,framedBody} from './shared-flight.js';
import {relativeCentre} from './body-sky.js';
import {planetFrame} from './space.js';

const unit=a=>{const n=Math.hypot(...a);return a.map(v=>v/n);},dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const elune=bodyOf('elune'),azeroth=bodyOf('azeroth');
// User-reported poses bracketing a swap-out (Elune chart near its south pole, looking back at Elune while flying away).
const A={pose:[-59522.25,6471.29,7768.95],q:[-0.5145,0.4603,0.4604,0.5581],t:1543.567};

/** Where Elune's centre is on screen: its direction in the current chart's (east, up, south) frame, which is the frame the renderer draws look/right/up in. */
const chartDirToElune=(body,pose,pos,t)=>{
  const to=unit(centreAt(elune,t).map((v,i)=>v-pos[i])),ax=chartAxes(body,pose,t);
  return ax.map(a=>dot(a,to));
};

test('chart axes are the renderer eye frame (the shader places Elune where the chart basis says)', () => {
  // The space shader places a body at planetFrame^T (relativeCentre - eye); that must equal the chart-frame direction at any altitude.
  const pose=[-50572.5,265503,26775.7],t=1546,pos=toInertial(azeroth,pose,t);
  const f=planetFrame(pose[0],pose[2],azeroth.centre,azeroth.radius),p=relativeCentre(azeroth,elune,t),local=[f.east,f.up,f.south].map(a=>dot(a,p));
  const centre=[0,-(azeroth.radius+pose[1]),0],shader=unit([0,1,2].map(i=>centre[i]+local[i])),chart=chartDirToElune(azeroth,pose,pos,t);
  chart.forEach((v,i)=>assert.ok(Math.abs(v-shader[i])<1e-6,`axis ${i}: chart ${v} vs shader ${shader[i]}`));
});

test('flying away from Elune keeps it in the same screen direction across the swap to Azeroth', () => {
  let pose=A.pose,aim=basis(A.q),space,t=A.t,swapped=false,prev,frame='E';
  const screen=(r,t)=>chartDirToElune(framedBody(bodyOf(r.parent),r.frame),r.pose,r.space.pos,t);
  const startLook=chartDirToElune(elune,pose,toInertial(elune,pose,t),t);
  assert.ok(dot(startLook,aim.look)>.99,`pose A looks at Elune (${dot(startLook,aim.look)})`);
  for(let i=0;i<4000&&!swapped;i++){
    const r=stepShared(space,pose,aim,{forward:-1,fast:true},1/30,t,2,'elune',frame);
    const here=screen(r,t),aligned=dot(here,r.aim.look);
    // Elune stays on the view axis every frame, including the swap frame.
    assert.ok(aligned>.99,`frame ${i} (${r.parent}): Elune ${aligned} aligned with the look axis`);
    if(prev&&r.swapped)assert.ok(Math.abs(dot(prev.here,prev.look)-aligned)<1e-3,'no screen jump at the swap');
    prev={here,look:r.aim.look};space=r.space;pose=r.pose;aim=r.aim;frame=r.frame;swapped=r.swapped;t+=2/30;
  }
  assert.ok(swapped,'reached the swap');
});
