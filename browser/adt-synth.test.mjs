import test from 'node:test';
import assert from 'node:assert/strict';
import {synthAdt,mcvtOffsets,ADT_CHUNK} from './adt-synth.js';

const read=bytes=>{const v=new DataView(bytes.buffer),out=[];
  for(let p=0;p<bytes.length;){const m=String.fromCharCode(bytes[p+3],bytes[p+2],bytes[p+1],bytes[p]),n=v.getUint32(p+4,true);out.push({m,p:p+8,n});p+=8+n;}
  return out;};

test('synthAdt writes MVER, MTEX and 256 MCNK with 145 heights each',()=>{
  const bytes=synthAdt((x,z)=>x+2*z),chunks=read(bytes);
  assert.deepEqual(chunks.slice(0,2).map(c=>c.m),['MVER','MTEX']);
  const mcnk=chunks.filter(c=>c.m==='MCNK');assert.equal(mcnk.length,256);
  const v=new DataView(bytes.buffer),c=mcnk[17],ofs=v.getUint32(c.p+0x14,true);
  assert.equal(String.fromCharCode(...[3,2,1,0].map(i=>bytes[c.p+ofs+i])),'MCVT');
  assert.equal(v.getUint32(c.p+ofs+4,true),145*4);
  assert.equal(v.getUint32(c.p+4,true),1);assert.equal(v.getUint32(c.p+8,true),1);
  const [dx,dz]=mcvtOffsets()[10];// row 1 (inner) col 1
  assert.ok(Math.abs(v.getFloat32(c.p+ofs+8+10*4,true)-(ADT_CHUNK+dx+2*(ADT_CHUNK+dz)))<1e-2);
});

test('mcvtOffsets has 145 vertices spanning one chunk',()=>{
  const o=mcvtOffsets();assert.equal(o.length,145);
  assert.ok(Math.max(...o.map(p=>p[0]))<=ADT_CHUNK+1e-9);
});
