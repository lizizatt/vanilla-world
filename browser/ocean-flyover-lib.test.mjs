import test from 'node:test';
import assert from 'node:assert/strict';
import {flyoverRoute,analyseFrame,checkRows,colourStep,DEFAULT_LIMITS} from './ocean-flyover-lib.js';

const frame=(w,h,fn)=>{const d=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const [r,g,b]=fn(x,y);d.set([r,g,b,255],(y*w+x)*4);}return d;};

test('route is dense at the shore and near the end, sparse between, and stops short',()=>{
  const r=flyoverRoute([0,0],[30000,0],{coast:150,coastSpan:3000,open:450,near:250,nearSpan:6000,stopShort:1500});
  assert.equal(r[0].d,0);assert.equal(r.at(-1).d,28500);
  const gaps=r.slice(1).map((p,i)=>p.d-r[i].d);
  assert.equal(gaps[0],150);assert.equal(gaps[10],150);
  assert.ok(gaps.includes(450));assert.equal(gaps.at(-2),250);
  assert.ok(r.length>80&&r.length<130);
  assert.ok(r.every(p=>p.z===0));
});

test('route points lie on the straight line',()=>{
  const r=flyoverRoute([10,20],[10,3020],{stopShort:0});
  assert.ok(r.every(p=>p.x===10&&Math.abs(p.z-20-p.d)<1e-9));
  assert.equal(r.at(-1).d,3000);
});

test('analyseFrame: plain water frame is clean',()=>{
  const m=analyseFrame(frame(200,100,()=>[20,90,110]),200,100);
  assert.equal(m.pink,0);assert.equal(m.black,0);assert.equal(m.sparklesPerMpx,0);
  assert.ok(m.rowStep<1&&m.colStep<1);
});

test('analyseFrame finds magenta and black holes',()=>{
  const m=analyseFrame(frame(200,100,(x,y)=>x>80&&x<100&&y>50&&y<70?[255,0,255]:x>120&&x<130&&y>50&&y<70?[0,0,0]:[20,90,110]),200,100);
  assert.ok(m.pink>.01);assert.ok(m.black>.005);
});

test('analyseFrame finds a seam band and an isolated sparkle',()=>{
  const seam=analyseFrame(frame(200,100,(x,y)=>y<65?[20,90,110]:[120,190,210]),200,100);
  assert.ok(seam.rowStep>50);assert.ok(Math.abs(seam.rowAt-65)<=4);
  const side=analyseFrame(frame(200,100,x=>x<100?[20,90,110]:[120,190,210]),200,100);
  assert.ok(side.colStep>40);
  const sp=analyseFrame(frame(200,100,(x,y)=>x===100&&y===60?[255,255,255]:[20,90,110]),200,100);
  assert.ok(sp.sparklesPerMpx>0);
});

test('analyseFrame ignores the HUD corners',()=>{
  const m=analyseFrame(frame(200,100,(x,y)=>x<20&&y>90?[255,0,255]:[20,90,110]),200,100);
  assert.equal(m.pink,0);
});

const stats=(mean,o={})=>({mean,pink:0,black:0,sparklesPerMpx:0,rowStep:1,rowAt:0,colStep:1,colAt:0,...o});

test('checkRows passes a smooth sequence and flags each glitch kind',()=>{
  const ok=[0,1,2].map(i=>({i,d:i*100,variant:'high',stats:stats([10+i,80,100]),repeat:stats([11+i,80,100])}));
  assert.deepEqual(checkRows(ok),[]);
  const bad=[{i:0,d:0,variant:'a',stats:stats([10,80,100])},
    {i:1,d:100,variant:'a',stats:stats([60,80,100],{pink:.01,black:.05,sparklesPerMpx:50000,rowStep:90}),repeat:stats([10,80,100])}];
  const f=checkRows(bad).join('\n');
  for(const w of ['magenta','black','bright','row luma','colour step','flicker'])assert.match(f,new RegExp(w));
});

test('checkRows compares colour steps only within a variant',()=>{
  const rows=[{i:0,d:0,variant:'a',stats:stats([10,80,100])},{i:0,d:0,variant:'b',stats:stats([200,80,100])},{i:1,d:50,variant:'a',stats:stats([12,80,100])}];
  assert.deepEqual(checkRows(rows),[]);
  assert.equal(colourStep([0,0,0],[3,9,1]),9);assert.ok(DEFAULT_LIMITS.maxStep>0);
});
