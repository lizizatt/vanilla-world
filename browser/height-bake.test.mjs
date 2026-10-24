import test from 'node:test';
import assert from 'node:assert/strict';
import {splatHeights,encodeHeights,HEIGHT_W,HEIGHT_H,HEIGHT_MIN,HEIGHT_RANGE} from './height-bake.js';
import {WORLD_CENTRE,PLANET_RADIUS} from './space.js';

test('a vertex lands in the texel for its lat/lon and keeps the max',()=>{
  const g=new Float32Array(HEIGHT_W*HEIGHT_H).fill(-Infinity),[cx,cz]=WORLD_CENTRE;
  splatHeights(g,new Float32Array([0,500,0,0,1,0,2,0,900,0,0,1,0,2]),[cx,cz],[cx,cz],PLANET_RADIUS);
  const k=Math.floor(.5*HEIGHT_H)*HEIGHT_W+Math.floor(.5*HEIGHT_W);
  assert.equal(g[k],900);
});
test('north is up and out-of-range vertices are ignored',()=>{
  const g=new Float32Array(HEIGHT_W*HEIGHT_H).fill(-Infinity),[cx,cz]=WORLD_CENTRE;
  splatHeights(g,new Float32Array([0,100,-PLANET_RADIUS*.5,0,1,0,2,1e9,5,0,0,1,0,2]),[cx,cz],[cx,cz],PLANET_RADIUS);
  const y=g.findIndex(v=>v>-Infinity)/HEIGHT_W|0;
  assert.ok(y<HEIGHT_H/2);assert.equal(g.filter(v=>v>-Infinity).length,1);
});
test('encoding clamps and treats unset/underwater as sea level',()=>{
  const b=encodeHeights(new Float32Array([-Infinity,-50,HEIGHT_RANGE*2]));
  assert.equal(b[0],b[1]);assert.equal(b[0],Math.round(-HEIGHT_MIN/HEIGHT_RANGE*255));assert.equal(b[2],255);
});
