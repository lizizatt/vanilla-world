import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseModel,modelHeader,applyMat} from './model.js';
import {loadPodModel,loadPartModel,podSkinList,podPair} from './skin.js';
import {readBlock} from './block.js';
import {POD_POSES} from './poses.js';
import {assemblePod,tetherMatrix} from './assembly.js';
import {INTAKE_TEXTURES} from './intakes.js';
import {meshTexture,usesTexel,buildPod,decodeTexture,decodeTriangles} from './pod.js';

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

test('pair indices use exact early names and only apply drift to late names',()=>{
  const pair=name=>podPair(podSkinList().find(s=>s.name===name).index);
  assert.deepEqual(pair('Anakin Skywalker'),{pod:2,alternate:0});
  assert.deepEqual(pair('Sebulba'),{pod:6,alternate:5});
  assert.deepEqual(pair('Ben Quadinaros'),{pod:40,alternate:39});
  assert.deepEqual(pair('Neva Kee'),{pod:30,alternate:29});
  assert.deepEqual(pair('Jinn Reeso'),{pod:299,alternate:298});
  assert.equal(podPair(309),null);
  assert.equal(Object.keys(POD_POSES).length,podSkinList().length);
  for(const skin of podSkinList())assert.ok(POD_POSES[skin.index]);
});

test('tether transforms keep both endpoints attached, including vertical runs',()=>{
  for(const [a,b] of [[[120,300,10],[-40,-100,60]],[[0,0,10],[0,0,-10]]]){
    const matrix=tetherMatrix(a,b);
    for(const [p,want] of [[[5,0,5],a],[[5,-100,5],b]])
      assert.ok(Math.hypot(...applyMat(matrix,...p).map((v,i)=>v-want[i]))<1e-10);
    assert.ok(matrix.every(Number.isFinite));
  }
  assert.throws(()=>tetherMatrix([0,0,0],[0,0,0]),/zero length/);
});

test('real data: assembled pods exclude deflected header-root flaps but keep fans',
  {skip:!process.env.SWE1R_DATA},()=>{
    const models=readBlock(fs.readFileSync(path.join(process.env.SWE1R_DATA,'lev01','out_modelblock.bin')),'model');
    for(const skin of podSkinList()){
      const pair=podPair(skin.index),[mask,body]=models[pair.pod],alt=models[pair.alternate][1];
      const meshes=assemblePod(body,mask,alt,POD_POSES[skin.index]);
      const nested=meshes.filter(m=>m.chain?.some(c=>c.header));
      assert.ok(nested.every(m=>INTAKE_TEXTURES.has(meshTexture(m.body,m)?.index)),skin.name);
    }
    const sebulba=podSkinList().find(s=>s.name==='Sebulba'),pair=podPair(sebulba.index);
    const all=parseModel(models[pair.alternate][1],null,{finest:true,visibleOnly:true,root:modelHeader(models[pair.alternate][1]).alt[0]}).meshes;
    assert.ok(all.filter(m=>m.chain.some(c=>c.header)).length>=2);
  });
test('real data: all default payloads use only paired source geometry and fixed attachment/exhaust anchors',
  {skip:!process.env.SWE1R_DATA},async()=>{
    const root=path.join(process.env.SWE1R_DATA,'lev01');
    const reader={read:async name=>fs.readFileSync(path.join(root,name))};
    for(const skin of podSkinList()){
      const after=await loadPodModel(reader,skin),pose=POD_POSES[skin.index];
      assert.equal(after.assembly,'paired',skin.name);
      assert.ok(after.asset.indices.length>0,skin.name);
      assert.ok(after.asset.vertices.every(Number.isFinite));
      assert.deepEqual(after.metadata.exhausts,pose.exhausts);
      assert.deepEqual(after.metadata.posedAttachment0.position,[0,0,pose.top]);
      assert.deepEqual(after.asset.batches.filter(b=>b.intake).map(b=>b.intake).sort(),[...(pose.fans??[])].sort());
      const models=readBlock(await reader.read('out_modelblock.bin'),'model'),pair=podPair(skin.index);
      const [mask,body]=models[pair.pod],alternate=models[pair.alternate][1];
      const meshes=assemblePod(body,mask,alternate,pose);
      assert.ok(meshes.every(m=>m.body===body||m.body===alternate||m.texture?.index===815));
      assert.equal(after.asset.batches.some(b=>b.beam),pose.binder!==false);
    }
    const corrupt=Buffer.from(await reader.read('out_modelblock.bin'));
    readBlock(corrupt,'model')[0][1].fill(0,0,4);
    const bad={read:async name=>name==='out_modelblock.bin'?corrupt:reader.read(name)};
    const skin=podSkinList().find(s=>s.name==='Anakin Skywalker');
    await assert.rejects(loadPodModel(bad,skin),/invalid Podd/);
    // Historical skin IDs are retained, but their old model entries are never read.
    const removed=Buffer.from(await reader.read('out_modelblock.bin'));
    const items=readBlock(removed,'model');
    for(const s of podSkinList())items[s.index][1].fill(0);
    const noLegacy={read:async name=>name==='out_modelblock.bin'?removed:reader.read(name)};
    for(const s of podSkinList())assert.equal((await loadPodModel(noLegacy,s)).assembly,'paired');
    assert.ok((await loadPartModel(reader,309)).asset.indices.length>0);
    await assert.rejects(loadPartModel(reader,skin.index),/not a scenery part/);
  });

test('real data: no pod face is untextured or flat gray unless its material is shade-only',
  {skip:!process.env.SWE1R_DATA},()=>{
    const dir=path.join(process.env.SWE1R_DATA,'lev01');
    const models=readBlock(fs.readFileSync(path.join(dir,'out_modelblock.bin')),'model');
    const textures=readBlock(fs.readFileSync(path.join(dir,'out_textureblock.bin')),'texture');
    const texture=t=>{try{return decodeTexture(textures[t.index],t);}catch{return null;}};
    for(const skin of podSkinList()){
      const pair=podPair(skin.index),[mask,body]=models[pair.pod],alt=models[pair.alternate][1];
      const meshes=assemblePod(body,mask,alt,POD_POSES[skin.index]);
      let shadeOnly=0;
      for(const m of meshes){
        const src=m.body??body,t=m.texture??meshTexture(src,m);
        if(t){assert.ok(texture(t),skin.name+' texture '+t.index+' does not decode');continue;}
        if(usesTexel(src,m))continue;
        shadeOnly+=decodeTriangles(src,m).length*3;
      }
      const {asset}=buildPod(body,mask,{meshes,texture});
      let white=0;
      for(const b of asset.batches.filter(b=>!b.texture))
        for(let i=b.firstIndex;i<b.firstIndex+b.indexCount;i++){
          const o=asset.indices[i]*12;
          if(asset.vertices[o+8]===1&&asset.vertices[o+9]===1&&asset.vertices[o+10]===1)white++;
        }
      assert.equal(white,shadeOnly,skin.name);
    }
  });
