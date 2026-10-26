import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {moonHeightChart,moonHeightDir,chartDir,moonAdt,moonAlbedo,MOON_TILES_X} from './moon-terrain.js';
import {ADT_TILE} from './adt-synth.js';
import {ELUNE_RADIUS} from './bodies.js';

test('deterministic per seed, different across seeds', () => {
  assert.equal(moonHeightChart(5,123.4,-987.6),moonHeightChart(5,123.4,-987.6));
  let diff=0;for(let i=0;i<50;i++)if(moonHeightChart(5,i*91,i*37)!==moonHeightChart(6,i*91,i*37))diff++;
  assert.ok(diff>40);
});

test('golden heights (changing the generator invalidates every moon map)', () => {
  const v=[[0,0],[1000,-500],[-7000,3000],[12000,2000]].map(([x,z])=>moonHeightChart(1,x,z));
  const h=createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0,12);
  assert.equal(h,GOLDEN,JSON.stringify(v));
});
const GOLDEN='bff45fe37a80';

test('heights are bounded and have relief', () => {
  let lo=1e9,hi=-1e9;
  for(let i=0;i<4000;i++){const h=moonHeightChart(3,(i*7919%32000)-16000,(i*104729%16000)-8000);lo=Math.min(lo,h);hi=Math.max(hi,h);}
  assert.ok(lo>-600&&hi<400,`${lo} ${hi}`);
  assert.ok(hi-lo>60);
});

test('longitude wrap is seamless (chart x and x+circumference agree)', () => {
  for(const z of [-3000,0,2500])for(const x of [-16000,-100,5000]) {
    const a=moonHeightChart(2,x,z),b=moonHeightChart(2,x+2*Math.PI*ELUNE_RADIUS,z);
    assert.ok(Math.abs(a-b)<.05,`${a} ${b}`);
  }
  const d=chartDir(0,0);assert.ok(Math.abs(d[0]-1)<1e-12);
});

test('shared edges of adjacent tiles match', () => {
  const f=(a,off)=>new DataView(a.buffer,a.byteOffset).getFloat32(off,true);
  // heights are a function of position, so compare the function itself on the shared edge
  const ox=(31-MOON_TILES_X/2)*ADT_TILE;
  for(const lz of [0,100,333]) assert.equal(moonHeightChart(4,ox,lz),moonHeightChart(4,(30-MOON_TILES_X/2)*ADT_TILE+ADT_TILE,lz));
  assert.ok(f);
});

test('moonAdt yields a valid ADT-sized buffer with 256 chunks', () => {
  const a=moonAdt(1,30,15);
  const s=new TextDecoder().decode(a);
  assert.equal(String.fromCharCode(...a.slice(0,4)),'REVM');
  assert.equal((s.match(/KNCM/g)||[]).length,256);
  assert.deepEqual(moonAdt(1,30,15),a);
});

test('albedo is a plausible grey-tan regolith with no purple cast', () => {
  for(let i=0;i<20;i++){const [x,y,z]=chartDir(i*900,i*200-2000),c=moonAlbedo(1,x,y,z);assert.ok(c.every(v=>v>.15&&v<.95));assert.ok(c[0]>=c[2],'red is not below blue');}
});

test('every MCNK carries the synthetic Elune area id at +0x34', async () => {
  const {ELUNE_AREA}=await import('./moon-terrain.js');const a=moonAdt(1,30,15),v=new DataView(a.buffer,a.byteOffset);
  let p=0,seen=0;while(p<a.length){const n=v.getUint32(p+4,true);if(String.fromCharCode(a[p+3],a[p+2],a[p+1],a[p])==='MCNK'){assert.equal(v.getUint32(p+8+0x34,true),ELUNE_AREA);seen++;}p+=8+n;}
  assert.equal(seen,256);
});
