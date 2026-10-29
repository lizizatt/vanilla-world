import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {launchAsset,LAUNCH} from './pod-launch.js';
import {launchProps} from './launch-kit.js';

const sha=a=>createHash('sha1').update(Buffer.from(a.vertices.buffer)).update(Buffer.from(a.indices.buffer)).digest('hex').slice(0,16);
const PINS={15:'d125effe94fa246d',25:'9d97cfde6bd76048',45:'70f74e1e5f4ec06b',90:'e211fe7c60134483',pickup:'46a3d109a3f0ecd7'};
const tex=k=>({key:k,width:1,height:1,rgba:new Uint8Array(4)});
const kit={tex:{stone:tex('stone'),metal:tex('metal')},brazier:{asset:{vertices:new Float32Array(12),indices:new Uint32Array(3),batches:[]},textures:[],k:.01}};
const obj=a=>a?{kind:'ramp',angle:a,pos:[10,5,20],yaw:.7}:{kind:'pickup',pos:[10,5,20],yaw:0};

test('procedural contact/visual geometry is unchanged for every angle and the pickup',()=>{
  for(const [k,h] of Object.entries(PINS))assert.equal(sha(launchAsset(obj(k==='pickup'?0:+k))),h,k);
});

test('without the local kit the procedural asset is used',()=>{
  for(const a of [15,25,45,90]){const p=launchProps(obj(a),undefined);assert.equal(p.length,1);assert.equal(sha(p[0].asset),PINS[a]);}
});

test('kitbashed ramps render at all four angles and their driving surface is the contact curve',()=>{
  for(const a of [15,25,45,90]){
    const props=launchProps(obj(a),kit),m=props[0].asset;
    assert.equal(props.length,3);
    assert.ok(m.vertices.every(Number.isFinite)&&m.indices.length>0);
    const surf=m.batches[0],end=m.vertices.subarray(0,12*4*24);
    for(let i=0;i<m.vertices.length/12&&i<4*24;i++){
      const y=m.vertices[i*12+1],z=m.vertices[i*12+2],ang=Math.asin(-z/LAUNCH.radius);
      assert.ok(Math.abs(y-LAUNCH.radius*(1-Math.cos(ang)))<1e-3,`surface vertex ${i} off the contact curve at ${a}`);
    }
    assert.equal(surf.texture,'stone');
    const hi=Math.max(...Array.from({length:m.vertices.length/12},(_,i)=>m.vertices[i*12+1]));
    assert.ok(Math.abs(hi-LAUNCH.radius*(1-Math.cos(a*Math.PI/180)))<1e-3);
    assert.ok(end.length>0);
  }
  const p=launchProps(obj(0),kit);assert.equal(p.length,1);assert.equal(p[0].asset.batches[0].texture,'metal');
});
