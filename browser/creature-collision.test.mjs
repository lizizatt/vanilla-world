import test from 'node:test';
import assert from 'node:assert/strict';
import {CreatureCollision,CREATURE_COLLISION as C,segmentDistance2,sweptOverlap,deathPoseTime} from './creature-collision.js';
import {ActorService} from './actors.js';
import {ParticlePool,emitGib} from './particles.js';

const npc=(n,x,y,z=0,over={})=>({id:`0:npc:${n}`,key:'m',kind:'m2',path:'creature\\wolf\\wolf.m2',skins:[],matrix:[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1],...over});
const noPos=()=>undefined,size=()=>[.6,1.2],cls=()=>'creature',dur=()=>2;
const isNpc=i=>i.id.includes(':npc:');
const fresh=(rand=()=>0.99,cfg)=>new CreatureCollision(rand,cfg);
const run=(cc,list,from,to,t0=0,dt=.04)=>{cc.update(list,isNpc,...from,t0,noPos,size,cls,dur);return cc.update(list,isNpc,...to,t0+dt,noPos,size,cls,dur);};

test('segment distance and swept overlap catch tunnelling between ticks',()=>{
  assert.equal(segmentDistance2(0,0,10,0,5,3),9);
  assert.equal(segmentDistance2(0,0,0,0,3,4),25);
  // creature at x=50 sits between two samples 100 yd apart
  assert.ok(sweptOverlap(0,0,0,100,0,0,C.craftRadius,C.craftHalfHeight,50,1,0,.5,1));
  assert.ok(!sweptOverlap(0,0,0,100,0,0,C.craftRadius,C.craftHalfHeight,50,9,0,.5,1));
  // flying well above the creature misses, hovering at its height hits
  assert.ok(!sweptOverlap(0,0,30,100,0,30,C.craftRadius,C.craftHalfHeight,50,0,0,.5,1));
  assert.ok(sweptOverlap(0,0,1,100,0,1,C.craftRadius,C.craftHalfHeight,50,0,0,.5,1));
});

test('speed threshold: slow craft never kills, fast craft does',()=>{
  const list=[npc(1,10,0)];
  assert.equal(run(fresh(),list,[0,0,0],[.5,0,0]).length,0);
  const ev=run(fresh(),list,[0,0,0],[20,0,0]); // 500 yd/s
  assert.equal(ev.length,1);assert.equal(ev[0].id,list[0].id);
});

test('first sample only primes the swept segment; a teleport gap does not sweep',()=>{
  const cc=fresh(),list=[npc(1,50,0)];
  assert.equal(cc.update(list,isNpc,0,0,0,0,noPos,size,cls,dur).length,0);
  assert.equal(cc.update(list,isNpc,100,0,0,5,noPos,size,cls,dur).length,0); // 5 s gap resets
  assert.equal(cc.update(list,isNpc,200,0,0,5.04,noPos,size,cls,dur).length,0);
});

test('disabled setting, wrong class and large creatures are ignored',()=>{
  const list=[npc(1,10,0)],off=fresh();off.enabled=false;
  assert.equal(run(off,list,[0,0,0],[20,0,0]).length,0);
  const a=fresh();a.update(list,isNpc,0,0,0,0,noPos,size,()=>undefined,dur);
  assert.equal(a.update(list,isNpc,20,0,0,.04,noPos,size,()=>undefined,dur).length,0);
  const b=fresh();b.update(list,isNpc,0,0,0,0,noPos,()=>[C.maxCreatureRadius+1,2],cls,dur);
  assert.equal(b.update(list,isNpc,20,0,0,.04,noPos,()=>[C.maxCreatureRadius+1,2],cls,dur).length,0);
  const c=fresh();c.update(list,isNpc,0,0,0,0,noPos,()=>undefined,cls,dur);
  assert.equal(c.update(list,isNpc,20,0,0,.04,noPos,()=>undefined,cls,dur).length,0,'unknown size is skipped');
});

