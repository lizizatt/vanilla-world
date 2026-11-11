import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRay,makeDrag,pixelRay,pickHandle,beginDrag,dragTo,closestOnLine,worldPerPixel,projectInto,GIZMO_PX} from './gizmo.js';
import {project} from './track-edit.js';

// Camera 100 yd south of the origin looking north (-z), slightly above.
const view={eye:[0,0,100],right:[1,0,0],up:[0,1,0],look:[0,0,-1],aspect:16/9};
const W=1600,H=900;

test('pixelRay through the screen centre is the look direction and matches project()',()=>{
  const r=pixelRay(view,W,H,W/2,H/2,makeRay());
  assert.deepEqual(r.d.map(v=>+v.toFixed(9)+0),[0,0,-1]);
  const p=[30,-12,0],s=project(view,W,H,p),ray=pixelRay(view,W,H,s[0],s[1],makeRay());
  const t=(p[2]-ray.o[2])/ray.d[2];
  assert.ok(Math.hypot(ray.o[0]+ray.d[0]*t-p[0],ray.o[1]+ray.d[1]*t-p[1])<1e-6);
  const out=[];assert.ok(projectInto(view,W,H,p[0],p[1],p[2],out));
  assert.ok(Math.abs(out[0]-s[0])<1e-9&&Math.abs(out[1]-s[1])<1e-9);
});
test('closestOnLine finds the axis parameter and rejects parallel lines',()=>{
  const out={};
  assert.ok(closestOnLine({o:[5,0,0],d:[0,1,0]},[0,0,0],[1,0,0],out));
  assert.ok(Math.abs(out.t-5)<1e-9&&out.dist<1e-9);
  assert.equal(closestOnLine({o:[0,5,0],d:[1,0,0]},[0,0,0],[1,0,0],out),false);
});
test('handles are picked by ray, the nearest axis wins, misses return undefined',()=>{
  const o=[0,0,0],len=worldPerPixel(view,H,o)*GIZMO_PX,tol=10*worldPerPixel(view,H,o);
  const at=p=>{const s=project(view,W,H,p);return pixelRay(view,W,H,s[0],s[1],makeRay());};
  assert.equal(pickHandle(at([len*.6,0,0]),o,len,tol),'x');
  assert.equal(pickHandle(at([0,len*.6,0]),o,len,tol),'y');
  const top={eye:[0,300,40],right:[1,0,0],up:[0,.1313,-.9913],look:[0,-.9913,-.1313],aspect:16/9},l2=worldPerPixel(top,H,o)*GIZMO_PX;
  const s=project(top,W,H,[l2*.35,0,l2*.35]);
  assert.equal(pickHandle(pixelRay(top,W,H,s[0],s[1],makeRay()),o,l2,10*worldPerPixel(top,H,o)),'xz');
  assert.equal(pickHandle(at([len*.6,len*.6,0]),o,len,tol),undefined);
  assert.equal(pickHandle(at([-len,0,0]),o,len,tol),undefined);
});
test('dragging an axis moves only along it and follows the pointer exactly',()=>{
  const pos=[10,20,30],d=makeDrag(),out=[0,0,0],pointer=p=>{const s=project(view,W,H,p);return pixelRay(view,W,H,s[0],s[1],makeRay());};
  const start=[10+20,20,30];
  assert.ok(beginDrag(d,pointer(start),pos,'x'));
  assert.ok(dragTo(d,pointer([10+45,20,30]),out));
  assert.ok(Math.abs(out[0]-35)<1e-6&&out[1]===20&&out[2]===30);
  // pointer wandering off the axis still only changes x
  assert.ok(dragTo(d,pointer([10+45,70,30]),out));assert.equal(out[1],20);assert.equal(out[2],30);
});
test('the ground-plane handle drags in x/z and leaves y',()=>{
  const pos=[0,5,0],d=makeDrag(),out=[0,0,0],cam={eye:[0,300,0],right:[1,0,0],up:[0,0,-1],look:[0,-1,0],aspect:1};
  const at=p=>{const s=project(cam,W,H,p);return pixelRay(cam,W,H,s[0],s[1],makeRay());};
  assert.ok(beginDrag(d,at([10,5,10]),pos,'xz'));
  assert.ok(dragTo(d,at([40,5,-25]),out));
  assert.ok(Math.abs(out[0]-30)<1e-6&&out[1]===5&&Math.abs(out[2]+35)<1e-6);
});
test('a ray parallel to the axis leaves the gate where it was',()=>{
  const d=makeDrag(),out=[0,0,0],pos=[1,2,3],ray={o:[0,0,0],d:[0,0,-1]};
  assert.equal(beginDrag(d,ray,pos,'z'),false);
});
test('gizmo size is constant on screen at any distance',()=>{
  for(const dist of [30,300]){
    const v={...view,eye:[0,0,dist]},len=worldPerPixel(v,H,[0,0,0])*GIZMO_PX,a=project(v,W,H,[0,0,0]),b=project(v,W,H,[0,len,0]);
    assert.ok(Math.abs(Math.abs(a[1]-b[1])-GIZMO_PX)<1e-6);
  }
});

