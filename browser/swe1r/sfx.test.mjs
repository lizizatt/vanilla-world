import test from 'node:test';import assert from 'node:assert/strict';
import {wipeoutBlast,pickRaceMusic,STINGER,RACE_MUSIC} from './sfx.js';
const names=['sfx_explo_gas_01','sfx_explo_gas_02','sfx_crash_metal_med1','sfx_crash_firey_a','sfx_crash_gate'];
test('wipeoutBlast layers a gas explosion with metal or fiery crash',()=>{
  assert.deepEqual(wipeoutBlast(names,()=>0),['sfx_explo_gas_01','sfx_crash_metal_med1']);
  assert.deepEqual(wipeoutBlast(names,()=>.9),['sfx_explo_gas_02','sfx_crash_firey_a']);
  assert.deepEqual(wipeoutBlast(['sfx_explo_gas_01'],()=>0),['sfx_explo_gas_01']);
});
test('race music pool and victory stinger',()=>{
  assert.equal(pickRaceMusic(()=>.99),null);assert.equal(pickRaceMusic(()=>0),'Music/PodLoop1');
  assert.equal(RACE_MUSIC.length,4);assert.equal(STINGER.win,'Music/m010podanni');
});
