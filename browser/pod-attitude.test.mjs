import test from 'node:test';
import assert from 'node:assert/strict';
import {podInSpace,movePodAim,aimQuaternion,slewAim,validatePodControl} from './pod-attitude.js';
import {beginRamp,stepLaunch,launchTelemetry,LAUNCH} from './pod-launch.js';
import {PodRuntime} from './pod-driver.js';
import {WorldInput} from './world-input.js';
import {bodyOf,toInertial} from './bodies.js';
import {basis,fromEuler} from './orient.js';
import {chartAxes} from './shared-flight.js';
import {cameraView} from './world-camera.js';
import {setActiveBody} from './body-shaders.js';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const near=(a,b,tolerance=1e-8)=>assert(Math.hypot(...a.map((v,i)=>v-b[i]))<tolerance,`${a} != ${b}`);
const orbit=()=>{
  let s=beginRamp({id:'ramp',body:'elune',kind:'ramp',angle:90,yaw:0,pos:[-300,10,0]},150,15,720);
  while(s.mode==='ramp')s=stepLaunch(s,{throttle:0});
  return s;
};
const control=aim=>({active:true,aim});
const angle=(a,b)=>2*Math.acos(Math.min(1,Math.abs(dot(a,b))));

test('actual pointer handlers separate body turning from camera orbit and clear capture/cursor safely',async()=>{
  const target=()=>({handlers:{},style:{},addEventListener(name,fn){this.handlers[name]=fn;},focus(){},setPointerCapture(){}});
  const canvas=target(),window=target(),document=target();
  const app={canvas,keys:new Set(),input:{},settings:{},mapPanel:{},choice:{vehicle:'podracer'},
    client:{state:{pod:{journey:orbit()}}},orbit:[0,0],resumeAudio(){},pauseAudio(){}};
  const source=(await readFile(new URL('./app-input.js',import.meta.url),'utf8')).replace(/^import [^;]*;\r?\n/gm,'').replace(/^export /gm,'');
  const context=createContext({app,window,document,podInSpace});
  runInContext(source+'\ninstallInput(app);',context);
  const fire=(name,values={})=>canvas.handlers[name](values);
  fire('pointerdown',{button:2,buttons:2,pointerId:1});assert.equal(canvas.style.cursor,'grabbing');
  fire('pointermove',{buttons:2,movementX:40,movementY:-20});
  fire('pointerup',{buttons:0});fire('lostpointercapture');
  assert.deepEqual(Array.from(app.podOrbit),[40,-20]);assert.deepEqual(app.orbit,[0,0]);assert.equal(canvas.style.cursor,'');
  fire('pointerdown',{button:0,buttons:1,pointerId:1});fire('pointermove',{buttons:1,movementX:2,movementY:3});
  assert.deepEqual(app.orbit,[2,3]);
  let prevented=false;fire('contextmenu',{preventDefault(){prevented=true;}});assert(prevented);
  window.handlers.blur();assert.equal(app.mouseButtons,0);assert.deepEqual(Array.from(app.podOrbit),[0,0]);assert.equal(canvas.style.cursor,'');
  app.client.state.pod.journey=null;
  fire('pointerdown',{button:2,buttons:2,pointerId:1});fire('pointermove',{buttons:2,movementX:5,movementY:6});
  assert.deepEqual(Array.from(app.orbit),[5,6]);assert.deepEqual(Array.from(app.podOrbit),[0,0]);
  fire('pointercancel');assert.equal(app.dragging,false);
});

test('space controls require an unsupported inertial journey outside the body atmosphere',()=>{
  const s=orbit();assert(podInSpace(s));
  for(const bad of [undefined,{...s,mode:'ramp'},{...s,mode:'local'},{...s,parent:'azeroth',pose:[0,bodyOf('azeroth').atmosphereEdge,0]}]){
    assert(!podInSpace(bad));
  }
  validatePodControl({active:false});validatePodControl(control([0,0,0,1]));
  for(const value of [null,{},control([NaN,0,0,1]),control([0,0,0,2]),control([0,0,0])])
    assert.throws(()=>validatePodControl(value),/Invalid orbital/);
  assert.throws(()=>validatePodControl({...control([0,0,0,1]),slew:1}),/Invalid orbital/);
});

