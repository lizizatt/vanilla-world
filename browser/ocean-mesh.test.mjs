import test from 'node:test';
import assert from 'node:assert/strict';
import {oceanMesh,dipDepth,OCEAN_CELL} from './ocean-mesh.js';
import {maelstromCentre,WHIRLPOOL_DIP,FUNNEL} from './clouds.js';

const manifest={ocean:[-30000,-30000,30000,30000],sea_level:0,
  world_bounds:[[0,0,63,63],[0,0,63,63]],regions:[{placement:[-20000,-15000]},{placement:[20000,-15000]}]};

test('dip profile is zero at and beyond the rim and deepest at the centre',()=>{
  const {radius,depth}=WHIRLPOOL_DIP;
  assert.equal(dipDepth(0),depth);assert.equal(dipDepth(radius),0);assert.equal(dipDepth(radius*2),0);
  assert.ok(dipDepth(radius-1)<1e-3);
  assert.equal(FUNNEL.seaLevel,-depth);
});
test('ocean mesh dips to the profile bottom and stays flat elsewhere',()=>{
  const [cx,cz]=maelstromCentre(manifest),m=oceanMesh(manifest,16);
  let lowest=0,highest=-1e9;
  for(let i=0;i<m.length;i+=7){lowest=Math.min(lowest,m[i+1]);highest=Math.max(highest,m[i+1]);}
  assert.equal(highest,0);assert.equal(lowest,-WHIRLPOOL_DIP.depth);
  assert.equal(m.length%21,0);
  assert.ok(cx>-30000&&cz>-30000);
});
test('without world bounds the ocean is a flat grid of bendable cells',()=>{
  const m=oceanMesh({...manifest,world_bounds:undefined});
  assert.equal(m.length,42*Math.ceil(60000/OCEAN_CELL)**2);assert.ok(m.every((v,i)=>i%7!==1||v===0));
});
