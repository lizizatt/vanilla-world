import test from 'node:test';
import assert from 'node:assert/strict';
import {VEHICLES,DEFAULT_CHOICE,normalizeChoice,readChoice,writeChoice,tracksFor,vehicleOf,canSwitch,skinOf,stepSkin} from './vehicles.js';
import {validateTrack} from './race.js';
import {nearestFlag} from './race-flags.js';

const base={id:'a',start:{pos:[0,0,0],yaw:0},gates:[{pos:[0,0,-50],yaw:0,width:30}]};
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};};

test('every vehicle has an id matching its key and a first skin',()=>{
  for(const [key,v] of Object.entries(VEHICLES)){assert.equal(v.id,key);assert.ok(v.skins.length);}
  assert.deepEqual(normalizeChoice(undefined),DEFAULT_CHOICE);
  assert.equal(skinOf(DEFAULT_CHOICE).name,'Rocket (current)');
});
test('tracks default to the podracer and validate their vehicle',()=>{
  assert.equal(validateTrack(base).vehicle,'podracer');
  assert.throws(()=>validateTrack({...base,vehicle:'plane'}),/vehicle/);
  assert.throws(()=>validateTrack({...base,vehicle:'hovercraft'}),/vehicle/);
});
test('only the active vehicle\'s tracks are offered, and free flight has none',()=>{
  const list=[validateTrack(base),{...base,id:'b',vehicle:'plane'}];
  assert.deepEqual(tracksFor(list,'podracer').map(t=>t.id),['a']);
  assert.deepEqual(tracksFor(list,'plane').map(t=>t.id),['b']);
  assert.deepEqual(tracksFor(list,'free-flight'),[]);
  assert.equal(nearestFlag(tracksFor(list,'plane'),[0,0,0])?.id,'b');
  assert.equal(vehicleOf({}),'podracer');
});
test('choice round-trips and bad stored values fall back',()=>{
  const s=store();assert.deepEqual(readChoice(s),DEFAULT_CHOICE);
  writeChoice({vehicle:'podracer',skin:'rocket'},s);assert.deepEqual(readChoice(s),{vehicle:'podracer',skin:'rocket'});
  assert.deepEqual(normalizeChoice({vehicle:'podracer',skin:'dug-racer-green'}),DEFAULT_CHOICE);
  assert.deepEqual(normalizeChoice({vehicle:'plane',skin:'nope'}),DEFAULT_CHOICE);
  assert.deepEqual(normalizeChoice({vehicle:'podracer',skin:'nope'}),DEFAULT_CHOICE);
  s.setItem('racer.vehicle','{bad');assert.deepEqual(readChoice(s),DEFAULT_CHOICE);
  assert.deepEqual(normalizeChoice({vehicle:'__proto__'}),DEFAULT_CHOICE);
});
test('switching is blocked during a race or while editing',()=>{
  assert.equal(canSwitch({}),true);assert.equal(canSwitch({race:{}}),false);assert.equal(canSwitch({editing:true}),false);
});

test('a fresh load boots the podracer even if free flight or junk was persisted',async()=>{
  const {bootChoice,writeChoice,DEFAULT_CHOICE}=await import('./vehicles.js');
  const mem=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};};
  assert.deepEqual(bootChoice(mem()),DEFAULT_CHOICE);assert.equal(DEFAULT_CHOICE.skin,'rocket');
  for(const v of ['plane','free-flight']){const s=mem();s.setItem('racer.vehicle',JSON.stringify({vehicle:v,skin:'camera'}));assert.deepEqual(bootChoice(s),DEFAULT_CHOICE);}
  const s=mem();s.setItem('racer.vehicle','{bad');assert.deepEqual(bootChoice(s),DEFAULT_CHOICE);
  const g=mem();writeChoice({vehicle:'podracer',skin:'rocket'},g);assert.equal(bootChoice(g).vehicle,'podracer');
});

test('the gnome rocket car is a runtime-loaded Data skin, never a shipped model',()=>{
  const skin=VEHICLES.podracer.skins.find(s=>s.id==='gnome-rocket-car');
  assert.deepEqual([skin.source,skin.display,skin.model],['wow',2490,'Creature\\GnomeRocketCar\\GnomeRocketCar']);
  assert.deepEqual(normalizeChoice({vehicle:'podracer',skin:'gnome-rocket-car'}),{vehicle:'podracer',skin:'gnome-rocket-car'});
  assert.equal(readChoice(store()).skin,'rocket');
});
test('wow skin payload is a display-0 craft override and animation follows travel',async()=>{
  const {loadWowModel,advanceAnimation,framePose}=await import('./wow-skin.js');
  const frames={idle:{duration:2,poses:[0,1,2,3].map(n=>Float32Array.of(n))},drive:{duration:1,poses:[10,11,12,13].map(n=>Float32Array.of(n))}};
  const asset={indices:new Uint32Array(3),vertices:new Float32Array(36)};
  const client={request:async(action,fields)=>{assert.deepEqual([action,fields],['craft-model',{display:2490}]);return {asset,textures:[],metadata:{display:2490,scale:1.5,exhausts:[[1,0,0]]},frames};}};
  const model=await loadWowModel(client,{display:2490});
  assert.deepEqual([model.key,model.metadata.display,model.metadata.scale,model.metadata.exhausts,model.frames===frames],['wow:2490',0,1.5,[],true]);
  assert.equal((await loadWowModel({request:async()=>({asset,textures:[],metadata:{scale:1.5}})},{display:1,scale:2})).metadata.scale,2);
  let anim=advanceAnimation(undefined,0,0);
  assert.deepEqual([anim.driving,anim.phase],[false,0]);
  assert.equal(framePose(frames,anim)[0],0);
  anim=advanceAnimation(anim,1.5,0);assert.equal(framePose(frames,anim)[0],3);
  anim=advanceAnimation(anim,.25,8);
  assert.equal(anim.driving,true);assert.equal(framePose(frames,anim)[0],12);
  assert(Math.abs(advanceAnimation({phase:.1},.15,-8).phase-.8)<1e-9);
  assert.equal(advanceAnimation({phase:0},1,1e6).phase,0);
  assert.equal(framePose({idle:frames.idle},{driving:true,phase:.5,time:0})[0],0);
});
test('stepSkin carousel wraps, skips unusable skins, and tolerates empty/one-skin lists',()=>{
  const s=['a','b','c'].map(id=>({id}));
  assert.equal(stepSkin(s,'c',1),'a');assert.equal(stepSkin(s,'a',-1),'c');assert.equal(stepSkin(s,'a',1),'b');
  assert.equal(stepSkin(s,'a',1,x=>x.id!=='b'),'c');
  assert.equal(stepSkin(s,'a',1,()=>false),'a');
  assert.equal(stepSkin([{id:'x'}],'x',1),'x');
  assert.equal(stepSkin([],'x',1),'x');
});