import {makeRot,pickRing,beginRot,rotTo,wrapAngle,snapAngle,RING_R} from './gizmo.js';
const down={eye:[0,100,0],right:[1,0,0],up:[0,0,-1],look:[0,-1,0],aspect:1};
const atGround=(x,z)=>{const s=project(down,W,H,[x,0,z]);return pixelRay(down,W,H,s[0],s[1],makeRay());};
test('wrapAngle and snapAngle',()=>{
  assert.ok(Math.abs(wrapAngle(3*Math.PI)-Math.PI)<1e-9||Math.abs(wrapAngle(3*Math.PI)+Math.PI)<1e-9);
  assert.ok(Math.abs(wrapAngle(-.5+2*Math.PI)+.5)<1e-9);
  assert.ok(Math.abs(snapAngle(.27)-15*Math.PI/180)<1e-12&&Math.abs(snapAngle(.2)-15*Math.PI/180)<1e-12&&snapAngle(.1)===0);
});
test('ring is picked near its radius only',()=>{
  const o=[0,0,0],len=40,R=len*RING_R;
  assert.ok(pickRing(atGround(R,0),o,len,3));assert.ok(pickRing(atGround(0,-R+2),o,len,3));
  assert.equal(pickRing(atGround(0,0),o,len,3),false);assert.equal(pickRing(atGround(R+6,0),o,len,3),false);
  assert.equal(pickRing({o:[0,50,0],d:[1,0,0]},o,len,3),false);
});
test('ring drag keeps the grabbed point under the cursor, wraps, and snaps',()=>{
  const o=[10,0,5],rot=makeRot(),R=25,yaw0=.3;
  // forward of yaw is (-sin,-cos): grab 90 deg round from forward, drag another 40 deg
  const at=y=>atGround(o[0]-Math.sin(y)*R,o[2]-Math.cos(y)*R);
  assert.ok(beginRot(rot,at(yaw0),o,yaw0));
  assert.ok(Math.abs(rotTo(rot,at(yaw0),o)-yaw0)<1e-6);
  assert.ok(Math.abs(rotTo(rot,at(yaw0+.7),o)-(yaw0+.7))<1e-6);
  assert.ok(Math.abs(rotTo(rot,at(yaw0+4),o)-wrapAngle(yaw0+4))<1e-6);
  assert.ok(Math.abs(rotTo(rot,at(yaw0+.5),o,15)-snapAngle(yaw0+.5))<1e-6);
  assert.equal(rotTo(rot,{o:[0,50,0],d:[1,0,0]},o),undefined);
  assert.equal(beginRot(rot,{o:[0,50,0],d:[1,0,0]},o,0),false);
});