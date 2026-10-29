import test from 'node:test';
import assert from 'node:assert/strict';
import {podInSpace,podControl,turnPod,validatePodControl} from './pod-attitude.js';
import {beginRamp,stepLaunch,launchTelemetry,LAUNCH} from './pod-launch.js';
import {PodRuntime} from './pod-driver.js';
import {WorldInput} from './world-input.js';
import {bodyOf} from './bodies.js';
import {basis} from './orient.js';
import {chartAxes} from './shared-flight.js';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const near=(a,b,tolerance=1e-8)=>assert(Math.hypot(...a.map((v,i)=>v-b[i]))<tolerance,`${a} != ${b}`);
const orbit=()=>{
  let s=beginRamp({id:'ramp',body:'elune',kind:'ramp',angle:90,yaw:0,pos:[-300,10,0]},150,15,720);
  while(s.mode==='ramp')s=stepLaunch(s,{throttle:0});
  return s;
};
const control=(mouse=[0,0],stick=[0,0],active=true)=>({mouse,stick,active});

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
    assert(!podInSpace(bad));assert.equal(podControl(bad,true,true,[1,1],[100,50],true),undefined);
  }
  assert.equal(podControl(s,false,true,[1,1],[100,50],true),undefined);
  assert.deepEqual(podControl(s,true,true,[0,0],[100,-50],false),control([-.4,.2]));
  assert.deepEqual(podControl(s,true,false,[1,-.5],[0,0],true),control([0,0],[-1,-.5]));
  assert.deepEqual(podControl(s,true,false,[0,0],[100,-50],false),control([-.4,.2],[0,0],false),'Final movement belongs to the pod even if RMB was released before the frame');
  for(const value of [null,{},control([NaN,0]),control([0,0],[2,0]),control([0,0,0])])
    assert.throws(()=>validatePodControl(value),/Invalid orbital/);
});

test('LB/L1 gates the pod right stick without changing free-flight/other-vehicle bindings',()=>{
  const pad={index:0,connected:true,mapping:'standard',axes:[0,0,.8,-.8],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
  pad.buttons[4]={pressed:true,value:1};
  const input=new WorldInput(),pod=input.sample(new Set(),[pad],true,'native',true,true);
  assert(pod.orient);assert(pod.look[0]>0&&pod.look[1]>0);assert.equal(pod.flags,0);
  assert.equal(input.sample(new Set(),[pad],false,'native',true,true).orient,false);
  const other=input.sample(new Set(),[pad],true,'native',true,false);
  assert.equal(other.orient,false);assert.equal(other.flags,4);
});

test('local quaternion turns preserve roll, cross vertical without snapping and integrate fixed stick rates',()=>{
  const start={direction:[0,0,-1],up:[1,0,0]};
  let a=start,b=start;
  for(let i=0;i<120;i++)a=turnPod(a.direction,a.up,[0,0],[1,0],1/120);
  for(let i=0;i<240;i++)b=turnPod(b.direction,b.up,[0,0],[1,0],1/240);
  near(a.direction,b.direction);near(a.up,b.up);near(a.direction,[0,1,0]);near(a.up,start.up);
  const over=turnPod(start.direction,start.up,[0,Math.PI],[0,0],0);
  near(over.direction,[0,0,1]);near(over.up,[-1,0,0]);
  assert(Math.abs(dot(over.direction,over.up))<1e-12);
});

test('RMB attitude persists on release and thrust, reverse and powered boost use the new axis',()=>{
  const old=orbit(),turned=stepLaunch(old,{throttle:0,podControl:control([-Math.PI/2,0])});
  near(turned.velocity,stepLaunch(old,{throttle:0}).velocity);
  assert(turned.freeAttitude);assert(Math.abs(dot(old.direction,turned.direction))<1e-8);
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
  assert.deepEqual(stepLaunch(ramp,{throttle:1,podControl:control([1,1])}),stepLaunch(ramp,{throttle:1}));
});

test('manual orientation survives a real SOI handoff and full telemetry basis',()=>{
  let s=orbit(),crossed=false;
  s=stepLaunch(s,{throttle:0,podControl:control([.02,.01])});
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
      crossed=true;break;
    }
  }
  assert(crossed);
});

test('mouse deltas survive zero-tick frames and collision holds, apply once, and reset clears controls',()=>{
  const runtime=new PodRuntime();runtime.journey=orbit();runtime.remaining=15;
  const old=structuredClone(runtime.journey);
  const world={blocked:1,pod_sweep(){return this.blocked;},pod_engine_step(){}};
  runtime.queueControl(control([.2,0]));runtime.queueControl(control([.3,0]));runtime.queueControl(control([0,0],[0,0],false));
  runtime.tick(world,{throttle:0,flags:0},'elune',720);near(runtime.journey.direction,old.direction);
  world.blocked=0;runtime.tick(world,{throttle:0,flags:0},'elune',720);
  near(runtime.journey.direction,turnPod(old.direction,old.up,[.5,0],[0,0],0).direction);
  const turned=runtime.journey.direction.slice();
  runtime.tick(world,{throttle:0,flags:0},'elune',720);near(runtime.journey.direction,turned);
  runtime.reset();assert.equal(runtime.control,undefined);
});
