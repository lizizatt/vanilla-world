import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syntheticScene,syntheticPaths,sweepPath} from './ocean-coverage.js';

const run=(scene,opts)=>{let poses=0,points=0;const bad=[];
  for(const path of syntheticPaths())for(const p of sweepPath(scene,path,{stepYd:640,scan:{step:48},...opts})){
    poses++;points+=p.points;if(p.gaps.length||p.flood.length)bad.push({eye:p.eye.map(Math.round),gaps:p.gaps.slice(0,3),flood:p.flood.slice(0,3)});}
  return {poses,points,bad};};

for(const [name,opts] of [['drive height',{height:3}],['flight height',{height:300}],['stale mask (900 yd lag)',{height:3,lag:900}]])
  test(`ocean coverage: no gaps or flooded land, ${name}`,()=>{
    const r=run(syntheticScene(),opts);
    assert.ok(r.poses>20&&r.points>1e5);
    assert.deepEqual(r.bad,[],`uncovered/flooded poses: ${JSON.stringify(r.bad.slice(0,3))}`);
  });

test('ocean coverage: scene with a maelstrom ring stays covered',()=>{
  const r=run(syntheticScene({maelstrom:[1400,9300]}),{height:3});
  assert.deepEqual(r.bad,[]);
});
