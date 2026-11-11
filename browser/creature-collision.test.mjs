import test from 'node:test';
import assert from 'node:assert/strict';
import {CreatureCollision,CREATURE_COLLISION as C,segmentDistance2,sweptOverlap,deathPoseTime,scaleTarget} from './creature-collision.js';
import {ActorService} from './actors.js';

const npc=(n,x,y,z=0,over={})=>({id:`0:npc:${n}`,key:'m',kind:'m2',path:'creature\\wolf\\wolf.m2',skins:[],matrix:[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1],...over});
const noPos=()=>undefined,size=()=>[.6,.6,0,1.2,0,0],cls=()=>'creature',dur=()=>2;
const isNpc=i=>i.id.includes(':npc:');
const fresh=(rand=()=>0.99,cfg)=>new CreatureCollision(rand,cfg);
const run=(cc,list,from,to,t0=0,dt=.04)=>{cc.update(list,isNpc,...from,t0,noPos,size,cls,dur);return cc.update(list,isNpc,...to,t0+dt,noPos,size,cls,dur);};

test('segment distance and swept overlap catch tunnelling between ticks',()=>{
  assert.equal(segmentDistance2(0,0,10,0,5,3),9);
  assert.equal(segmentDistance2(0,0,0,0,3,4),25);
  const hit=(az,bz,cx,cy,cz,yaw,hx,hy,zLo,zHi,ox=0,oy=0)=>sweptOverlap(0,0,az,100,0,bz,C.craftRadius,C.craftHalfHeight,cx,cy,cz,yaw,hx,hy,zLo,zHi,ox,oy);
  // creature at x=50 sits between two samples 100 yd apart
  assert.ok(hit(0,0,50,1,0,0,.5,.5,0,1));
  assert.ok(!hit(0,0,50,9,0,0,.5,.5,0,1));
  // flying well above the creature misses, hovering at its height hits
  assert.ok(!hit(30,30,50,0,0,0,.5,.5,0,1));
  assert.ok(hit(1,1,50,0,0,0,.5,.5,0,1));
  // a hovering/flying model's z range sits above its feet: flying under it misses, at its height hits
  assert.ok(!hit(0,0,50,0,0,0,.5,.5,8,10));
  assert.ok(hit(9,9,50,0,0,0,.5,.5,8,10));
});

test('hit box is oriented and offset: a basilisk-shaped body is hit along its tail, not 4 yd off its flank',()=>{
  // bounds x -6.4..2.7, y +-1.6 (real basilisk): half 4.56 x 1.59, centre 1.85 yd behind the origin
  const box=[4.56,1.59,0,2.2,-1.85,0];
  const hit=(cx,cy,yaw,y=0)=>sweptOverlap(0,y,0,48,y,0,C.craftRadius,C.craftHalfHeight,cx,cy,0,yaw,...box);
  assert.ok(hit(50,0,0));            // flying along its length
  assert.ok(!hit(58,0,0));           // origin 10 yd ahead of the path end: snout and craft radius still short
  assert.ok(!hit(50,6,0));           // 6 yd off the flank misses
  assert.ok(hit(50,6,Math.PI/2));    // turned sideways, the tail now sweeps into the path
});
test('speed threshold: slow craft never kills, fast craft does',()=>{
  const list=[npc(1,10,0)];
  assert.equal(run(fresh(),list,[0,0,0],[.5,0,0]).length,0);
  const ev=run(fresh(),list,[0,0,0],[20,0,0]); // 500 yd/s
  assert.equal(ev.length,1);assert.equal(ev[0].id,list[0].id);
});

test('hit-volume scale: 1x at low speed, 2x at cruise, 3x boosting, monotonic and smooth',()=>{
  assert.equal(scaleTarget(0,false),1);assert.equal(scaleTarget(C.scaleFrom,false),1);
  assert.equal(scaleTarget(C.cruiseSpeed,false),2);assert.equal(scaleTarget(C.cruiseSpeed*3,false),2);
  assert.equal(scaleTarget(0,true),3);assert.equal(scaleTarget(C.cruiseSpeed,true),3);
  let prev=1;for(let s=0;s<=C.cruiseSpeed;s+=1){const v=scaleTarget(s,false);assert.ok(v>=prev&&v-prev<.05);prev=v;}
});

