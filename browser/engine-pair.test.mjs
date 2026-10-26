import test from 'node:test';
import assert from 'node:assert/strict';
import {EnginePair,splitEngines,weightedSplit,TILE_CAP_MIN} from './engine-pair.js';
import {MIB} from './memory-budget.js';

test('weighted budget follows the camera: near body gets most, far body keeps a floor, bytes conserved', () => {
  const ids=['azeroth','elune'],tot=1024*MIB,sum=p=>ids.reduce((a,id)=>a+p[id].bytes,0);
  const onAz=weightedSplit(tot,{azeroth:100,elune:40000},ids),onEl=weightedSplit(tot,{azeroth:40000,elune:100},ids),mid=weightedSplit(tot,{azeroth:9000,elune:9000},ids);
  assert.ok(onAz.azeroth.bytes>onAz.elune.bytes*4);assert.ok(onEl.elune.bytes>onEl.azeroth.bytes*4);
  assert.ok(onAz.elune.bytes>=tot*.08-1);assert.ok(Math.abs(mid.azeroth.bytes-mid.elune.bytes)<MIB);
  for(const p of [onAz,onEl,mid])assert.equal(sum(p),tot);
});
test('weighted budget is N-body generic and moves smoothly with distance', () => {
  const ids=['a','b','c'],tot=900*MIB,p=weightedSplit(tot,{a:0,b:5000,c:1e9},ids);
  assert.equal(ids.reduce((s,id)=>s+p[id].bytes,0),tot);assert.ok(p.a.bytes>p.b.bytes&&p.b.bytes>p.c.bytes);
  const near=weightedSplit(tot,{a:1000,b:20000,c:20000},ids).a.bytes,nearer=weightedSplit(tot,{a:900,b:20000,c:20000},ids).a.bytes;assert.ok(nearer>=near&&nearer-near<tot*.02);
});

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
