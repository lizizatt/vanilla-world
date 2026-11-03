import test from 'node:test';
import assert from 'node:assert/strict';
import {smoothLiquidDepth,LIQUID_CELL} from './liquid-smooth.js';

const vert=(ix,iz,depth,material)=>[ix*LIQUID_CELL,0,iz*LIQUID_CELL,depth,1,1,material];
const field=(n,depthAt)=>{
  const v=[];
  for(const c of [0,n*LIQUID_CELL*4])v.push(...vert(-20,-20,0,0),...vert(40,40,0,0),...vert(c?40:-20,c?-20:40,0,0));
  for(let x=0;x<n;x++)for(let z=0;z<n;z++)v.push(...vert(x,z,depthAt(x,z),2));
  return new Float32Array(v);
};
const depthOf=(v,x,z)=>{for(let o=0;o<v.length;o+=7)if(v[o+6]===2&&Math.round(v[o]/LIQUID_CELL)===x&&Math.round(v[o+2]/LIQUID_CELL)===z)return v[o+3];};

test('rim vertices lose depth where lattice neighbours are open land',()=>{
  const v=smoothLiquidDepth(field(10,()=>.6));
  assert.ok(depthOf(v,0,5)<.6&&depthOf(v,0,5)>0,'edge vertex feathers');
  assert.ok(Math.abs(depthOf(v,5,5)-.6)<1e-6,'interior stays');
});
test('a staircase shore becomes monotone toward the lake',()=>{
  const v=smoothLiquidDepth(field(12,(x,z)=>x<3+(z%2)?.2:1));
  assert.ok(depthOf(v,3,5)<=depthOf(v,6,5));
  for(let o=0;o<v.length;o+=7)if(v[o+6]===2)assert.ok(v[o+3]>=0&&v[o+3]<=1);
});
test('smoothing never raises depth and leaves terrain untouched',()=>{
  const raw=field(10,(x,z)=>(x*7+z*3)%5/5);
  const v=smoothLiquidDepth(Float32Array.from(raw));
  for(let o=0;o<v.length;o+=7){
    if(v[o+6]===2)assert.ok(v[o+3]<=raw[o+3]+1e-6);else assert.equal(v[o+3],raw[o+3]);
  }
});
test('tile without liquid is returned unchanged',()=>{
  const raw=new Float32Array(vert(0,0,0,0));
  assert.deepEqual([...smoothLiquidDepth(raw)],[...raw]);
});
