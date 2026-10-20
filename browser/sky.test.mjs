import test from 'node:test';
import assert from 'node:assert/strict';
import {SkyCatalog,DAY,NIGHT,mapPosition,advanceTime} from './sky.js';

function dbc(fields,rows) {
  const strings=[0],str=s=>{const at=strings.length;strings.push(...Buffer.from(s+'\0'));return at;};
  const out=Buffer.alloc(20+rows.length*fields*4);
  out.write('WDBC');out.writeUInt32LE(rows.length,4);out.writeUInt32LE(fields,8);out.writeUInt32LE(fields*4,12);
  rows.forEach((row,r)=>{for(let f=0;f<fields;f++){
    const v=row[f]??0,at=20+r*fields*4+f*4;
    if(typeof v==='string')out.writeUInt32LE(str(v),at);else if(v.f!==undefined)out.writeFloatLE(v.f,at);else out.writeUInt32LE(v,at);
  }});
  const table=Buffer.from(strings);out.writeUInt32LE(table.length,16);
  return new Uint8Array(Buffer.concat([out,table]));
}
// Params 1 is the global light, params 2 a local one; only the fog band (k=7) has keys.
const band=(params,k,times,colours)=>[(params-1)*18+1+k,times.length,...times,...Array(16-times.length).fill(0),...colours,...Array(16-colours.length).fill(0)];
const bandRows=[];
for(let params=1;params<=2;params++)for(let k=0;k<18;k++)bandRows.push(band(params,k,[0,1440],k===7||k===2?(params===1?[0x000000,0xffffff]:[0xff0000,0xff0000]):[0,0]));
const catalog=()=>new SkyCatalog({
  light:dbc(12,[[1,0,0,0,0,{f:0},{f:0},1],[2,0,{f:36*100},0,{f:36*100},{f:36*10},{f:36*50},2]]),
  params:dbc(9,[[1,0,1],[2,0,0]]),
  skybox:dbc(2,[[1,'Environments\\Stars\\Stars.mdx']]),
  bands:dbc(34,bandRows)});

test('bands interpolate through the day and wrap past midnight',()=>{
  const c=catalog();
  assert.deepEqual(c.sample(0,0,0,720).fog.map(v=>+v.toFixed(2)),[.5,.5,.5]);
  assert.deepEqual(c.sample(0,0,0,DAY).fog,[1,1,1]);
  assert.deepEqual(c.sample(0,0,0,NIGHT).fog,[0,0,0]);
  assert.deepEqual(c.sample(0,0,0,2160).fog.map(v=>+v.toFixed(2)),[.5,.5,.5]);
});
test('local lights blend over the global one by falloff and carry their own skybox',()=>{
  const c=catalog();
  assert.deepEqual(c.sample(0,100,100,DAY).fog,[1,0,0]);
  const edge=c.sample(0,100+30,100,DAY).fog;
  assert.ok(edge[0]===1&&edge[1]>0&&edge[1]<1);
  assert.deepEqual(c.sample(0,500,500,DAY).fog,[1,1,1]);
  assert.equal(c.sample(0,0,0,DAY).skybox,'Environments\\Stars\\Stars.m2');
  assert.equal(c.sample(0,100,100,DAY).skybox,undefined);
  assert.equal(c.sample(7,0,0,DAY),undefined);
});
test('sky files with another layout are rejected instead of guessed',()=>{
  assert.throws(()=>new SkyCatalog({light:dbc(11,[[1]]),params:dbc(9,[[1]]),skybox:dbc(2,[[1]]),bands:dbc(34,[[1]])}),/Light/);
});
test('map positions undo the region placement',()=>{
  assert.deepEqual(mapPosition({placement:[100,200],tile_origin:[1,2]},100+10,200+20).map(Math.round),[543,1087]);
});
test('time of day only advances forward to the target and stops there',()=>{
  let time=DAY;
  for(let i=0;i<200&&time!==0;i++)time=advanceTime(time,true,.1);
  assert.equal(time,0);
  for(let i=0;i<200&&time!==DAY;i++)time=advanceTime(time,false,.1);
  assert.equal(time,DAY);
  const step=advanceTime(DAY,true,.1);
  assert.ok(step>DAY&&step<NIGHT);
});