test('engaging an offset space camera preserves aim and attitude until mouse or stick movement',()=>{
  try{
    setActiveBody(bodyOf('elune'));
    for(const cockpit of [false,true])for(const remaining of [15,0]){
      const old={...orbit(),remaining},origin=[0,0],rig={clipCamera:(_,eye)=>eye,orbitalLook:[.7,.25],
        craft:{anchor:[-2,0,1],metadata:{scale:1}}};
      const settings={cockpit,podTime:old.time},state=launchTelemetry(old,Array(18).fill(0));
      const view=cameraView(rig,state,null,0,origin,settings),eye=rig.camera.slice(),seed=rig.podCameraAim;
      assert(Math.abs(dot(basis(seed).look,old.direction))<.95,'Fixture has a real camera/nose offset');
      let held=movePodAim(undefined,seed,[0,0],[0,0],1/120),next=old;
      for(let i=0;i<60;i++){
        assert.equal(held.moved,false);near(basis(held.q).look,basis(seed).look);
        next=stepLaunch(next,{throttle:0,podControl:{active:true,aim:held.q,slew:held.moved}});
        near(next.direction,old.direction);near(next.up,old.up);
        held=movePodAim(held,seed,[0,0],[0,0],1/120);
      }
      const engaged=cameraView(rig,state,null,0,origin,{...settings,podAim:held.q});
      near(engaged.look,view.look);near(engaged.up,view.up);near(rig.camera,eye);
      for(const [mouse,stick] of [[[2,0],[0,0]],[[0,0],[0,1]]]){
        const moved=movePodAim(held,seed,mouse,stick,1/120);
        assert(moved.moved);
        assert(movePodAim(moved,seed,[0,0],[0,0],1/120).moved,'Slew can finish after movement stops');
        const turned=stepLaunch(next,{throttle:0,podControl:{active:true,aim:moved.q,slew:moved.moved}});
        assert(Math.hypot(...turned.direction.map((v,i)=>v-next.direction[i]))>1e-4);
      }
      assert.equal(movePodAim(undefined,seed,[0,0],[0,0],1/120).moved,false,'A fresh hold waits for input again');
    }
  }finally{setActiveBody(bodyOf('azeroth'));}
});

