import test from 'node:test';
import assert from 'node:assert/strict';
import {EnginePair,splitEngines,TILE_CAP_MIN} from './engine-pair.js';
import {MIB} from './memory-budget.js';

test('budget splits 80/20 and never exceeds the total', () => {
  const p=splitEngines(1024*MIB,'azeroth');
  assert.equal(p.azeroth.role,'near');assert.equal(p.elune.role,'far');
  assert.equal(p.azeroth.bytes+p.elune.bytes,1024*MIB);
  assert.equal(p.elune.tiles,0);assert.ok(p.azeroth.tiles>=TILE_CAP_MIN);
});
test('small budgets keep a usable far slice', () => {
  const p=splitEngines(256*MIB,'azeroth');
  assert.ok(p.elune.bytes>=51*MIB);assert.equal(p.azeroth.bytes+p.elune.bytes,256*MIB);
});
test('only the near engine steps physics, and a swap exchanges roles', () => {
  const pair=new EnginePair(1024*MIB);
  assert.ok(pair.steps('azeroth'));assert.ok(!pair.steps('elune'));
  assert.deepEqual(pair.swap('azeroth'),[]);
  assert.deepEqual(pair.swap('elune').sort(),['azeroth','elune']);
  assert.ok(pair.steps('elune'));assert.ok(!pair.steps('azeroth'));
});

test('N bodies: one near engine, the rest far-only, bytes conserved', () => {
  const ids=['azeroth','elune','moon2'],pair=new EnginePair(1024*MIB,'azeroth',ids),sum=()=>ids.reduce((a,id)=>a+pair.plan[id].bytes,0);
  assert.equal(sum(),1024*MIB);assert.equal(ids.filter(id=>pair.steps(id)).length,1);
  pair.swap('moon2');assert.ok(pair.steps('moon2'));assert.equal(sum(),1024*MIB);assert.equal(pair.plan.azeroth.tiles,0);
});
