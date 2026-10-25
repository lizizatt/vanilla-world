import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraCollision} from './camera-collision.js';
import {cameraView,lifted} from './world-camera.js';

const TILE=1600/3,CELLS=32;
function collisionWithGround(y,sea=0) {
  const c=new CameraCollision(),offsets=new Uint32Array(CELLS*CELLS+1);
  for(let i=1;i<offsets.length;i++)offsets[i]=1*9;
  c.manifest={sea_level:sea,regions:[],tiles:[]};
  c.tiles.set(0,{placement:[0,0],vertices:new Float32Array([0,y,0,0,y,50,50,y,0]),offsets,triangles:new Uint32Array([0])});
  return c;
}

test('floorY is the sea where there is no terrain and the terrain surface where there is',()=>{
  const c=collisionWithGround(40);
  assert.equal(c.floorY(9000,100,9000),.5);
  assert.equal(c.floorY(5,20,5),40.5,'a camera 20 yd under the ground is lifted to the surface');
  assert.equal(c.floorY(5,100,5),.5,'a camera above the ground is unconstrained by it');
  assert.equal(collisionWithGround(-30,0).floorY(5,-35,5),.5,'ground below the sea still floors at the water');
  assert.equal(collisionWithGround(-30,-5).floorY(9000,0,9000),-4.5,'sea level comes from the manifest');
});

test('fly and chase cameras are lifted above water and ground, and are untouched above them',()=>{
  const c=collisionWithGround(40),r={cameraFloor:(x,y,z)=>c.floorY(x,y,z),clipCamera:(_p,to)=>to};
  cameraView(r,[0,0,0,0,0],[5,20,5,0,0],.016,[0,0],{});
  assert.equal(r.camera[1],40.5);
  cameraView(r,[0,0,0,0,0],[9000,-300,9000,0,0],.016,[0,0],{});
  assert.equal(r.camera[1],.5,'no terrain: the sea is the floor');
  cameraView(r,[0,0,0,0,0],[9000,300,9000,0,0],.016,[0,0],{});
  assert.equal(r.camera[1],300);
  const chase={cameraFloor:()=>5,clipCamera:(_p,to)=>to};
  cameraView(chase,[0,0,0,0,0],undefined,.016,[0,0],{cameraOrbit:[0,-3000]});
  assert(chase.camera[1]>=5,'chase camera swung below the surface is lifted');
  assert.deepEqual(lifted({},[1,-5,2],[0,0]),[1,-5,2],'no floor until camera collision has loaded');
});

test('the chase floor lift is capped near the pivot so a high surface cannot leave the camera looking straight down',()=>{
  const rig={cameraFloor:()=>500};
  const view=cameraView(rig,[0,10,0,0,0,0,0,1,0],undefined,.016,[0,0],{});
  assert.ok(rig.camera[1]<=10+3+5,`eye at ${rig.camera[1]}`);
  const horizontal=Math.hypot(rig.camera[0],rig.camera[2]);
  assert.ok(horizontal>5,'the eye stays behind the pod');
  assert.ok(Math.abs(view.look[1])<.8,`look pitch ${view.look[1]}`);
  assert.equal(lifted({cameraFloor:()=>500},[0,1,0],[0,0])[1],500,'fly mode is still fully floored');
});
