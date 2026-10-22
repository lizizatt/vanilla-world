import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraView} from './world-camera.js';
import {WorldInput} from './world-input.js';
import {SFX} from './swe1r/sfx.js';
import {fillEngineBuffer,EngineEnvelope,WorldAudio} from './world-audio.js';
import {TUNING_FIELDS,validateTuningRecord,migrateTuning} from './world-tuning.js';
import {CameraCollision,prepareDetail} from './camera-collision.js';

test('local chase distance damping is time-based, rebases precisely, and clips after filtering',()=>{
  const state=[100,2,100,0],settings={cameraSeconds:.5,cameraDistance:15};
  const run=fps=>{
    const rig={};
    cameraView(rig,state,undefined,0,[100,100],{...settings,cameraDistance:5});
    for(let i=0;i<fps;i++)cameraView(rig,state,undefined,1/fps,[100,100],settings);
    return rig.camera;
  };
  const reference=run(30);
  for(const fps of [60,144])assert(run(fps).every((n,i)=>Math.abs(n-reference[i])<1e-10));
  const rig={};
  cameraView(rig,[1e9,2,-1e9,0],undefined,0,[1e9,-1e9],settings);
  const before=rig.camera.slice();
  cameraView(rig,[1e9,2,-1e9,0],undefined,0,[1e9+256,-1e9+256],settings);
  assert.deepEqual(rig.camera,before.map((n,i)=>n-(i===1?0:256)));
  let casts=0;
  rig.clipCamera=(_pivot,to)=>{casts++;return [to[0],to[1],Math.min(4,to[2])];};
  cameraView(rig,[0,2,0,0],undefined,.016,[0,0],settings);
  assert.equal(casts,2);assert(rig.camera[2]<=4);
  rig.camera=undefined;
  cameraView(rig,[0,2,0,1],undefined,0,[0,0],settings);
  assert.equal(rig.chase[0],0,'Orbit is vehicle-relative, not a delayed world heading');
});
test('500yd/s acceleration, reverse and turns never accumulate chase translation or heading lag',()=>{
  const distance=14.85,pitch=-Math.atan(.3);
  for(const shift of [0,1e9])for(const fps of [30,60,144]){
    const rig={},state=[shift,2,-shift,0,0,0,1,1,0];
    for(let i=0;i<fps*4;i++){
      const speed=i<fps?500*i/fps:i<2*fps?500:-500;
      state[3]=i/fps*.9;state[5]=Math.abs(speed);
      state[0]-=Math.sin(state[3])*speed/fps;state[2]-=Math.cos(state[3])*speed/fps;
      const origin=[Math.round(state[0]/256)*256,Math.round(state[2]/256)*256];
      cameraView(rig,state,undefined,1/fps,origin,{cameraDistance:15,cameraSeconds:.5});
      const offset=rig.camera.map((n,k)=>n-(k===0?state[0]-origin[0]:k===1?state[1]:state[2]-origin[1]));
      const expected=[Math.sin(state[3])*Math.cos(pitch)*distance,3-Math.sin(pitch)*distance,
        Math.cos(state[3])*Math.cos(pitch)*distance];
      assert(offset.every((n,k)=>Math.abs(n-expected[k])<1e-9),'Translation, speed and yaw must not change the local offset');
    }
  }
});
test('grounded vertical jitter is damped without horizontal lag or unbounded climb compensation',()=>{
  const rig={},state=[0,2,0,0,0,500,1,1,0],raw=[],drawn=[];
  const height=3+14.85*Math.sin(Math.atan(.3));
  for(let i=0;i<180;i++){
    state[0]=i*500/60;state[1]=2+.15*Math.sin(i*Math.PI/3);
    const view=cameraView(rig,state,undefined,1/60,[0,0],{});
    assert.equal(rig.camera[0],state[0]);
    assert(Math.abs(view.look[1]+Math.sin(Math.atan(.3)))<1e-9,'Vertical damping must not reintroduce terrain jitter through look pitch');
    if(i>60){raw.push(state[1]);drawn.push(rig.camera[1]);}
  }
  const span=a=>Math.max(...a)-Math.min(...a);
  assert(span(drawn)<span(raw)*.1,'Suspension-scale terrain jitter must actually be attenuated');
  for(let i=0;i<120;i++){
    state[1]+=1;
    cameraView(rig,state,undefined,1/60,[0,0],{});
    assert(Math.abs(rig.camera[1]-state[1]-height)<=.350001);
  }
  for(const [grounded,hold] of [[0,0],[1,1],[1,3]]){
    state[7]=grounded;state[8]=hold;
    cameraView(rig,state,undefined,1/60,[0,0],{});
    assert(Math.abs(rig.camera[1]-state[1]-height)<1e-9);
  }
  rig.camera=undefined;state[1]=500;state[7]=1;state[8]=0;
  cameraView(rig,state,undefined,0,[0,0],{});
  assert(Math.abs(rig.camera[1]-state[1]-height)<1e-9);
});
test('camera orbit clamps pitch, wraps yaw and returns behind the craft; flight bypasses chase',()=>{
  const rig={},state=[0,2,0,Math.PI-.01];
  cameraView(rig,state,undefined,.016,[0,0],{});
  for(let i=0;i<100;i++)cameraView(rig,state,undefined,.1,[0,0],{cameraLook:[1,1]});
  assert(Math.abs(rig.chase[0])<=Math.PI);assert(rig.chase[1]<Math.PI/2);
  const pitch=rig.chase[1],yaw=rig.chase[0];cameraView(rig,state,undefined,.1,[0,0],{});
  assert.equal(rig.chase[1],pitch,'idle camera holds where the mouse left it');assert.equal(rig.chase[0],yaw);
  cameraView(rig,state,undefined,.1,[0,0],{cameraRecentre:true});assert(rig.chase[1]<pitch);
  cameraView(rig,state,[100,200,300,0,0],.1,[100,300],{});
  assert.deepEqual(rig.camera,[0,200,0]);
});
const pad=()=>({connected:true,mapping:'standard',index:0,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))});
test('both keyboard profiles reverse like the controller, with distinct brake and hop keys',()=>{
  const input=new WorldInput(),keys=new Set(['KeyS','Space']);
  assert.deepEqual([input.sample(keys,[],true).throttle,input.sample(keys,[],true).flags],[-1,4]);
  assert.deepEqual([input.sample(keys,[],true,'legacy').throttle,input.sample(keys,[],true,'legacy').flags],[-1,1]);
  for(const [k,native,legacy] of [['Space',4,1],['KeyC',4,4],['ControlLeft',0,0],['ControlRight',0,0]]){
    assert.equal(input.sample(new Set([k]),[],true).flags,native,k);assert.equal(input.sample(new Set([k]),[],true,'legacy').flags,legacy,k);
  }
  for(const profile of ['native','legacy']){
    assert.equal(input.sample(new Set(['KeyS']),[],true,profile).throttle,-1);
    assert.equal(input.sample(new Set(['KeyS']),[],true,profile).flags,0);
    assert.equal(input.sample(new Set(['KeyW','KeyS']),[],true,profile).throttle,0);
    assert.equal(input.sample(new Set(['KeyX']),[],true,profile).flags,1);
    assert.equal(input.sample(new Set(['KeyJ']),[],true,profile).flags,8);
  }
  assert.equal(input.sample(new Set(['KeyW','Space']),[],false).flags,1);
  assert.equal(input.sample(new Set(['KeyW']),[],false).throttle,0);
});
test('gamepad triggers subtract, noisy sticks never steal input, edges and disconnect are safe',()=>{
  const input=new WorldInput(),p=pad(),keys=new Set();
  p.axes[0]=.17;input.sample(keys,[p],true);assert.equal(input.device,'keyboard');
  p.buttons[6].value=1;p.axes[2]=1;
  let state=input.sample(keys,[p],true);assert.equal(state.throttle,-1);assert.equal(state.look[0],1);
  p.buttons[7].value=1;p.buttons[11].pressed=true;
  state=input.sample(keys,[p],true);assert.equal(state.throttle,0);assert(state.cockpit);
  assert(!input.sample(keys,[p],true).cockpit);
  keys.add('KeyW');input.keyboard();input.sample(keys,[p],true);assert.equal(input.device,'keyboard');
  assert.equal(input.sample(keys,[],true).throttle,1);
  assert.equal(input.device,'keyboard');
});
test('Handling ignores form/controller input without braking; blur and explicit X still brake',()=>{
  const input=new WorldInput(),p=pad();
  p.buttons[7].value=1;p.buttons[3].pressed=true;
  const editing=input.sample(new Set(['KeyW','KeyX','Space']),[p],false,'native',false);
  assert.equal(editing.flags,0);assert.equal(editing.throttle,0);assert.equal(editing.steer,0);
  assert(!editing.reset);assert(!editing.cockpit);
  assert.equal(input.sample(new Set(),[p],false,'native',true).flags,1);
  assert.equal(input.sample(new Set(['KeyX']),[],true).flags,1);
});
test('held keyboard thrust and braking cannot be stolen by simultaneous controller activity',()=>{
  const input=new WorldInput(),p=pad();
  p.buttons[7].value=1;input.sample(new Set(),[p],true);
  assert.equal(input.device,'controller');
  for(const keys of [new Set(['KeyS']),new Set(['KeyW','KeyS'])]){
    p.axes[2]=p.axes[2]===1?.5:1;
    const value=input.sample(keys,[p],true);
    assert.equal(value.throttle,keys.has('KeyW')?0:-1);assert.equal(value.flags,0);assert.equal(input.device,'keyboard');
  }
  p.axes[2]=.4;
  const brake=input.sample(new Set(['KeyX']),[p],true);
  assert.equal(brake.throttle,0);assert.equal(brake.flags,1);assert.equal(input.device,'keyboard');
  assert.equal(input.sample(new Set(['KeyS']),[p],false).throttle,0);
  p.axes[2]=0.8;assert.equal(input.sample(new Set(),[p],true).throttle,1);
});
test('keyboard keeps driving priority without swallowing controller view and mode edges',()=>{
  for(const [button,action,expected] of [[11,'cockpit',true],[3,'reset',true],[9,'flight',true],
    [8,'help',true],[12,'zoom',1],[13,'zoom',-1]]){
    const input=new WorldInput(),p=pad(),keys=new Set(['KeyW']);
    p.buttons[6].value=1;p.buttons[button].pressed=true;
    const first=input.sample(keys,[p],true);
    assert.equal(first.throttle,1);assert.equal(first.flags,0);assert.equal(input.device,'keyboard');
    assert.equal(first[action],expected);
    assert(!input.sample(keys,[p],true)[action],'A held button is not a second edge');
    p.buttons[button].pressed=false;input.sample(keys,[p],true);
    p.buttons[button].pressed=true;
    assert(!input.sample(keys,[p],false)[action],'Focused UI suppresses mode actions');
    assert(!input.sample(keys,[p],true)[action],'Suppressed actions are not queued until focus returns');
  }
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
  input.throttle=-1;input.flags=2;p[14]=-60;
  for(let i=0;i<180;i++)audio.update(state,input,1/60,true);
  assert(audio.envelope.thrust>.99,'Reverse thrust still loads the engine');
  assert.equal(audio.envelope.boost,0,'Reverse thrust must not sound like forward boost');
  audio.enabled=false;audio.update(state,input,1/60,false);
  assert.equal(audio.active,true);
});
test('muting cancels a delayed audio resume without preventing the next activation',async()=>{
  const previous=globalThis.AudioContext,audio=new WorldAudio();
  let resumed;
  globalThis.AudioContext=function(){};
  audio.context={state:'suspended',currentTime:0,resume:()=>new Promise(resolve=>{
    resumed=()=>{audio.context.state='running';resolve();};
  }),suspend:async()=>{}};
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
test('audio retries suspended/interrupted contexts, rejects incomplete resume and reuses voices',async()=>{
  const previous=globalThis.AudioContext,audio=new WorldAudio();
  let starts=0,resumes=0;
  const parameter=()=>({value:0,setValueAtTime(value){this.value=value;},setTargetAtTime(value){this.value=value;}});
  globalThis.AudioContext=class {
    constructor(){this.state='suspended';this.currentTime=0;this.destination={};}
    createGain(){return {gain:parameter(),connect(){}};}
    createAnalyser(){return {connect(){}};}
    createBiquadFilter(){return {frequency:parameter(),Q:parameter(),connect(){}};}
    createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));
      return {sampleRate,getChannelData:i=>data[i]};}
    createBufferSource(){return {playbackRate:parameter(),connect(){},start(){starts++;}};}
    async resume(){resumes++;this.state='running';}
  };
  try {
    await audio.enable();const voices=audio.voices.slice();
    await audio.enable();assert.equal(resumes,1);
    for(const state of ['suspended','interrupted']) {
      audio.context.state=state;await audio.enable();
      assert(audio.enabled);assert.equal(audio.context.state,'running');
      assert(audio.voices.every((voice,i)=>voice===voices[i]));
    }
    assert.equal(starts,3);
    audio.context.state='suspended';audio.context.resume=async()=>{};
    await assert.rejects(audio.enable(),/Sound is suspended/);assert(!audio.enabled);
    audio.context.state='closed';await audio.enable();
    assert.equal(starts,6);assert.equal(audio.voices.length,3);assert(audio.enabled);
  } finally {
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
test('fresh Handling and Restore defaults use the user-provided values without migrating saved overrides',()=>{
  assert.deepEqual(TUNING_FIELDS.map(f=>f[1]),[150,300,50,30,30,.25,2.2,10,8,1.5,1.3,3,90,18,24,7,.9]);
  const saved={version:1,values:[36,50,18,22,30,.25,2.2,10,8,1.5,1.3,1.1,90,18,24,7,.9],cameraSeconds:.7};
  assert.equal(validateTuningRecord(saved),saved);assert.equal(saved.values[0],36);assert.equal(saved.values[11],1.1);
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
test('camera terrain allocation preserves a full tile and exact bucket membership',()=>{
  const source=new Float32Array(128*128*4*21),unit=(1600/3)/128;
  let offset=0;
  for(let z=0;z<128;z++)for(let x=0;x<128;x++){
    const center=[(x+.5)*unit,Math.sin(x/12)*3,(z+.5)*unit];
    const corners=[[x*unit,0,z*unit],[(x+1)*unit,1,z*unit],
      [(x+1)*unit,2,(z+1)*unit],[x*unit,3,(z+1)*unit]];
    for(let t=0;t<4;t++)for(const p of [center,corners[t],corners[(t+1)%4]]){
      source.set([...p,0,1,0,(x+z)%17===0?2:0],offset);offset+=7;
    }
  }
  const vertices=[],buckets=Array.from({length:1024},()=>[]);
  const cell=n=>Math.max(0,Math.min(31,Math.floor(n/((1600/3)/32))));
  for(let i=0;i<source.length;i+=21){
    if(source[i+6]!==0)continue;
    const first=vertices.length;
    const points=[0,7,14].map(offset=>Array.from(source.subarray(i+offset,i+offset+3)));
    vertices.push(...points.flat());
    for(let z=cell(Math.min(...points.map(p=>p[2])));z<=cell(Math.max(...points.map(p=>p[2])));z++)
      for(let x=cell(Math.min(...points.map(p=>p[0])));x<=cell(Math.max(...points.map(p=>p[0])));x++)
        buckets[z*32+x].push(first);
  }
  const collision=new CameraCollision(),placement=[-500,700];
  collision.event({event:'detail',removed:[],tiles:[{index:1,placement,vertices:source}]});
  const tile=collision.tiles.get(1);
  assert.deepEqual(tile.vertices,new Float32Array(vertices));assert.deepEqual(tile.placement,placement);
  assert.deepEqual(buckets,buckets.map((_,i)=>Array.from(tile.triangles.subarray(tile.offsets[i],tile.offsets[i+1]))));
  assert.equal(tile.vertices.buffer.byteLength,vertices.length*4,'Only ground vertices retain storage');
});
test('prepared and direct camera terrain produce the same clipping and reject corrupt indices',()=>{
  const vertices=new Float32Array([0,3,0,0,1,0,0, 10,3,0,0,1,0,0, 0,3,10,0,1,0,0]);
  const event={event:'detail',removed:[],seams:[],tiles:[{index:0,placement:[0,0],vertices}]};
  const direct=new CameraCollision(),prepared=new CameraCollision();
  direct.event(event);prepared.event(prepareDetail(structuredClone(event)));
  assert.deepEqual(prepared.clip([1,1,1],[1,5,1],[0,0]),direct.clip([1,1,1],[1,5,1],[0,0]));
  const damaged=prepareDetail(structuredClone(event));damaged.tiles[0].camera.triangles[0]=99;
  assert.throws(()=>prepared.event(damaged),/Invalid camera terrain index/);
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
test('mouse steer keeps the camera world heading while the craft turns toward it',()=>{
  const rig={};cameraView(rig,[0,2,0,0],undefined,.016,[0,0],{});
  cameraView(rig,[0,2,0,0],undefined,.016,[0,0],{cameraOrbit:[-100,0],cameraSteer:true});
  const offset=rig.chase[0];assert(offset>.3);
  cameraView(rig,[0,2,0,.2],undefined,.016,[0,0],{cameraSteer:true});
  assert(Math.abs(rig.chase[0]-(offset-.2))<1e-9);
});
test('old boost defaults migrate once; customised values are kept',()=>{
  const old={version:1,cameraSeconds:0,values:TUNING_FIELDS.map(f=>f[1])};old.values[1]=1000;old.values[3]=250;
  const moved=migrateTuning(old);
  assert.deepEqual([moved.values[1],moved.values[3],moved.defaults],[300,30,2]);
  const custom=migrateTuning({...old,values:old.values.map((v,i)=>i===1?600:v)});
  assert.deepEqual([custom.values[1],custom.values[3]],[600,30]);
  assert.equal(migrateTuning(moved),moved);
  assert.equal(migrateTuning(undefined),undefined);
});
test('drift plays the activate one-shot then loops until release; silent without samples',()=>{
  const log=[];
  const node=()=>({gain:{value:0},connect(){},buffer:null,loop:false,start(t){log.push(['start',this.buffer.name,this.loop,t]);},stop(){log.push(['stop',this.buffer.name]);}});
  const audio=new WorldAudio();
  audio.context={state:'running',currentTime:1,createGain:node,createBufferSource:node};audio.master={};
  audio.enabled=true;audio.active=true;audio.sampleOn=true;
  audio.setDrift(true);assert.deepEqual(log,[]);
  audio.samples={buffers:{sfx_pod_binder_activate_a:{name:'a',duration:.5},sfx_pod_binder_steady_loop:{name:'loop'}}};
  audio.setDrift(true);audio.setDrift(true);
  assert.deepEqual(log,[['start','loop',true,1.5],['start','a',false,undefined]]);
  audio.setDrift(false);audio.setDrift(false);
  assert.deepEqual(log.slice(2),[['stop','loop']]);
});
test('SWE1R one-shots fire from update on boost, airbrake and obstacle edges',()=>{
  const played=[];
  const node=()=>({gain:{value:0,setTargetAtTime(){}},playbackRate:{setTargetAtTime(){}},connect(){},buffer:null,start(){played.push(this.buffer);}});
  const audio=new WorldAudio();
  audio.context={state:'running',currentTime:10,createGain:node,createBufferSource:node};audio.master={gain:{setTargetAtTime(){}}};
  audio.enabled=true;audio.active=true;audio.sampleOn=true;
  audio.samples={buffers:{[SFX.ignite]:'flare',sfx_pod_airbrakes_on:'on',sfx_pod_airbrakes_off:'off',sfx_crash_metal_med1:'crash'}};
  const step=(flags,hit,now)=>{audio.context.currentTime=now;audio.update({telemetry:[0,0,0,0,0,50,1,1,hit?3:0,0]},{throttle:1,flags},.016,true);};
  step(0,false,10);step(2,false,11);step(2,false,12);step(3,false,13);step(0,false,14);step(0,true,15);step(0,true,15.1);
  assert.deepEqual(played,['flare','on','off','crash']);
});
test('holding boost plays the start once even if grounding or the meter flickers',()=>{
  const played=[];
  const node=()=>({gain:{value:0,setTargetAtTime(){}},playbackRate:{setTargetAtTime(){}},connect(){},start(){played.push(this.buffer);}});
  const audio=new WorldAudio();
  audio.context={state:'running',currentTime:1,createGain:node,createBufferSource:node};audio.master={gain:{setTargetAtTime(){}}};
  audio.enabled=true;audio.active=true;audio.sampleOn=true;audio.samples={buffers:{[SFX.ignite]:'start'}};
  for(const [grounded,meter] of [[1,1],[0,1],[1,0],[1,.5],[0,0],[1,1]])audio.update({telemetry:[0,0,0,0,0,50,meter,grounded,0,0]},{throttle:1,flags:2},.016,true);
  assert.deepEqual(played,['start']);
  audio.update({telemetry:[0,0,0,0,0,50,1,1,0,0]},{throttle:1,flags:0},.016,true);
  audio.update({telemetry:[0,0,0,0,0,50,1,1,0,0]},{throttle:1,flags:2},.016,true);
  assert.deepEqual(played,['start','start']);
});