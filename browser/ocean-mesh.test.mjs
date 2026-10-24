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
test('an explicit whirlpool centre wins over the one derived from a padded ocean',()=>{
  const centre=maelstromCentre(manifest),padded={...manifest,ocean:[-130000,-130000,130000,130000],whirlpool:centre},m=oceanMesh(padded,16);
  let at;for(let i=0;i<m.length;i+=7)if(m[i+1]===-WHIRLPOOL_DIP.depth)at=[m[i]+padded.ocean[0],m[i+2]+padded.ocean[1]];
  assert.ok(Math.hypot(at[0]-centre[0],at[1]-centre[1])<1e-6*Math.max(1,Math.abs(centre[0])));
});
test('without world bounds the ocean is a flat grid of bendable cells',()=>{
  const m=oceanMesh({...manifest,world_bounds:undefined});
  assert.equal(m.length,42*Math.ceil(60000/OCEAN_CELL)**2);assert.ok(m.every((v,i)=>i%7!==1||v===0));
});
