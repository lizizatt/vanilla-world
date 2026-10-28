import test from 'node:test';
import assert from 'node:assert/strict';
import {INTAKE_TEXTURES,textureAddress,intakeIslands,advanceIntake,writeIntakeMatrix} from './intakes.js';
import fs from 'node:fs';
import path from 'node:path';
import {findLev} from './cli.mjs';
import {loadPodModel,podSkinList,toCraft} from './skin.js';
import {meshTexture} from './pod.js';

test('N64 addressing mirrors quarter fan art rather than repeating four quadrants',()=>{
  assert.deepEqual(textureAddress(0x11),{addressU:'mirror-repeat',addressV:'mirror-repeat'});
  assert.deepEqual(textureAddress(0x02),{addressU:'repeat',addressV:'clamp-to-edge'});
  assert.deepEqual(textureAddress(0x20),{addressU:'clamp-to-edge',addressV:'repeat'});
  assert.deepEqual(textureAddress(0),{addressU:'repeat',addressV:'repeat'});
  for(const fixed of [117,381,578])assert.equal(INTAKE_TEXTURES.has(fixed),false);
});

test('material addressing comes from its own texture child, not its shared image index',()=>{
  const body=new Uint8Array(160),dv=new DataView(body.buffer);
  dv.setUint32(16+8,48);dv.setUint32(48+0x1c,112);dv.setUint32(48+0x38,198);
  body[115]=0x11;
  assert.equal(meshTexture(body,{matPtr:16}).addressU,'mirror-repeat');
  body[115]=0x20;
  assert.equal(meshTexture(body,{matPtr:16}).addressU,'clamp-to-edge');
});

test('fan pivots use the same handedness and ground offset as craft vertices',()=>{
  const asset={vertices:new Float32Array([2,10,7,0,1,0,0,0,1,1,1,1]),batches:[{intake:[2,10,7]}]};
  toCraft(asset,{lo:[0,0,3]},1);
  assert.deepEqual(asset.batches[0].intake,[10,-2,4]);
  assert.deepEqual([...asset.vertices.subarray(0,3)],asset.batches[0].intake);
});

test('disconnected fans get separate pivots, while a sculpted hub stays static',()=>{
  const card=x=>[{P:[[x,10,0],[x+2,10,0],[x,10,2]]},{P:[[x+2,10,0],[x+2,10,2],[x,10,2]]}];
  const parts=intakeIslands([...card(-5),...card(3),{P:[[0,0,0],[2,4,0],[0,4,2]]}]);
  assert.equal(parts.length,3);
  assert.deepEqual(parts.map(p=>p.pivot),[[-4,10,1],[4,10,1],null]);
});

test('idle spin, throttle and speed response remain bounded and frame-rate independent',()=>{
  const idle=advanceIntake(0,.01,0,0);
  assert.ok(idle>0);
  assert.ok(advanceIntake(0,.01,1,0)>idle);
  assert.equal(advanceIntake(0,.01,0,150),advanceIntake(0,.01,1,0));
  assert.equal(advanceIntake(1,NaN,1,0),1);
  assert.equal(advanceIntake(1,-1,1,0),1);
  assert.equal(advanceIntake(0,5,1,0),advanceIntake(0,.1,1,0));
  assert.equal(advanceIntake(0,.01,NaN,Infinity),idle);
  let a=0,b=0;
  for(let i=0;i<60;i++)a=advanceIntake(a,1/60,.5,20);
  for(let i=0;i<120;i++)b=advanceIntake(b,1/120,.5,20);
  assert.ok(Math.abs(a-b)<1e-10);
});

test('in-place rotor matrix preserves pivot and intake axis under the craft transform',()=>{
  const m=new Float32Array([0,0,-2,0, 0,2,0,0, 2,0,0,0, 10,20,30,1]);
  const pivot=[4,5,6],out=new Float32Array(24).fill(99);
  writeIntakeMatrix(out,4,m,pivot,Math.PI/2);
  const point=(matrix,offset,p)=>[0,1,2].map(r=>matrix[offset+r]*p[0]+matrix[offset+4+r]*p[1]+matrix[offset+8+r]*p[2]+matrix[offset+12+r]);
  assert.deepEqual(point(out,4,pivot),point(m,0,pivot));
  assert.deepEqual(point(out,4,[5,5,6]),point(m,0,[5,5,6]));
  assert.deepEqual(point(out,4,[4,6,6]),point(m,0,[4,5,7]));
  assert.equal(out[0],99);assert.equal(out[23],99);
});

test('real install: all 25 pods preserve independent fan parts and original sampler modes',
  {skip:!process.env.SWE1R_DATA&&'SWE1R_DATA not set'},async()=>{
    const lev=findLev(process.env.SWE1R_DATA),reader={read:async name=>new Uint8Array(fs.readFileSync(path.join(lev,name)))};
    const counts=[0,2,2,2,0,4,4,2,2,0,0,0,2,2,0,0,2,2,0,4,0,2,0,0,0];
    const skins=podSkinList();assert.equal(skins.length,counts.length);
    for(let i=0;i<skins.length;i++){
      const {asset}=await loadPodModel(reader,skins[i]);
      const rotors=asset.batches.filter(b=>b.intake);
      assert.equal(rotors.length,counts[i],skins[i].name);
      for(const b of rotors){
        assert.ok(b.intake.every(Number.isFinite));
        assert.ok(b.intake[0]>0,'intake is on an engine ahead of cockpit');
        assert.ok(b.indexCount>0&&b.firstIndex+b.indexCount<=asset.indices.length);
      }
      if([257,259,267].includes(Number(skins[i].id.slice(6))))assert.ok(
        rotors.every(b=>b.addressU==='mirror-repeat'&&b.addressV==='mirror-repeat'),skins[i].name);
      for(const b of asset.batches.filter(b=>b.beam))assert.equal(b.intake,undefined);
    }
  });