test('gib probability gate: seeded rolls, doubled above gibSpeed, forced when no Death clip',()=>{
  const lo=fresh(()=>C.gibChance*1.5);// above chance, below doubled chance
  assert.equal(lo.gibRoll(C.minSpeed+1),false);
  assert.equal(lo.gibRoll(C.gibSpeed),true);
  assert.equal(fresh(()=>0).gibRoll(C.minSpeed),true);
  assert.equal(fresh(()=>.999).gibRoll(C.gibSpeed),false);
  const cc=fresh(()=>.99),list=[npc(1,10,0)];
  cc.update(list,isNpc,0,0,0,0,noPos,size,cls,()=>0);
  const ev=cc.update(list,isNpc,20,0,0,.04,noPos,size,cls,()=>0);
  assert.equal(ev[0].gib,true);assert.equal(cc.states.get(list[0].id).state,'gone');
});

test('Death state machine: dying -> dead (held) -> gone -> respawn; gibs skip to gone',()=>{
  const cc=fresh(),list=[npc(1,10,0)],id=list[0].id;
  run(cc,list,[0,0,0],[20,0,0],0);
  assert.equal(cc.states.get(id).state,'dying');assert.ok(!cc.isAlive(id));
  cc.advance(1.9);assert.equal(cc.states.get(id).state,'dying');
  cc.advance(2.1);assert.equal(cc.states.get(id).state,'dead');
  cc.advance(2.04+C.corpseSeconds-1);assert.equal(cc.states.get(id).state,'dead');
  cc.advance(2.04+C.corpseSeconds+.1);assert.equal(cc.states.get(id).state,'gone');
  const goneAt=cc.states.get(id).goneAt;
  cc.advance(goneAt+C.respawnSeconds-1);assert.ok(cc.states.has(id));
  cc.advance(goneAt+C.respawnSeconds+.1);assert.ok(cc.isAlive(id));
  // a dead creature is never killed again, a respawned one can be
  const g=fresh(()=>0);run(g,list,[0,0,0],[20,0,0],0);assert.equal(g.states.get(id).state,'gone');
  assert.equal(run(g,list,[0,0,0],[20,0,0],.5).length,0);
});

test('rate limits: kills per second and simultaneous dying are capped',()=>{
  const list=[...Array(40).keys()].map(i=>npc(i,10+i*.01,0));
  const cc=fresh(()=>.99);
  const ev=run(cc,list,[0,0,0],[100,0,0]);
  assert.equal(ev.length,Math.min(C.maxKillsPerSecond,C.maxDying));
  assert.equal(run(cc,list,[0,0,0],[100,0,0],.5).length,0,'window and dying cap still full');
});

test('deathPoseTime plays once and holds the last frame',()=>{
  assert.equal(deathPoseTime(-1,2),0);
  assert.equal(deathPoseTime(1,2),1);
  assert.ok(deathPoseTime(50,2)<2&&deathPoseTime(50,2)>1.99);
  assert.equal(deathPoseTime(1,0),0);
});

test('no allocations per tick when nothing is hit (npc list cached per snapshot)',()=>{
  const cc=fresh(),list=[npc(1,500,0)];
  cc.update(list,isNpc,0,0,0,0,noPos,size,cls,dur);
  let calls=0;const filter=i=>{calls++;return isNpc(i);};
  for(let k=1;k<50;k++)cc.update(list,filter,k*2,0,0,k*.04,noPos,size,cls,dur);
  assert.equal(calls,list.length,'filter ran once for the snapshot');
});

const bounds=[[-.4,-.3,0],[.4,.3,1.2]];
const mkService=()=>{
  const posted=[],poseCalls=[];
  const wasm={SceneActor:{create:()=>({duration:a=>a===1?2:a===0?3:0,vertex_count:()=>10,move_speed:()=>0,
    pose:(a,t)=>{poseCalls.push([a,t]);return new Float32Array(30);},free(){}})}};
  const s=new ActorService({read:async()=>new Uint8Array(1)},wasm,(m,t)=>posted.push(m));
  let clock=0;s.now=()=>clock;s.cc.rand=()=>.99;
  return {s,posted,poseCalls,tick:ms=>{clock+=ms;}};
};
const settle=()=>new Promise(r=>setTimeout(r,5));

