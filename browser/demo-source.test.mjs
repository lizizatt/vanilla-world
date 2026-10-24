import test from 'node:test';
import assert from 'node:assert/strict';
import {demoSource,demoWdt,demoWdl,demoHeight} from './demo-source.js';

test('demo WDT flags a 5x5 island per map and WDL is sized to match',()=>{
  const wdt=demoWdt('Kalimdor'),v=new DataView(wdt.buffer);
  const mainAt=8+4+8+32+8;// MVER, MPHD, MAIN header
  let n=0;for(let i=0;i<4096;i++)n+=v.getUint32(mainAt+i*8,true)&1;assert.equal(n,25);
  assert.equal(demoWdl('Azeroth').length,12+8+4096*4+25*(8+1090));
});

test('demo source serves generated tiles and rejects everything else',async()=>{
  const s=demoSource();
  assert.ok((await s.read('World\\Maps\\Kalimdor\\Kalimdor_39_43.adt')).length>100000);
  await assert.rejects(s.read('World\\Maps\\Kalimdor\\Kalimdor_1_1.adt'),{code:'NOT_FOUND'});
  await assert.rejects(s.read('Creature\\Boar.m2'),{code:'NOT_FOUND'});
});

test('island centre is land and its rim is below sea level',()=>{
  assert.ok(demoHeight('Kalimdor',39.5,43.5)>50);
  assert.ok(demoHeight('Kalimdor',36,43.5)<0);
});
