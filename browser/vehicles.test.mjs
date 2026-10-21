import test from 'node:test';
import assert from 'node:assert/strict';
import {VEHICLES,DEFAULT_CHOICE,normalizeChoice,readChoice,writeChoice,tracksFor,vehicleOf,canSwitch,skinOf} from './vehicles.js';
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
  writeChoice({vehicle:'podracer',skin:'dug-racer'},s);assert.deepEqual(readChoice(s),{vehicle:'podracer',skin:'dug-racer'});
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
