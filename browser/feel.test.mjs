import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraView} from './world-camera.js';
import {WorldInput} from './world-input.js';
import {fillEngineBuffer,EngineEnvelope,WorldAudio} from './world-audio.js';
import {TUNING_FIELDS,validateTuningRecord} from './world-tuning.js';
import {CameraCollision} from './camera-collision.js';

test('native chase smoothing is time-based, rebases precisely, and clips after filtering',()=>{
  const state=[100,2,100,0],settings={cameraSeconds:.5,cameraDistance:15};
  const run=fps=>{
    const rig={camera:[0,0,0],origin:[100,100],chase:[0,-Math.atan(.3)],lookBack:false};
    for(let i=0;i<fps;i++)cameraView(rig,state,undefined,1/fps,[100,100],settings);
    return rig.camera;
  };
  const reference=run(30);
  for(const fps of [60,144])assert(run(fps).every((n,i)=>Math.abs(n-reference[i])<1e-10));
  const rig={camera:[1,2,3],origin:[1e9,-1e9],chase:[0,0],lookBack:false};
  cameraView(rig,[1e9,2,-1e9,0],undefined,0,[1e9+256,-1e9+256],settings);
  assert.deepEqual(rig.camera,[-255,2,-253]);
  let casts=0;
  rig.clipCamera=(_pivot,to)=>{casts++;return [to[0],to[1],Math.min(4,to[2])];};
  cameraView(rig,[0,2,0,0],undefined,.016,[0,0],settings);
  assert.equal(casts,2);assert(rig.camera[2]<=4);
  rig.camera=undefined;
  cameraView(rig,[0,2,0,1],undefined,0,[0,0],settings);
  assert.equal(rig.chase[0],1);
});
test('camera orbit clamps pitch, wraps yaw and returns behind the craft; flight bypasses chase',()=>{
  const rig={},state=[0,2,0,Math.PI-.01];
  cameraView(rig,state,undefined,.016,[0,0],{});
  for(let i=0;i<100;i++)cameraView(rig,state,undefined,.1,[0,0],{cameraLook:[1,1]});
  assert(Math.abs(rig.chase[0])<=Math.PI);assert(rig.chase[1]<Math.PI/2);
  const pitch=rig.chase[1];cameraView(rig,state,undefined,.1,[0,0],{});
  assert(rig.chase[1]<pitch);
  cameraView(rig,state,[100,200,300,0,0],.1,[100,300],{});
  assert.deepEqual(rig.camera,[0,200,0]);
});
const pad=()=>({connected:true,mapping:'standard',index:0,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))});
test('native and legacy keyboard profiles preserve brake/hop intent and input gates',()=>{
  const input=new WorldInput(),keys=new Set(['KeyS','Space','ControlLeft']);
  assert.deepEqual([input.sample(keys,[],true).throttle,input.sample(keys,[],true).flags],[0,13]);
  assert.deepEqual([input.sample(keys,[],true,'legacy').throttle,input.sample(keys,[],true,'legacy').flags],[-1,5]);
  assert.equal(input.sample(new Set(['KeyW','Space']),[],false).flags,1);
  assert.equal(input.sample(new Set(['KeyW']),[],false).throttle,0);
});
test('gamepad triggers subtract, noisy sticks never steal input, edges and disconnect are safe',()=>{
  const input=new WorldInput(),p=pad(),keys=new Set(['KeyW']);
  p.axes[0]=.17;input.sample(keys,[p],true);assert.equal(input.device,'keyboard');
  p.buttons[6].value=1;p.axes[2]=1;
  let state=input.sample(keys,[p],true);assert.equal(state.throttle,-1);assert.equal(state.look[0],1);
  p.buttons[7].value=1;p.buttons[11].pressed=true;
  state=input.sample(keys,[p],true);assert.equal(state.throttle,0);assert(state.cockpit);
  assert(!input.sample(keys,[p],true).cockpit);
  input.keyboard();input.sample(keys,[p],true);assert.equal(input.device,'keyboard');
  assert.equal(input.sample(keys,[],true).throttle,1);
  assert.equal(input.device,'keyboard');
});
test('original engine and noise beds are bounded stereo with periodic seams',()=>{
  for(let layer=0;layer<3;layer++) {
    const channels=[new Float32Array(48000),new Float32Array(48000)];
    fillEngineBuffer({sampleRate:24000,getChannelData:i=>channels[i]},layer);
    for(const channel of channels) {
      let energy=0,maxStep=0;
      for(let i=0;i<channel.length;i++){
        assert(Number.isFinite(channel[i]) && Math.abs(channel[i])<=1);
        energy+=channel[i]*channel[i];
        if(i)maxStep=Math.max(maxStep,Math.abs(channel[i]-channel[i-1]));
      }
      assert(energy/channel.length>.001);
      assert(Math.abs(channel[0]-channel.at(-1))<=maxStep);
    }
    assert.notDeepEqual(channels[0],channels[1]);
  }
});
test('engine envelopes reuse records, build and release boost, and suppress held thrust',()=>{
  const envelope=new EngineEnvelope();
  const layers=envelope.layers;
  for(let i=0;i<180;i++)assert.equal(envelope.advance(120,1,true,false,false,1/60),layers);
  assert(envelope.boost>.99 && envelope.thrust>.99);
  for(let i=0;i<180;i++)envelope.advance(120,1,true,true,false,1/60);
  assert(envelope.boost<.001 && envelope.thrust<.001 && envelope.speed<.001);
  assert(envelope.layers[2][0]<.0001);
});
test('air and brake transients follow contact edges, never startup, held or repeated frames',()=>{
  const envelope=new EngineEnvelope();
  envelope.advance(60,1,false,false,false,.1);
  assert.equal(envelope.landing,0);assert.equal(envelope.lift,0);
  envelope.advance(60,1,false,false,false,.1,false);
  assert(envelope.lift>0);
  for(let i=0;i<5;i++)envelope.advance(60,1,false,false,false,.1,false);
  envelope.advance(60,1,false,false,false,.1,true);
  const landing=envelope.landing;assert(landing>0);
  envelope.advance(60,1,false,false,false,.1,true);
  assert(envelope.landing<landing);
  envelope.advance(60,0,false,false,true,.1,true);
  const brake=envelope.braking;assert(brake>0);
  envelope.advance(60,0,false,false,true,.1,true);
  assert(envelope.braking<brake);
  envelope.reset();
  envelope.advance(60,1,true,true,false,.1,false);
  envelope.advance(60,1,true,true,true,.1,true);
  assert.equal(envelope.landing,0);assert.equal(envelope.braking,0);
});
test('sound envelopes remain time-based and bounded under invalid dt and extreme tuning',()=>{
  const run=fps=>{
    const envelope=new EngineEnvelope();
    for(let i=0;i<fps*2;i++)envelope.advance(1e100,1,true,false,false,1/fps);
    return envelope;
  };
  const slow=run(30),fast=run(144);
  for(const field of ['speed','thrust','boost','air'])assert(Math.abs(slow[field]-fast[field])<1e-10);
  for(const dt of [NaN,Infinity,-1,0,1e10]) {
    for(const layer of fast.advance(1e100,1,true,false,false,dt)) {
      assert(layer.every(Number.isFinite));assert(layer[0]<.2);assert(layer[1]<2);
    }
  }
});
test('water contact warms airflow without inventing motion or wet airborne audio',()=>{
  const dry=new EngineEnvelope(),wet=new EngineEnvelope();
  for(let i=0;i<120;i++){
    dry.advance(60,.5,false,false,false,1/60,true,false);
    wet.advance(60,.5,false,false,false,1/60,true,true);
  }
  assert(wet.layers[1][0]>dry.layers[1][0]);assert(wet.layers[1][2]<dry.layers[1][2]);
  assert.equal(wet.layers[0][1],dry.layers[0][1]);
  for(let i=0;i<120;i++)wet.advance(60,1,true,true,false,1/60,false,true);
  assert(wet.water<.001 && wet.speed<.001 && wet.thrust<.001);
});
test('audio uses authoritative holds, fuel and focus without replaying boost on resume',()=>{
  const audio=new WorldAudio(),parameter=()=>({value:0,setTargetAtTime(value){this.value=value;}});
  audio.context={state:'running',currentTime:0};audio.enabled=true;
  audio.master={gain:parameter()};
  audio.voices=Array.from({length:3},()=>({gain:{gain:parameter()},source:{playbackRate:parameter()},filter:{frequency:parameter()}}));
  const state={telemetry:new Float64Array(15),scene:{waitingCollision:0}},p=state.telemetry,input={throttle:1,flags:2};
  p[5]=60;p[6]=1;p[7]=1;
  for(let i=0;i<120;i++)audio.update(state,input,1/60,true);
  assert(audio.envelope.boost>.99);
  for(const change of [()=>{p[6]=0;},()=>{p[7]=0;},()=>{p[8]=1;},
    ()=>{p[8]=2;},()=>{p[8]=3;},()=>{state.scene.waitingCollision=1;},()=>{input.flags=3;}]) {
    p[6]=1;p[7]=1;p[8]=0;state.scene.waitingCollision=0;input.flags=2;change();
    for(let i=0;i<180;i++)audio.update(state,input,1/60,true);
    assert(audio.envelope.boost<.001);
  }
  audio.update(state,input,1/60,false);assert.equal(audio.master.gain.value,0);
  p[6]=1;p[7]=1;p[8]=0;state.scene.waitingCollision=0;input.throttle=0;input.flags=0;
  audio.update(state,input,1/60,true);
  assert.equal(audio.envelope.boost,0);assert.equal(audio.envelope.landing,0);
  audio.enabled=false;audio.update(state,input,1/60,false);
  assert.equal(audio.active,true);
});
test('muting cancels a delayed audio resume without preventing the next activation',async()=>{
  const previous=globalThis.AudioContext,audio=new WorldAudio();
  let resumed;
  globalThis.AudioContext=function(){};
  audio.context={currentTime:0,resume:()=>new Promise(resolve=>{resumed=resolve;}),suspend:async()=>{}};
  audio.master={gain:{setValueAtTime(){},setTargetAtTime(){}}};
  try {
    const pending=audio.enable();audio.mute();resumed();await pending;
    assert.equal(audio.enabled,false);
    const next=audio.enable();resumed();await next;
    assert.equal(audio.enabled,true);
  } finally {
    clearTimeout(audio.release);
    if(previous===undefined)delete globalThis.AudioContext;else globalThis.AudioContext=previous;
  }
});
test('tuning accepts native physical domains without gameplay ceilings and retains malformed records',()=>{
  const record={version:1,values:TUNING_FIELDS.map(f=>f[1]),cameraSeconds:.5};
  assert.equal(validateTuningRecord(record),record);
  record.values[0]=250;record.values[1]=500;record.values[16]=2;
  assert.doesNotThrow(()=>validateTuningRecord(record));
  for(const change of [{cameraSeconds:-1},{cameraSeconds:Infinity},{values:[1]},
    {values:record.values.map((n,i)=>i===1?100:n)},{values:record.values.map((n,i)=>i===14?0:n)},
    {values:record.values.map((n,i)=>i===8?1e100:n)}])assert.throws(()=>validateTuningRecord({...record,...change}),/retained/);
  assert.equal(record.values[1],500);
});
test('camera uses the shared object BVH and rejects corrupt topology',()=>{
  const collision=new CameraCollision();
  collision.event({event:'collision',vertices:new Float64Array([5,0,-10,5,20,-10,5,0,10]),
    nodes:new Float64Array([5,0,-10,5,20,10,0,1,-1,-1])});
  collision.frame({},0);
  assert(collision.clip([0,3,0],[10,3,0],[0,0])[0]<5);
  assert(collision.ready);
  assert.deepEqual(collision.clip([0,30,0],[10,30,0],[0,0]),[10,30,0]);
  collision.tree.nodes[8]=0;collision.tree.nodes[9]=0;
  assert.throws(()=>collision.clip([0,3,0],[10,3,0],[0,0]),/topology/);
  collision.event({event:'collision',vertices:new Float64Array(),nodes:new Float64Array()});
  collision.frame({},0);
  assert.deepEqual(collision.clip([0,3,0],[10,3,0],[0,0]),[10,3,0]);
  assert.deepEqual(collision.clip([0,3,0],[100,3,0],[0,0]),[50,3,0]);
  assert(collision.coverageLimited);
});
test('camera terrain buckets clip ground, skip water and guard expected unloaded tiles',()=>{
  const collision=new CameraCollision(),size=1600/3;
  const manifest={regions:[{placement:[0,0],tile_origin:[32,32]}],
    tiles:[{region:0,x:32,y:32},{region:0,x:33,y:32}]};
  collision.configure(manifest);
  collision.event({event:'collision',vertices:new Float64Array(),nodes:new Float64Array()});
  const ground=new Float32Array([0,3,0,0,1,0,0, size,3,0,0,1,0,0, 0,3,size,0,1,0,0]);
  collision.event({event:'detail',removed:[],tiles:[{index:0,placement:[0,0],vertices:ground}]});
  collision.frame({},0);
  assert(collision.clip([1,1,1],[1,5,1],[0,0])[1]<3);
  assert(collision.ready);
  assert(collision.clip([530,8,1],[540,8,1],[0,0])[0]<size);assert(!collision.ready);
  ground[6]=ground[13]=ground[20]=2;
  collision.event({event:'detail',removed:[],tiles:[{index:0,placement:[0,0],vertices:ground}]});
  collision.frame({},0);
  assert.deepEqual(collision.clip([1,1,1],[1,5,1],[0,0]),[1,5,1]);
  collision.frame({scene:{unresolvedCollision:[{bounds:[[-2,-6,0],[2,-5,20]],boundsKnown:true}]}},0);
  assert(collision.clip([0,5,0],[10,5,0],[0,0])[0]<5);assert(!collision.ready);
  collision.event({event:'detail',removed:[0],tiles:[]});assert.equal(collision.tiles.size,0);
});
