import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyOf,centreAt,fromInertial,toInertial} from './bodies.js';
import {stepShared,inertialDir,rechartAim} from './shared-flight.js';
import {basis,fromEuler,fromBasis,stepOrient} from './orient.js';

const t=1000,to0=id=>bodyOf(id).circumference,dist=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const near=(a,b,eps,msg)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<eps,`${msg} [${i}] ${v} vs ${b[i]}`));

test('fromBasis inverts basis for arbitrary attitudes', () => {
  let q=fromEuler(.7,-.4);
  for(const step of [{yaw:.3},{pitch:.9},{roll:1.2},{yaw:-2,pitch:.4,roll:-.7}]){
    q=stepOrient(q,step,100000,0);
    const b=basis(q),r=basis(fromBasis(b.right,b.up,b.look));
    near(r.look,b.look,1e-9,'look');near(r.up,b.up,1e-9,'up');near(r.right,b.right,1e-9,'right');
  }
});

// Fly at Elune with a fixed attitude until the gravity well swaps; the attitude and position must be the same physical ones afterwards.
function crossing(startPose,heading) {
  let space,pose=startPose,aim=heading,prev;
  for(let i=0;i<20000;i++){
    prev={pose,parent:space?.parent??'azeroth',aim};
    const r=stepShared(space,pose,aim,{forward:1,fast:true},1/30,t);
    space=r.space;pose=r.pose;
    if(r.swapped)return {before:prev,after:r,space};
    const body=bodyOf(space.parent),towards=centreAt(bodyOf('elune'),t).map((v,k)=>v-space.pos[k]),n=Math.hypot(...towards),u=towards.map(v=>v/n);
    const p=fromInertial(body,space.pos,t,pose[0]),q=fromInertial(body,space.pos.map((v,k)=>v+u[k]),t,p[0]);
    const l=q.map((v,k)=>v-p[k]),m=Math.hypot(...l);
    aim={look:l.map(v=>v/m),right:[1,0,0],up:[0,1,0]};
  }
  throw new Error('no swap');
}

test('the swap preserves world-space position and physical attitude', () => {
  const {before,after,space}=crossing([0,20000,0,0,0],{look:[0,1,0],right:[1,0,0],up:[0,0,-1]});
  assert.equal(after.parent,'elune');
  assert.ok(Math.abs(after.pose[0])<=to0(after.parent)/2+1,`longitude ${after.pose[0]} unwrapped around the Elune chart`);
  const from=bodyOf(before.parent),to=bodyOf(after.parent);
  near(toInertial(to,after.pose,t),space.pos,1e-3,'position');
  const A=rechartAim(from,before.pose,to,after.pose,before.aim,t);
  for(const k of ['look','right','up'])near(A[k],after.aim[k],1e-9,'aim.'+k);
  // Same physical direction: the old chart's aim and the new chart's aim point the same inertial way.
  for(const k of ['look','right','up'])near(inertialDir(from,before.pose,before.aim[k],t),inertialDir(to,after.pose,after.aim[k],t),1e-3,'inertial '+k);
});

test('swapping back restores a consistent chart attitude', () => {
  const a={look:[0,0,-1],right:[1,0,0],up:[0,1,0]},elune=bodyOf('elune'),azeroth=bodyOf('azeroth');
  const pose=[-32000,40000,0],p2=fromInertial(azeroth,toInertial(elune,pose,t),t,0);
  const there=rechartAim(elune,pose,azeroth,p2,a,t),back=rechartAim(azeroth,p2,elune,pose,there,t);
  for(const k of ['look','right','up'])near(back[k],a[k],1e-3,'round trip '+k);
  assert.ok(dist(toInertial(elune,pose,t),toInertial(azeroth,p2,t))<1e-3);
});

test('hovering low over Elune stays above the same ground as the tidally locked moon turns', () => {
  const aim={look:[0,0,-1],right:[1,0,0],up:[0,1,0]};
  let space,pose=[3000,800,0,0,0],t=1000;
  const start=pose.slice();
  for(let i=0;i<600;i++){const r=stepShared(space,pose,aim,{forward:0},1/60,t,2,'elune');space=r.space;pose=r.pose;t+=2/60;}
  assert.ok(Math.hypot(pose[0]-start[0],pose[2]-start[2])<20,`drifted ${pose[0]-start[0]},${pose[2]-start[2]} yd in 10 s`);
  assert.ok(Math.abs(pose[1]-start[1])<20,`altitude ${pose[1]}`);
});