test('hit-volume scale grows the reach: a flank miss at rest hits at cruise (5 yd off) and only boosting (7 yd off)',()=>{
  const pass=(boost,steps,off)=>{ // flies +x at 150 yd/s; the creature sits 1.5 yd past the last sample, `off` yd to the side
    const cc=fresh(),list=[npc(1,steps*3-1.5,off)];let n=0;
    for(let i=0;i<=steps;i++)n+=cc.update(list,isNpc,i*3,0,0,i*.02,noPos,size,cls,dur,boost).length;
    return {n,scale:cc.scale};
  };
  assert.equal(run(fresh(),[npc(1,50,5)],[0,0,0],[100,0,0]).length,0); // 1x: .6 + 2.5 < 5
  const cruise=pass(false,40,5);assert.equal(cruise.n,1);assert.ok(cruise.scale>1.9&&cruise.scale<=2.0001,`cruise scale ${cruise.scale}`);
  assert.equal(pass(false,40,7).n,0);                                  // 2x: .6 + 5 < 7
  const boost=pass(true,80,7);assert.equal(boost.n,1);assert.ok(boost.scale>2.9,`boost scale ${boost.scale}`); // 3x: .6 + 7.5 > 7
});
test('hit-volume scale eases: boost onset never pops and scale resets on disable/teleport',()=>{
  const cc=fresh();let last=1,maxStep=0;
  for(let i=0;i<60;i++){cc.update([],isNpc,i*3,0,0,i*.02,noPos,size,cls,dur,i>=20);maxStep=Math.max(maxStep,Math.abs(cc.scale-last));last=cc.scale;}
  assert.ok(maxStep<.2,`max per-tick step ${maxStep}`);
  cc.update([],isNpc,0,0,0,50,noPos,size,cls,dur,true);assert.equal(cc.scale,1);
  cc.enabled=false;cc.update([],isNpc,0,0,0,51,noPos,size,cls,dur,true);assert.equal(cc.scale,1);
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
  const b=fresh();b.update(list,isNpc,0,0,0,0,noPos,()=>[C.maxCreatureRadius+1,C.maxCreatureRadius+1,0,2,0,0],cls,dur);
  assert.equal(b.update(list,isNpc,20,0,0,.04,noPos,()=>[C.maxCreatureRadius+1,C.maxCreatureRadius+1,0,2,0,0],cls,dur).length,0);
  const c=fresh();c.update(list,isNpc,0,0,0,0,noPos,()=>undefined,cls,dur);
  assert.equal(c.update(list,isNpc,20,0,0,.04,noPos,()=>undefined,cls,dur).length,0,'unknown size is skipped');
});

test('creatures with no Death clip are skipped, not killed',()=>{
  const cc=fresh(),list=[npc(1,10,0)];
  cc.update(list,isNpc,0,0,0,0,noPos,size,cls,()=>0);
  assert.equal(cc.update(list,isNpc,20,0,0,.04,noPos,size,cls,()=>0).length,0);
  assert.ok(cc.isAlive(list[0].id));assert.equal(cc.stats.skipped,1);
});

test('Death state machine: dying -> dead (held) -> gone -> respawn',()=>{
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
  // a dead creature is never killed again
  const g=fresh();run(g,list,[0,0,0],[20,0,0],0);
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
  assert.deepEqual(fx.dead,[list[0].id]);assert.deepEqual(fx.hidden,[]);
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

test('ActorService: a kill posts one positional death sound (bytes on every event); silent when the display has none',async()=>{
  const {s,posted,tick}=mkService(),list=[npc(1,10,0),npc(2,12,0)],assets=new Map([['m',{bounds}]]);
  let reads=0;s.sounds.catalog={deathPaths:d=>d===7?['sound\\creature\\wolf\\death.wav']:[]};s.sounds.loading=Promise.resolve();
  s.sounds.source={read:async()=>{reads++;return new Uint8Array([1,2,3]);}};
  s.update(list,[0,0]);await settle();
  tick(1000);s.collide(list,assets,0,0,0,id=>(id===1?7:9));tick(40);s.collide(list,assets,20,0,0,id=>(id===1?7:9));await settle();
  const sounds=posted.filter(m=>m.event==='creature-sound');
  assert.equal(sounds.length,1);assert.equal(sounds[0].path,'sound\\creature\\wolf\\death.wav');assert.deepEqual([sounds[0].x,sounds[0].y],[10,0]);assert.equal(sounds[0].bytes.length,3);
  assert.equal((await s.sounds.death(7)).bytes.length,3);assert.equal(reads,1);
  s.close();
});

test('ActorService: disabling revives everything',async()=>{
  const {s,posted,tick}=mkService(),list=[npc(1,10,0)],assets=new Map([['m',{bounds}]]);
  s.update(list,[0,0]);await settle();
  tick(1000);s.collide(list,assets,0,0,0);tick(40);s.collide(list,assets,20,0,0);
  assert.deepEqual(posted.filter(m=>m.event==='npc-fx').at(-1).dead,[list[0].id]);
  s.cc.enabled=false;tick(40);s.collide(list,assets,20,0,0);
  const off=posted.filter(m=>m.event==='npc-fx').at(-1);
  assert.deepEqual([off.hidden,off.dead],[[],[]]);assert.ok(s.cc.isAlive(list[0].id));
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
