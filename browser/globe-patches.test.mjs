import test from 'node:test';
import assert from 'node:assert/strict';
import {selectPatches,patchesAt,patchArea,MAX_PATCHES} from './globe-patches.js';

test('unculled tree tiles the whole sphere exactly (no gaps/overlap)', () => {
  for(const alt of [50,2000,500000]){
    const p=selectPatches(.3,1.2,alt,{cull:false,limit:100000}),sum=p.reduce((a,q)=>a+patchArea(q),0);
    assert.ok(Math.abs(sum-4*Math.PI)<1e-9,`${alt}: ${sum}`);
  }
});

test('patch count stays bounded and detail rises toward the eye', () => {
  for(const alt of [20,500,5000,100000,1e6]){
    const p=selectPatches(-.2,-2.5,alt);assert.ok(p.length>0&&p.length<=MAX_PATCHES,`${alt}: ${p.length}`);
  }
  const small=a=>Math.min(...selectPatches(0,0,a).map(patchArea));
  assert.ok(small(30)<small(100000));
});

test('far side is horizon-culled, nearby surface is kept', () => {
  const p=selectPatches(0,0,300),full=selectPatches(0,0,300,{cull:false,limit:100000});
  assert.ok(p.length<full.length);
  assert.ok(p.some(q=>q[0]<=0&&q[1]>=0&&q[2]<=0&&q[3]>=0));
  assert.ok(!p.some(q=>q[2]>2.5||q[3]<-2.5));
});

test('wraps across the antimeridian', () => {
  const x=1429+Math.PI*42785+30,p=patchesAt(x,-267,200);
  assert.ok(p.some(q=>q[2]>=2.9||q[3]<=-2.9));
});
