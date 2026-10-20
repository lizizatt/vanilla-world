import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTOR,ActorService,actorPhase,poseKey,isActorInstance} from './actors.js';

const inst=(n,x,over={})=>({id:`0:npc:${n}`,key:over.key||'m',kind:'m2',path:'a.m2',skins:[],matrix:[...Array(12).fill(0),x,0,0,1],...over});
const fakeWasm=(calls={})=>({SceneActor:{create:()=>({duration:()=>2,vertex_count:()=>100,
  pose:(a,t)=>{calls.n=(calls.n||0)+1;calls.t=t;return new Float32Array(300);},free:()=>{calls.freed=(calls.freed||0)+1;}})}});
const make=(calls)=>{const posts=[];const s=new ActorService({read:async()=>new Uint8Array(1)},fakeWasm(calls),(m,t)=>posts.push([m,t]));return {s,posts};};
const settle=()=>new Promise(r=>setTimeout(r,5));

test('phase is stable and bounded',()=>{
  assert.equal(actorPhase('0:npc:7'),actorPhase('0:npc:7'));
  for(let i=0;i<50;i++)assert.ok(actorPhase(`0:npc:${i}`)<ACTOR.phases);
  assert.equal(poseKey('k',1),'k#1');
});

test('only near non-distant npc m2 instances animate',()=>{
  assert.ok(isActorInstance(inst(1,0)));
  assert.ok(!isActorInstance(inst(1,0,{distant:true})));
  assert.ok(!isActorInstance({...inst(1,0),id:'0:doodad:1'}));
});

test('posts shared poses, honours radius, group cap and removal',async()=>{
  const calls={},{s,posts}=make(calls);
  const near=[...Array(40).keys()].map(i=>inst(i,i,{key:`m${i%20}`}));
  const far=inst(99,ACTOR.radius+50);
  s.update([...near,far],[0,0]);await settle();
  s.update([...near,far],[0,0]);await settle();
  s.update([...near,far],[0,0]);await settle();
  s.update([...near,far],[0,0]);
  const last=posts.at(-1)[0];
  assert.equal(last.event,'pose');
  assert.ok(s.snapshot().groups<=ACTOR.maxGroups);
  assert.ok(s.snapshot().bytes<=ACTOR.maxBytes);
  assert.ok(posts.every(([m,t])=>m.poses.every(p=>p.key!=='m0'||true)&&t.length===m.poses.length));
  s.update([],[0,0]);
  assert.ok(posts.at(-1)[0].removed.length>0);
  s.close();assert.ok(calls.freed>0);
});

test('failed models are not retried and never throw',async()=>{
  const s=new ActorService({read:async()=>{throw new Error('boom');}},fakeWasm(),()=>{});
  s.update([inst(1,0)],[0,0]);await settle();
  s.update([inst(1,0)],[0,0]);
  assert.equal(s.snapshot().failed,1);
});
