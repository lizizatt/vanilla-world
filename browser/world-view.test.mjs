import test from 'node:test';
import assert from 'node:assert/strict';
import {boundsVisible,sceneVisible,validateView,viewChanged} from './world-view.js';
import {WorldRenderer,cameraAxes} from './world-renderer.js';
import {cameraView} from './world-camera.js';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const view={eye:[0,0,0],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1.6};
test('a chase camera clipped to its pivot retains a valid basis during suspension bounce',()=>{
  const rig={camera:[0,100,15],chase:[0,0],chaseGrounded:true,chaseY:100,chaseBounce:.2,
    clipCamera:pivot=>pivot};
  const state=[0,100,0,0,0,0,1,1,0];
  const {look}=cameraView(rig,state,undefined,.016,[0,0]);
  assert.deepEqual(look,[0,1,0]);
  validateView({...view,look,...cameraAxes(look)});
  for(const pole of [[0,-1,0],[0,0,1],[1,0,0]]){
    const axes=cameraAxes(pole,pole);
    validateView({...view,look:pole,...axes});
    assert(Math.abs(axes.right.reduce((n,v,i)=>n+v*pole[i],0))<1e-10);
  }
});
test('views reject malformed camera metadata and cull only known outside bounds',()=>{
  validateView(view);
  for(const bad of [null,{...view,eye:[NaN,0,0]},{...view,look:[0,0,0]},{...view,aspect:0}])
    assert.throws(()=>validateView(bad));
  assert(boundsVisible(undefined,view));
  assert(boundsVisible([[-1,-1,100],[1,1,110]],view));
  assert(!boundsVisible([[-1,-1,-110],[1,1,-100]],view));
  assert(!boundsVisible([[1000,-1,100],[1010,1,110]],view));
  assert(boundsVisible([[-1000,-1000,-1000],[1000,1000,1000]],view));
});
test('guarded cached bounds retain newly visible points before camera refresh',()=>{
  for(const aspect of [.2,1,1.6,8]){
    const old={...view,aspect},yaw=.019*Math.min(1,aspect,1/aspect);
    const next={...old,eye:[15,0,0],right:[Math.cos(yaw),0,-Math.sin(yaw)],look:[Math.sin(yaw),0,Math.cos(yaw)]};
    assert(!viewChanged(old,next));
    for(const depth of [1,100,1000,100000])for(const x of [-1,-.5,0,.5,1])for(const y of [-1,0,1]){
      const p=next.eye.map((v,i)=>v+next.look[i]*depth+next.right[i]*x*.55*aspect*depth+next.up[i]*y*.55*depth);
      assert(sceneVisible([p,p],identity,next.eye,next.right,next.up,next.look,aspect));
      assert(boundsVisible([p,p],old),'Caching cannot omit a newly visible point');
    }
    assert(viewChanged(old,{...old,eye:[16,0,0]}));
    assert(viewChanged(old,{...old,look:[1,0,0]}));
  }
});
test('terrain bounds include elevated geometry and translated tile overhangs',()=>{
  const previous=globalThis.GPUBufferUsage;globalThis.GPUBufferUsage={VERTEX:1};
  try{
    const renderer={buffer:()=>({}),device:{createBindGroup:()=>({})},pipeline:{getBindGroupLayout:()=>({})}};
    const vertices=new Float32Array([-2,-10,7,0,0,0,0,5,200,-3,0,0,0,0]);
    const item=WorldRenderer.prototype.drawable.call(renderer,vertices,[100,200],{createView:()=>({})});
    assert.deepEqual(item.bounds,[[98,-10,197],[105,200,207]]);
  }finally{globalThis.GPUBufferUsage=previous;}
});
