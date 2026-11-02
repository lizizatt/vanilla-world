import test from 'node:test';
import assert from 'node:assert/strict';
import {podCameraFrame,rigidPodMatrix,podParticleFrame} from './pod-render-frame.js';
import {ParticlePool} from './particles.js';
import {craftMatrix,cameraView} from './world-camera.js';
import {AZEROTH,ELUNE,toInertial,fromInertial} from './bodies.js';
import {setActiveBody} from './body-shaders.js';
import {chartAxes} from './shared-flight.js';
import {beginRamp,stepLaunch,launchTelemetry} from './pod-launch.js';
import {frameCentre} from './frames.js';
import {simEpoch} from './sim-clock.js';
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const close=(a,b,tolerance=1e-6)=>assert(Math.hypot(...a.map((v,i)=>v-b[i]))<tolerance,`${a} != ${b}`);
const inertial=(body,eye,v,t)=>{const a=chartAxes(body,eye,t);return [0,1,2].map(i=>a.reduce((sum,col,j)=>sum+col[i]*v[j],0));};

test('collision checks the metric cockpit eye, not just its unprojected chart offset',()=>{
  setActiveBody(AZEROTH);
  const state=[-22293,37466,6897,1.6,0],calls=[];
  const rig={craft:{metadata:{scale:1},anchor:[-3,0,1]},clipCamera:(_pivot,eye)=>{
    calls.push(eye);
    return calls.length===1?eye:eye.map((v,i)=>v+(i===1?1:0));
  }};
  cameraView(rig,state,undefined,0,[0,0],{cockpit:true});
  assert.equal(calls.length,2);
  assert(Math.hypot(...calls[0].map((v,i)=>v-calls[1][i]))>1);
  assert.equal(rig.cameraBlocked,'geometry');
});

test('engine particles share rigid metric offsets instead of stretched chart coordinates',()=>{
  const state=[-22293,37466,6897,1.6,0],offset=[2,4,16],frame=podCameraFrame(AZEROTH,state,offset,[0,0,-1]);
  const pool=new ParticlePool(4,()=>.5);pool.frame=podParticleFrame(AZEROTH,state);
  pool.emit('plume',state[0]+2,state[1]+1,state[2]-3);
  pool.frame=undefined;
  const out=new Float32Array(32);assert.equal(pool.fill(out,frame.eye,AZEROTH),1);
  assert(Math.abs(Math.hypot(...out.slice(0,3))-Math.hypot(0,-3,-19))<1e-5);
  assert.throws(()=>pool.fill(out,frame.eye),/active body frame/);
});

test('rigid mesh dimensions and physical camera separation survive altitude, poles and rebasing',()=>{
  for(const body of [AZEROTH,ELUNE])for(const height of [3,37466.550747019435,100000])for(const z of [6897.77901955871,body.centre[1]+body.radius*Math.PI/2-.01]){
    const state=[-22293.523654828925,height,z,1.6022421936742066,0,0,0,0,0,0,0,-22294,Math.round(z),0,0,1,1,.3];
    const offset=[2,4,16],frame=podCameraFrame(body,state,offset,[0,0,-1]);
    const m=rigidPodMatrix(craftMatrix(state,[state[11],state[12]],.7),state,frame.eye,body);
    const columns=[0,4,8].map(i=>Array.from(m.slice(i,i+3)));
    columns.forEach(v=>assert(Math.abs(Math.hypot(...v)-.7)<1e-6));
    assert(Math.abs(dot(columns[0],columns[1]))<1e-6);assert(Math.abs(dot(columns[1],columns[2]))<1e-6);
    assert(Math.abs(Math.hypot(...m.slice(12,15))-Math.hypot(...offset))<1e-5);
    const rebased=rigidPodMatrix(craftMatrix(state,[1e9,-1e9],.7),state,frame.eye,body);
    close([...m],[...rebased]);
  }
});
test('SOI swap preserves cockpit and chase inertial eye and all orientation axes after renderer reset',()=>{
  simEpoch.days=0;
  let j=beginRamp({id:'ramp',body:'elune',kind:'ramp',angle:90,yaw:0,pos:[-300,10,0]},150,15,720);
  while(j.mode==='ramp')j=stepLaunch(j,{throttle:0,boost:false});
  const position=j.pos;
  for(const cockpit of [false,true]){
    const rig={craft:{metadata:{scale:.1},anchor:[-3,0,1]},orbitalLook:[.2,.1]},settings={cockpit,cameraDistance:16,cameraRecentre:false};
    const frames=[];
    for(const body of [ELUNE,AZEROTH]){
      setActiveBody(body);
      const pose=fromInertial(body,position,j.time),axes=chartAxes(body,pose,j.time);
      const state=launchTelemetry({...j,parent:body.id,pose,look:axes.map(a=>dot(a,j.direction))},new Array(18).fill(0));
      rig.camera=undefined; // Existing soiSwap clears this, but not the physical camera orbit.
      const view=cameraView(rig,state,undefined,0,[state[11],state[12]],settings);
      const eye=[rig.camera[0]+state[11],rig.camera[1],rig.camera[2]+state[12]];
      frames.push({eye:toInertial(body,eye,j.time),look:inertial(body,eye,view.look,j.time),up:inertial(body,eye,view.up,j.time)});
    }
    for(const key of ['eye','look','up'])close(frames[0][key],frames[1][key],1e-7);
  }
  setActiveBody(AZEROTH);
});

test('engine particles stay on the craft in a pole frame (spawned and drawn against the same framed body)',()=>{
  for(const id of ['N','S']){
    const body={...ELUNE,centre:frameCentre(id,ELUNE.centre)},state=[4.37,-57.4,-48.8,-2.77,0],eye=[state[0]-8,state[1]+3,state[2]+10];
    const pool=new ParticlePool(4,()=>.5);pool.frame=podParticleFrame(body,state);pool.emit('plume',state[0],state[1],state[2]);pool.frame=undefined;
    const out=new Float32Array(32);
    assert.equal(pool.fill(out,eye,body),1);
    const want=rigidPodMatrix(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),state,eye,body).slice(12,15);
    close(Array.from(out.slice(0,3)),Array.from(want),1e-3);
    pool.frame=podParticleFrame(body,state);pool.emit('plume',state[0],state[1],state[2]);pool.frame=undefined;
    pool.fill(out,eye,ELUNE);assert(Math.hypot(...Array.from(out.slice(0,3)).map((v,i)=>v-want[i]))>1,'unframed body must not match');
  }
});
