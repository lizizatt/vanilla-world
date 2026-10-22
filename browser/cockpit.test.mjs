import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraView,cockpitAnchor} from './world-camera.js';
import {CameraCollision} from './camera-collision.js';
import {validateWorldSave,LAYOUT_VERSION} from './world-store.js';

const metadata={scale:2,posedAttachment0:{position:[2,3,4],space:'model-local',pose:'stand-frame-0'}};
const rig=()=>({craft:{metadata,anchor:cockpitAnchor(metadata)},clipCamera:(_from,to)=>to});
const settings={cockpit:true},near=(a,b)=>a.forEach((n,i)=>assert(Math.abs(n-b[i])<1e-5,`${a} != ${b}`));
test('cockpit uses the posed model seat and body basis, without velocity-dependent eye movement',()=>{
  const r=rig(),p=[1e9+3,12,-1e9+4,0,0,0],origin=[1e9,-1e9];
  let view=cameraView(r,p,undefined,.016,origin,settings);
  near(r.camera,[-3,21.5,0]);near(view.look,[0,0,-1]);near(view.up,[0,1,0]);
  for(const speed of [-30,0,250,500]){
    p[5]=speed;p[0]+=2;p[2]-=5;
    const old=r.camera.slice();
    cameraView(r,p,undefined,.016,origin,settings);
    near(r.camera,old.map((n,i)=>n+[2,0,-5][i]));
  }
  p[3]=Math.PI/2;p[4]=Math.PI/6;
  view=cameraView(r,p,undefined,.016,origin,settings);
  near(view.look,[-1,0,0]);near(view.up,[0,Math.cos(Math.PI/6),-Math.sin(Math.PI/6)]);
  const world=r.camera.map((n,i)=>n+(i===0?origin[0]:i===2?origin[1]:0));
  const moved=[origin[0]+256,origin[1]-256];
  cameraView(r,p,undefined,.016,moved,settings);
  near(r.camera.map((n,i)=>n+(i===0?moved[0]:i===2?moved[1]:0)),world);
});
test('cockpit holds the exact seat and reports a blocked view instead of retracting through geometry',()=>{
  const collision=new CameraCollision(),r=rig(),p=[0,12,0,0,0];
  collision.event({event:'collision',vertices:new Float64Array([-30,13,-30,30,13,-30,0,13,30]),
    nodes:new Float64Array([-30,13,-30,30,13,30,0,1,-1,-1])});
  r.clipCamera=(from,to,origin)=>collision.clip(from,to,origin);
  const view=cameraView(r,p,undefined,.016,[0,0],settings);
  near(r.camera,[-6,21.5,-4]);
  assert.equal(r.cameraBlocked,'geometry');assert.equal(view.collisionReady,false);
  assert.equal(r.cameraMode,'cockpit');
  r.cameraCollisionReady=false;r.clipCamera=from=>from;
  p[0]+=500;
  cameraView(r,p,undefined,.016,[0,0],settings);
  near(r.camera,[494,21.5,-4]);assert.equal(r.cameraBlocked,'pending');
  r.clipCamera=(_from,to)=>to;
  cameraView(r,p,undefined,.016,[0,0],settings);
  near(r.camera,[494,21.5,-4]);assert.equal(r.cameraBlocked,undefined);
});
test('cockpit look/back, fly, chase and camera resets do not retain the previous rig position',()=>{
  const r=rig(),p=[0,12,0,0,0];
  cameraView(r,p,undefined,.016,[0,0],{...settings,cameraOrbit:[100,-50]});
  const eye=r.camera.slice();assert(r.cockpitLook[0]<0&&r.cockpitLook[1]>0);
  near(cameraView(r,p,undefined,0,[0,0],settings,true).look,[0,0,1]);near(r.camera,eye);
  cameraView(r,p,[100,50,100,0,0],.016,[0,0],settings);assert.equal(r.cameraMode,'fly');near(r.camera,[100,50,100]);
  cameraView(r,p,undefined,.016,[0,0],settings);near(r.camera,[-6,21.5,-4]);near(r.cockpitLook,[0,0]);
  cameraView(r,p,undefined,.016,[0,0],{});assert.equal(r.cameraMode,'chase');assert(r.camera[2]>0);
  r.camera=undefined;p[0]=100;
  cameraView(r,p,undefined,.016,[0,0],settings);near(r.camera,[94,21.5,-4]);
  delete r.clipCamera;cameraView(r,p,undefined,.016,[0,0],settings);
  assert.equal(r.cameraMode,'cockpit');assert.equal(r.cameraBlocked,'pending');near(r.camera,[94,21.5,-4]);
});
test('missing or malformed authored seats never become invented attachment coordinates',()=>{
  assert.equal(cockpitAnchor({}),undefined);
  for(const position of [[1,2], [1,NaN,3]])assert.throws(()=>cockpitAnchor({...metadata,posedAttachment0:{...metadata.posedAttachment0,position}}),/Invalid posed/);
  assert.throws(()=>cockpitAnchor({...metadata,posedAttachment0:{...metadata.posedAttachment0,space:'world'}}),/Invalid posed/);
});
test('cockpit preference is optional for legacy saves and strictly boolean when present',()=>{
  const save={version:1,layout:LAYOUT_VERSION,sourceId:'local',mode:'drive',vehicle:[0,0,0,0],settings:{horizon:true,scenery:true}};
  assert.doesNotThrow(()=>validateWorldSave(save,'local'));
  save.settings.cockpit=true;assert.doesNotThrow(()=>validateWorldSave(save,'local'));
  save.settings.cockpit='yes';assert.throws(()=>validateWorldSave(save,'local'),/retained/);
});