test('ActorService: kills play Death once, hold the last frame, then remove the pose',async()=>{
  const {s,posted,poseCalls,tick}=mkService(),list=[npc(1,10,0)],assets=new Map([['m',{bounds}]]);
  s.update(list,[0,0]);await settle();s.update(list,[0,0]);
  const hit=(x)=>s.collide(list,assets,x,0,0);
  tick(1000);hit(0);tick(40);hit(20);
  const fx=posted.filter(m=>m.event==='npc-fx').at(-1);
  assert.deepEqual(fx.dead,[list[0].id]);assert.deepEqual(fx.hidden,[]);assert.equal(fx.gibs.length,0);
  poseCalls.length=0;
  tick(500);s.update(list,[0,0]);
  const mid=posted.filter(m=>m.event==='pose').at(-1).poses.find(p=>p.phase===`d:${list[0].id}`);
  assert.ok(mid);assert.ok(poseCalls.some(([a,t])=>a===1&&t>.4&&t<.6),'Death clip (id 1) at its own time');
  tick(2000);s.collide(list,assets,500,0,0);s.update(list,[0,0]);
  assert.ok(poseCalls.some(([a,t])=>a===1&&t>1.99&&t<2),'held at last frame');
  const before=poseCalls.length;tick(40);s.update(list,[0,0]);
  assert.equal(poseCalls.filter(([a])=>a===1).length,before?poseCalls.filter(([a])=>a===1).length:0);
  assert.equal(s.cc.states.get(list[0].id).state,'dead');
  tick(40);s.collide(list,assets,500,0,0);const n=poseCalls.filter(([a])=>a===1).length;s.update(list,[0,0]);
  assert.equal(poseCalls.filter(([a])=>a===1).length,n,'held pose is posted once, not every tick');
  tick((2+C.corpseSeconds)*1000);s.collide(list,assets,500,0,0);
  const gone=posted.filter(m=>m.event==='npc-fx').at(-1);
  assert.deepEqual(gone.hidden,[list[0].id]);
  s.update(list,[0,0]);
  assert.ok(posted.filter(m=>m.event==='pose').at(-1).removed.includes(`m#d:${list[0].id}`));
  s.close();
});

test('ActorService: gib hides the creature and posts a burst; disabling revives everything',async()=>{
  const {s,posted,tick}=mkService(),list=[npc(1,10,0)],assets=new Map([['m',{bounds}]]);
  s.cc.rand=()=>0;
  s.update(list,[0,0]);await settle();
  tick(1000);s.collide(list,assets,0,0,0);tick(40);s.collide(list,assets,20,0,0);
  const fx=posted.filter(m=>m.event==='npc-fx').at(-1);
  assert.deepEqual(fx.hidden,[list[0].id]);assert.equal(fx.gibs.length,1);
  s.cc.enabled=false;tick(40);s.collide(list,assets,20,0,0);
  const off=posted.filter(m=>m.event==='npc-fx').at(-1);
  assert.deepEqual([off.hidden,off.dead,off.gibs],[[],[],[]]);assert.ok(s.cc.isAlive(list[0].id));
  s.close();
});

test('ActorService: a dead wanderer stays frozen instead of walking off',()=>{
  const {s}=mkService(),list=[npc(1,10,0)];
  s.cc.states.set(list[0].id,{state:'dead',t0:0,x:3,y:4,z:0,key:'m',duration:1});
  s.walk.set(list[0].id,{home:[10,0,0],g:0,last:{x:3,y:4,z:0,yaw:1,vx:1,vy:1}});
  const posts=[];s.post=m=>posts.push(m);
  s.wander(list,[0,0],()=>0,100);
  const mv=posts.find(m=>m.event==='npc-moves').moves[0];
  assert.deepEqual(mv.slice(1),[3,4,0,1,0,0]);
});

test('gib particles stay inside the pool and use only procedural kinds',()=>{
  const pool=new ParticlePool(64,()=>.5);emitGib(pool,[0,0,0],1);
  assert.ok(pool.count>0&&pool.count<=64);
});
