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
  const chase={cameraFloor:()=>10,clipCamera:(_p,to)=>to};
  cameraView(chase,[0,0,0,0,0],undefined,.016,[0,0],{cameraOrbit:[0,-3000]});
  assert(chase.camera[1]>=10,'chase camera swung below the surface is lifted');
  assert.deepEqual(lifted({},[1,-5,2],[0,0]),[1,-5,2],'no floor until camera collision has loaded');
});
