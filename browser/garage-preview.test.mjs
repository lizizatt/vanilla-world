import test from 'node:test';
import assert from 'node:assert/strict';
import {modelBounds,previewCamera,drawOrder,GaragePreview} from './garage-preview.js';

const verts=Float32Array.from([0,0,0,0,0,1,0,0,1,1,1,1, 4,2,2,0,0,1,0,0,1,1,1,1]);

test('modelBounds centres and sizes the model; empty falls back', () => {
  const b=modelBounds(verts);
  assert.deepEqual(b.center,[2,1,1]);
  assert.ok(Math.abs(b.radius-Math.hypot(4,2,2)/2)<1e-9);
  assert.deepEqual(modelBounds(new Float32Array(0)),{center:[0,0,0],radius:1});
});

test('previewCamera keeps the centre in view at any azimuth', () => {
  const b=modelBounds(verts);
  for(const az of [0,1,3,-2]){
    const {mvp,light}=previewCamera(b,az,1.5);
    assert.ok([...mvp].every(Number.isFinite));
    const [x,y,z]=b.center,w=mvp[3]*x+mvp[7]*y+mvp[11]*z+mvp[15];
    const nx=(mvp[0]*x+mvp[4]*y+mvp[8]*z+mvp[12])/w,ny=(mvp[1]*x+mvp[5]*y+mvp[9]*z+mvp[13])/w;
    assert.ok(Math.abs(nx)<1e-4&&Math.abs(ny)<1e-4);
    assert.ok(Math.abs(Math.hypot(...light)-1)<1e-6);
  }
});

test('drawOrder puts opaque first, blended after, and skips beams', () => {
  const o=drawOrder([{id:1,blend:'add'},{id:2},{id:3,beam:true},{id:4,blend:'alpha'},{id:5,blend:'opaque'}]);
  assert.deepEqual(o.map(b=>b.id),[2,5,1,4]);
});

test('GaragePreview frees every GPU object once and stops its loop', () => {
  const calls=[],gl=new Proxy({},{get:(_,k)=>k==='getShaderParameter'||k==='getProgramParameter'?()=>true:k==='getExtension'?()=>({loseContext:()=>calls.push('lose')}):k===k.toUpperCase()?1:(...a)=>{calls.push(k);return {};}});
  const canvas={clientWidth:100,clientHeight:50,getContext:()=>gl,setAttribute(){},addEventListener(){},removeEventListener(){},remove:()=>calls.push('remove')};
  const host={replaceChildren(){}};
  let cancelled=0;
  const payload={asset:{vertices:verts,indices:new Uint32Array([0,1,0]),batches:[{firstIndex:0,indexCount:3}]},textures:[]};
  const p=new GaragePreview(host,payload,{doc:{createElement:()=>canvas},raf:()=>7,caf:()=>cancelled++,now:()=>0});
  p.dispose();p.dispose();
  assert.equal(cancelled,1);
  for(const k of ['deleteBuffer','deleteVertexArray','deleteProgram','lose','remove'])assert.ok(calls.includes(k),k);
  assert.equal(calls.filter(k=>k==='remove').length,1);
});

test('GaragePreview throws when WebGL2 is missing', () => {
  const canvas={setAttribute(){},getContext:()=>null};
  assert.throws(()=>new GaragePreview({},{asset:{vertices:verts,batches:[]},textures:[]},{doc:{createElement:()=>canvas},raf:()=>0,caf:()=>{},now:()=>0}),/WebGL2/);
});
