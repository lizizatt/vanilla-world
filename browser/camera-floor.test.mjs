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
  assert.equal(c.floorY(5,100,5),-Infinity,'a camera above the ground is unconstrained by it, and a dry tile has no sea floor');
  assert.equal(collisionWithGround(-30,0).floorY(5,-35,5),-29.5,'ground below the sea inside a land tile is a dry basin: terrain floor only');
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
  assert.ok(rig.camera[1]<=10+3+rig.chaseDistance*.5+1e-6,`eye at ${rig.camera[1]}`);
  const horizontal=Math.hypot(rig.camera[0],rig.camera[2]);
  assert.ok(horizontal>5,'the eye stays behind the pod');
  assert.ok(Math.abs(view.look[1])<.8,`look pitch ${view.look[1]}`);
  assert.equal(lifted({cameraFloor:()=>500},[0,1,0],[0,0])[1],500,'fly mode is still fully floored');
});

test('soft chase floor: pitch response is identical with and without a floor below the camera',()=>{
  const run=floor=>{const r={cameraFloor:floor,clipCamera:(_p,to)=>to};let look;
    for(let i=0;i<30;i++)look=cameraView(r,[0,50,0,0,0,0,0,1,0],undefined,.016,[0,0],{cameraOrbit:[0,i%2?-20:20]}).look;
    return [r.chase,r.camera,look];};
  assert.deepEqual(run(()=>-100),run(undefined));
});

test('soft chase floor: eases down without popping and the eye never ends below the floor',()=>{
  let floor=60;const r={cameraFloor:()=>floor,clipCamera:(_p,to)=>to},state=[0,50,0,0,0,0,0,1,0];
  cameraView(r,state,undefined,.016,[0,0],{});
  assert.ok(r.camera[1]>=floor);
  floor=0;let prev=r.camera[1];
  for(let i=0;i<120;i++){cameraView(r,state,undefined,.016,[0,0],{});assert.ok(prev-r.camera[1]<2,'no pop');prev=r.camera[1];}
  assert.ok(r.camera[1]<=r.chaseDistance+state[1]+3+.1);
  floor=70;cameraView(r,state,undefined,.016,[0,0],{});
  assert.ok(r.camera[1]>=Math.min(70,state[1]+3+r.chaseDistance*.5)-1e-6);
  assert.equal(lifted({cameraFloor:()=>9},[0,1,0],[0,0])[1],9,'free fly stays hard-floored');
});

test('sea floor only over real water: dry basin allows low pitch, whirlpool bowl and open ocean floor the eye',()=>{
  const c=collisionWithGround(-20,0);
  const basin={cameraFloor:(x,y,z)=>c.floorY(5,y,5),clipCamera:(_p,to)=>to},state=[5,-20,5,0,0,0,0,1,0];
  cameraView(basin,state,undefined,.016,[0,0],{cameraOrbit:[0,-3000]});
  assert.ok(basin.camera[1]<0&&basin.camera[1]>=-19.5,'eye swings to the basin floor, never lifted above the sea');
  const level={cameraFloor:basin.cameraFloor,clipCamera:basin.clipCamera};cameraView(level,state,undefined,.016,[0,0],{});
  assert.ok(!level.chaseLift&&level.camera[1]<0,'default chase pitch needs no lift');
  assert.equal(c.floorY(5,-30,5),-19.5,'terrain floor unchanged');
  assert.equal(c.floorY(9000,-5,9000),.5,'open ocean: eye above sea');
  const m=collisionWithGround(-20,0);m.manifest={sea_level:0,whirlpool:[9000,9000],regions:[],tiles:[]};
  assert.equal(m.floorY(9000,-500,9000),-380+.5,'pit: eye above the local bowl surface');
  assert.ok(m.floorY(9000,-500,9000)<-300,'but far below y=0');
  assert.equal(m.floorY(9000+3000,-5,9000),.5,'outside the bowl: sea level');
});
test('a lake inside a land tile is a camera floor too (Moonglade on Elune), without raising the camera above it',()=>{
  const c=collisionWithGround(-14,0),offsets=new Uint32Array(CELLS*CELLS+1);
  for(let i=1;i<offsets.length;i++)offsets[i]=9;
  c.tiles.get(0).water={vertices:new Float32Array([0,-8,0,0,-8,50,50,-8,0]),offsets,triangles:new Uint32Array([0])};
  assert.equal(c.floorY(5,-13,5),-7.5,'a camera under the lake surface is lifted onto it');
  assert.equal(c.floorY(5,-7,5),-Infinity,'above the lake nothing constrains it');
  assert.equal(c.floorY(400,-13,400),-Infinity,'outside the lake only the terrain counts');
});