test('LB/L1 gates the pod right stick without changing free-flight/other-vehicle bindings',()=>{
  const pad={index:0,connected:true,mapping:'standard',axes:[0,0,.8,-.8],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
  pad.buttons[4]={pressed:true,value:1};
  const input=new WorldInput(),pod=input.sample(new Set(),[pad],true,'native',true,true);
  assert(pod.orient);assert(pod.look[0]>0&&pod.look[1]>0);assert.equal(pod.flags,0);
  const seed=[0,0,0,1];
  assert(basis(movePodAim(undefined,seed,[0,0],pod.look,.1).q).look[1]<0,'Physical stick up uses flipped space pitch');
  pad.axes[3]=.8;
  const down=input.sample(new Set(),[pad],true,'native',true,true);
  assert(basis(movePodAim(undefined,seed,[0,0],down.look,.1).q).look[1]>0,'Physical stick down raises the space aim');
  assert.equal(new WorldInput().sample(new Set(['ArrowUp']),[],true,'native',true,true).pitch,-1,'Ground keyboard pitch remains inverted as before');
  assert.equal(input.sample(new Set(),[pad],false,'native',true,true).orient,false);
  const other=input.sample(new Set(),[pad],true,'native',true,false);
  assert.equal(other.orient,false);assert.equal(other.flags,4);
});

test('camera aim uses fixed hold-start up, crosses poles continuously and accumulates no roll',()=>{
  const seed=[0,0,0,1];
  let a,b;
  for(let i=0;i<120;i++)a=movePodAim(a,seed,[0,0],[1,0],1/120);
  for(let i=0;i<240;i++)b=movePodAim(b,seed,[0,0],[1,0],1/240);
  near(basis(a.q).look,basis(b.q).look);near(basis(a.q).look,[1,0,0]);
  const up=movePodAim(undefined,seed,[0,-100],[0,0],0);assert(basis(up.q).look[1]<0);
  const down=movePodAim(undefined,seed,[0,100],[0,0],0);assert(basis(down.q).look[1]>0);
  near(basis(up.q).look,basis(movePodAim(undefined,seed,[0,0],[0,1],.4/(Math.PI/2)).q).look);
  let pole;
  for(let i=0;i<400;i++){
    const next=movePodAim(pole,seed,[0,-2],[0,0],0);
    if(pole)assert(angle(next.q,pole.q)<.008001);
    pole=next;
  }
  assert(basis(pole.q).up[1]<0,'Passing over the pole carries up continuously, without a horizon flip');
  let loop;
  for(const mouse of [[100,0],[0,-200],[-100,0],[0,200]])loop=movePodAim(loop,seed,mouse,[0,0],0);
  near(basis(loop.q).look,[0,0,-1]);near(basis(loop.q).up,[0,1,0]);
});

test('slew is rate limited, shortest-arc, monotone and settles exactly including opposite quaternions',()=>{
  const target=fromEuler(-Math.PI/2,.4);let q=[0,0,0,1],error=angle(q,target);
  for(let i=0;i<600;i++){
    const next=slewAim(q,target,1/120),remaining=angle(next,target);
    assert(angle(q,next)<=Math.PI/120+1e-7);
    assert(remaining<=error+1e-7);q=next;error=remaining;
  }
  near(q,target);assert.equal(error,0);
  near(slewAim(target,target.map(v=>-v),1/120),target);
  const a=fromEuler(179*Math.PI/180,0),b=fromEuler(-179*Math.PI/180,0);
  assert(angle(slewAim(a,b,.1),b)<angle(a,b));
  near(slewAim(a,b,0),a);
  let rate120=[0,0,0,1],rate240=rate120;
  for(let i=0;i<120;i++)rate120=slewAim(rate120,target,1/120);
  for(let i=0;i<240;i++)rate240=slewAim(rate240,target,1/240);
  assert(angle(rate120,rate240)<.0002);
});

test('RMB attitude persists on release and thrust, reverse and powered boost use the new axis',()=>{
  const old=orbit(),target=movePodAim(undefined,aimQuaternion(old.direction,old.up),[Math.PI/2/.004,0],[0,0],0).q;
  const first=stepLaunch(old,{throttle:0,podControl:control(target)});
  near(first.velocity,stepLaunch(old,{throttle:0}).velocity);
  assert(first.freeAttitude);assert(dot(old.direction,first.direction)>.99,'The nose slews instead of snapping');
  let turned=first;
  for(let i=0;i<600;i++)turned=stepLaunch(turned,{throttle:0,podControl:control(target)});
  near(turned.direction,basis(target).look);
  for(const [throttle,boost] of [[1,false],[-1,false],[1,true]]){
    const thrust=stepLaunch(turned,{throttle,boost}),coast=stepLaunch(turned,{throttle:0});
    const change=thrust.velocity.map((v,i)=>v-coast.velocity[i]),along=dot(change,turned.direction);
    near(change,turned.direction.map(v=>v*along),1e-5);
    assert(Math.sign(along)===Math.sign(throttle));
    if(boost)assert(Math.abs(along-LAUNCH.power*LAUNCH.step)<1e-4);
  }
  let released={...turned,remaining:0};
  for(let i=0;i<120;i++)released=stepLaunch(released,{throttle:0,pitch:1,steer:1});
  near(released.direction,turned.direction);near(released.up,turned.up);
  const ramp=beginRamp(old.ramp,150,0,720);
  assert.deepEqual(stepLaunch(ramp,{throttle:1,podControl:control(target)}),stepLaunch(ramp,{throttle:1}));
});

test('manual orientation survives a real SOI handoff and full telemetry basis',()=>{
  let s=orbit(),crossed=false;
  s=stepLaunch(s,{throttle:0,podControl:control(aimQuaternion(s.direction,s.up))});
  for(let i=0;i<120*60;i++){
    const old=s;s=stepLaunch(s,{throttle:s.remaining>0?1:0,boost:true});
    near(s.direction,old.direction);near(s.up,old.up);
    if(s.parent!==old.parent){
      const runtime=new PodRuntime(),value={journey:s,remaining:s.remaining,spent:[],engines:[1,.3,.5]};
      runtime.adopt(value,{pod_engine_state(){}});
      assert(runtime.journey.freeAttitude);
      const p=launchTelemetry(runtime.journey,Array(18).fill(0)),b=basis(p.slice(18)),axes=chartAxes(bodyOf(s.parent),s.pose,s.time);
      for(const [v,want] of [[b.look,s.direction],[b.up,s.up]])
        near([0,1,2].map(i=>axes.reduce((sum,a,k)=>sum+a[i]*v[k],0)),want);
      const aim=aimQuaternion(s.direction,s.up),rig={clipCamera:(_,eye)=>eye},physicalEyes=[];
      try{
        for(const j of [old,s]){
          setActiveBody(bodyOf(j.parent));
          const view=cameraView(rig,launchTelemetry(j,Array(18).fill(0)),null,LAUNCH.step,[0,0],{podAim:aim,podTime:j.time});
          const a=chartAxes(bodyOf(j.parent),rig.camera,j.time);
          near([0,1,2].map(i=>a.reduce((sum,v,k)=>sum+v[i]*view.look[k],0)),s.direction);
          physicalEyes.push(toInertial(bodyOf(j.parent),rig.camera,j.time));
        }
        near(physicalEyes[1].map((v,i)=>v-physicalEyes[0][i]),s.pos.map((v,i)=>v-old.pos[i]),1e-6);
      }finally{setActiveBody(bodyOf('azeroth'));}
      crossed=true;break;
    }
  }
  assert(crossed);
});

test('absolute aim survives zero-tick frames and holds, latest release stops slew, reset clears controls',()=>{
  const runtime=new PodRuntime();runtime.journey=orbit();runtime.remaining=15;
  const old=structuredClone(runtime.journey);
  const world={blocked:1,pod_sweep(){return this.blocked;},pod_engine_step(){}};
  const target=movePodAim(undefined,aimQuaternion(old.direction,old.up),[100,0],[0,0],0).q;
  runtime.queueControl(control(fromEuler(0,0)));runtime.queueControl(control(target));
  runtime.tick(world,{throttle:0,flags:0},'elune',720);near(runtime.journey.direction,old.direction);
  world.blocked=0;runtime.tick(world,{throttle:0,flags:0},'elune',720);
  near(runtime.journey.direction,basis(slewAim(aimQuaternion(old.direction,old.up),target,LAUNCH.step)).look);
  const turned=runtime.journey.direction.slice();
  runtime.queueControl({active:false});
  runtime.tick(world,{throttle:0,flags:0},'elune',720);near(runtime.journey.direction,turned);
  runtime.reset();assert.equal(runtime.control,undefined);
});

test('camera centre is the inertial aim on both bodies; hold and release preserve view and eye',()=>{
  const origin=[0,0];
  try{
    for(const id of ['elune','azeroth']){
      for(const cockpit of [false,true]){
      setActiveBody(bodyOf(id));
      let journey=orbit();journey={...journey,parent:id,pose:[-300,5000,100]};
      const state=launchTelemetry(journey,Array(18).fill(0));
      const rig={clipCamera:(_,eye)=>eye,timeOfDay:journey.time,craft:{anchor:[-2,0,1],metadata:{scale:1}}};
      const settings={podTime:journey.time,cameraDistance:16,cockpit};
      const first=cameraView(rig,state,null,1/120,origin,settings),eye=rig.camera.slice(),seed=rig.podCameraAim;
      const held=cameraView(rig,state,null,1/120,origin,{...settings,podAim:seed});
      near(held.look,first.look);near(rig.camera,eye);
      const target=movePodAim(undefined,seed,[393,-50],[0,0],0).q;
      const aimed=cameraView(rig,state,null,1/120,origin,{...settings,podAim:target}),aimEye=rig.camera.slice();
      const axes=chartAxes(bodyOf(id),rig.camera,journey.time),physical=v=>[0,1,2].map(i=>axes.reduce((sum,a,k)=>sum+a[i]*v[k],0));
      near(physical(aimed.look),basis(target).look);near(physical(aimed.up),basis(target).up);
      const released=cameraView(rig,state,null,1/120,origin,settings);
      near(released.look,aimed.look);near(released.up,aimed.up);near(rig.camera,aimEye);
      const before=rig.podCameraAim;
      cameraView(rig,state,null,1/120,origin,settings);
      assert(angle(before,rig.podCameraAim)<=Math.PI/120+1e-7);
      for(let i=0;i<600;i++)cameraView(rig,state,null,1/120,origin,settings);
      near(basis(rig.podCameraAim).look,basis(seed).look);
      assert.equal(rig.podAimFollow,undefined,'Settled camera returns to the ordinary follow/orbit controls');
      }
    }
  }finally{setActiveBody(bodyOf('azeroth'));}
});
