import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseModel,modelHeader} from './model.js';
import {loadPodModel,podSkinList,podPair,FULL_PODS_DEFAULT} from './skin.js';
import {readBlock} from './block.js';
import {exhaustPoints} from '../particles.js';

function fixture(tag) {
  const body=new Uint8Array(0x600),dv=new DataView(body.buffer);
  const u=(o,v)=>dv.setUint32(o,v);
  body.set([...tag].map(c=>c.charCodeAt(0)));
  u(4,tag==='Podd'?0x80:0);u(8,0xffffffff);
  u(12,0x416c744e);u(16,tag==='Podd'?0x280:0x100);u(20,0);u(24,0x48456e64);
  const node=(o,type,kids,children)=>{
    u(o,type);u(o+4,0xffffffff);u(o+20,children.length);u(o+24,kids);
    children.forEach((v,i)=>u(kids+i*4,v));
  };
  const mesh=o=>{u(o+0x30,0x500);u(o+0x34,0x520);dv.setInt16(o+0x3a,1);};
  if(tag==='Podd'){
    node(0x80,0x5064,0xa0,[0x100,0x180]);
    for(const [o,kids,x] of [[0x100,0x150,10],[0x180,0x1d0,20]]){
      node(o,0xd064,kids,[0x200]);
      [1,0,0,0,1,0,0,0,1,x,0,0].forEach((v,i)=>dv.setFloat32(o+28+i*4,v));
    }
    node(0x200,0x5066,0x280,[0,0x300]);
    node(0x300,0x3064,0x33c,[0x380]);mesh(0x380);
  } else {
    node(0x100,0x3064,0x13c,[0x200]);mesh(0x200);
  }
  return {body,dv,u,node};
}

test('paired AltN substitutes child slots, retains shared instances and never adds every root/LOD',()=>{
  const a=fixture('Podd'),b=fixture('MAlt');
  const meshes=parseModel(a.body,null,{alternate:b.body,finest:true}).meshes;
  assert.equal(meshes.length,2);
  assert.ok(meshes.every(m=>m.body===b.body&&m.off===0x200));
  assert.deepEqual(meshes.map(m=>m.matrix[3]),[10,20]);
  assert.equal(parseModel(b.body,null).meshes.length,0);
  assert.equal(parseModel(a.body,null,{finest:true}).meshes.length,2);
  assert.equal(parseModel(a.body,null).meshes.length,0);
});

test('finest drawable branch skips a skeleton-only slot without summing lower branches',()=>{
  const a=fixture('Podd'),b=fixture('MAlt');
  b.node(0x100,0x5064,0,[]);
  const meshes=parseModel(a.body,null,{alternate:b.body,finest:true}).meshes;
  assert.equal(meshes.length,2);
  assert.ok(meshes.every(m=>m.body===a.body&&m.off===0x380));
});

test('cycle detection is path-local, and pivot transform rotates around its authored center',()=>{
  const a=fixture('Podd');
  a.u(0x284,0x80);
  assert.deepEqual(parseModel(a.body,null,{finest:true}).meshes,[]);
  const b=fixture('MAlt');
  b.u(4,0x300);
  b.node(0x300,0xd065,0x358,[0x100]);
  b.dv.setInt16(0x30c,0x10);
  [-1,0,0,0,1,0,0,0,1,0,0,0].forEach((v,i)=>b.dv.setFloat32(0x31c+i*4,v));
  b.dv.setFloat32(0x34c,5);
  assert.equal(parseModel(b.body,null).meshes[0].matrix[3],10);
});

test('headers skip counted Data and terminated Anim, reject truncation and wrong pair tags',()=>{
  const a=fixture('Podd'),b=fixture('MAlt');
  assert.deepEqual(modelHeader(a.body),{roots:[0x80],alt:[0x280]});
  assert.throws(()=>modelHeader(a.body.subarray(0,20)),/truncated/);
  b.body.set([80,97,114,116]);
  assert.throws(()=>parseModel(a.body,null,{alternate:b.body}),/invalid/);
  const c=fixture('Podd');
  c.u(12,0x44617461);c.u(16,2);c.u(20,123);c.u(24,456);
  c.u(28,0x416e696d);c.u(32,0x100);c.u(36,0);c.u(40,0x48456e64);
  assert.deepEqual(modelHeader(c.body),{roots:[0x80],alt:[]});
});

test('pair indices use exact early names and only apply drift to late names; default stays gated',()=>{
  const pair=name=>podPair(podSkinList().find(s=>s.name===name).index);
  assert.deepEqual(pair('Anakin Skywalker'),{pod:2,alternate:0});
  assert.deepEqual(pair('Sebulba'),{pod:6,alternate:5});
  assert.deepEqual(pair('Ben Quadinaros'),{pod:40,alternate:39});
  assert.deepEqual(pair('Neva Kee'),{pod:30,alternate:29});
  assert.deepEqual(pair('Jinn Reeso'),{pod:299,alternate:298});
  assert.equal(podPair(309),null);
  assert.equal(FULL_PODS_DEFAULT,false);
});

test('real data: all paired payloads render more detail without moving anchors, fans or exhausts; corrupt pair falls back',
  {skip:!process.env.SWE1R_DATA},async()=>{
    const root=path.join(process.env.SWE1R_DATA,'lev01');
    const reader={read:async name=>fs.readFileSync(path.join(root,name))};
    for(const skin of podSkinList()){
      const before=await loadPodModel(reader,skin,{full:false}),after=await loadPodModel(reader,skin,{full:true});
      assert.equal(after.assembly,'paired',`${skin.name}: ${after.fallback}`);
      assert.ok(after.asset.indices.length>before.asset.indices.length,skin.name);
      assert.ok(after.asset.vertices.every(Number.isFinite));
      assert.deepEqual(after.metadata,before.metadata);
      assert.deepEqual(after.metadata.exhausts,exhaustPoints(before.asset.vertices,before.asset.indices));
      const fans=p=>p.asset.batches.filter(b=>b.intake).map(b=>({at:b.intake,texture:b.texture,u:b.addressU,v:b.addressV}));
      assert.deepEqual(fans(after),fans(before),skin.name);
      const glow=p=>p.asset.batches.filter(b=>b.texture==='swe1r\\117').flatMap(b=>Array.from(p.asset.vertices.slice(b.firstIndex*12,(b.firstIndex+b.indexCount)*12)));
      assert.deepEqual(glow(after),glow(before),skin.name);
    }
    const corrupt=Buffer.from(await reader.read('out_modelblock.bin'));
    readBlock(corrupt,'model')[0][1].fill(0,0,4);
    const bad={read:async name=>name==='out_modelblock.bin'?corrupt:reader.read(name)};
    const skin=podSkinList().find(s=>s.name==='Anakin Skywalker');
    const fallback=await loadPodModel(bad,skin,{full:true});
    assert.equal(fallback.assembly,'lod1');
    assert.match(fallback.fallback,/invalid Podd/);
    assert.deepEqual(fallback.asset,(await loadPodModel(reader,skin,{full:false})).asset);
  });
