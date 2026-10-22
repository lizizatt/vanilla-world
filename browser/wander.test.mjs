import test from 'node:test';
import assert from 'node:assert/strict';
import {npcClass,idSeed,wanders,wanderState,WANDER} from './wander.js';
import {ACTOR,ActorService} from './actors.js';

test('classes come from the model path',()=>{
  assert.equal(npcClass('character\\human\\male\\humanmale.m2'),'civilian');
  assert.equal(npcClass('Creature\\Rabbit\\Rabbit.m2'),'critter');
  assert.equal(npcClass('Creature\\Dragon\\Dragon.m2'),undefined);
});

test('critters always wander, civilians about 20%, others never',()=>{
  const seeds=[...Array(2000).keys()].map(i=>idSeed(`0:npc:${i}`));
  assert.ok(seeds.every(s=>wanders('critter',s)));
  const share=seeds.filter(s=>wanders('civilian',s)).length/seeds.length;
  assert.ok(share>.15&&share<.25,share);
  assert.ok(!wanders(undefined,seeds[0]));
});

test('wander is deterministic, bounded by the class radius and continuous',()=>{
  for(const cls of ['critter','civilian']){
    const seed=idSeed('0:npc:42'),home=[100,-50],R=WANDER[cls].radius;
    let prev;
    for(let t=0;t<400;t+=.25){
      const s=wanderState(seed,cls,home,t);
      assert.deepEqual(s,wanderState(seed,cls,home,t));
      assert.ok(Math.hypot(s.x-home[0],s.y-home[1])<=R+1e-6);
      if(prev)assert.ok(Math.hypot(s.x-prev.x,s.y-prev.y)<=WANDER[cls].speed*.25+.01+Math.hypot(0,0),'speed bound');
      prev=s;
    }
  }
});

test('different ids follow different paths and moving state reports velocity',()=>{
  const a=wanderState(idSeed('0:npc:1'),'critter',[0,0],10),b=wanderState(idSeed('0:npc:2'),'critter',[0,0],10);
  assert.notDeepEqual([a.x,a.y],[b.x,b.y]);
  let moving=0;
  for(let t=0;t<200;t+=.5){const s=wanderState(idSeed('0:npc:1'),'critter',[0,0],t);if(s.vx||s.vy)moving++;}
  assert.ok(moving>0&&moving<400);
});

const npc=(n,x,path='Creature\\Rabbit\\Rabbit.m2')=>({id:`0:npc:${n}`,key:'k',kind:'m2',path,skins:[],matrix:[...Array(12).fill(0),x,0,5,1]});
const make=()=>{const posts=[];return {s:new ActorService({read:async()=>new Uint8Array(1)},{},m=>posts.push(m)),posts};};

test('wander follows ground, holds on water/step/steep, and clears when far',()=>{
  const {s,posts}=make();
  s.wander([npc(1,0)],[0,0],(x,y)=>7+(x+y)*.01,100);
  const first=posts.at(-1).moves[0];
  assert.equal(first[0],'0:npc:1');assert.ok(Math.abs(first[3]-(5+(first[1]+first[2])*.01))<1e-9,'z = authored offset + terrain delta');
  let calls=0;
  const cliff=(x,y)=>(calls++<1?7:20);
  s.wander([npc(2,0)],[0,0],cliff,100);
  assert.equal(posts.at(-1).moves.length,0);assert.equal(s.snapshot().rejected,1);
  s.wander([npc(3,0)],[0,0],(x,y)=>(Math.hypot(x,y)<.01?7:Number.NaN),100);
  assert.equal(s.snapshot().rejected,1);
  const steep=(x,y)=>(Math.hypot(x,y)<.01?7:7+(x+y)*3);
  let rejected=0;
  for(let t=100;t<160;t+=1){s.wander([npc(4,0)],[0,0],steep,t);rejected+=s.snapshot().rejected;}
  assert.ok(rejected>0);
  s.wander([],[0,0],()=>7,300);
  s.wander([npc(9,0)],[0,0],()=>7,310);s.wander([npc(9,ACTOR.radius+5)],[0,0],()=>7,311);
  assert.ok(posts.at(-1).removed.includes('0:npc:9'));
});
test('wander respects the Animate NPCs toggle and non-wanderer classes',()=>{
  const {s,posts}=make();
  s.wander([npc(1,0,'Creature\\Dragon\\Dragon.m2')],[0,0],()=>0,1);
  assert.equal(posts.length,0);
  s.wander([npc(1,0)],[0,0],()=>0,1);assert.equal(posts.length,1);
  s.enabled=false;s.wander([npc(1,0)],[0,0],()=>0,2);
  assert.equal(posts.at(-1).moves.length,0);assert.ok(posts.at(-1).removed.length);
});

const rig=(ms)=>({SceneActor:{create:()=>({duration:a=>a===4&&ms===undefined?0:2,move_speed:()=>ms??0,vertex_count:()=>10,pose:(a,t)=>{rig.calls.push([a,t]);return new Float32Array(30);},free(){}})}});
rig.calls=[];
const walker=async(ms)=>{
  rig.calls=[];const posts=[];
  const s=new ActorService({read:async()=>new Uint8Array(1)},rig(ms),m=>posts.push(m),()=>0);
  const n={...npc(1,0,'Creature\\Rabbit\\Rabbit.m2'),matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,5,1]};
  s.update([n],[0,0]);await new Promise(r=>setTimeout(r,5));
  let t=0;
  while(!(s.walk.get(n.id)?.last?.vx||s.walk.get(n.id)?.last?.vy)&&t<400){s.wander([n],[0,0],()=>7,t);t+=1;}
  rig.calls=[];s.update([n],[0,0]);
  return {s,calls:rig.calls,posts,n};
};

test('a moving NPC with a Walk clip and moveSpeed plays Walk at speed/moveSpeed',async()=>{
  const {s,calls,posts}=await walker(2);
  assert.equal(calls[0][0],4);
  assert.ok(posts.at(-1).poses[0].phase>=ACTOR.phases);
  const l=s.walk.values().next().value.last;
  assert.ok(Math.abs(calls[0][1]/(Date.now()/1000*0+calls[0][1])-1)<1e-9);
  assert.ok(Math.hypot(l.vx,l.vy)>0);
});

test('no Walk clip or no moveSpeed falls back to Stand',async()=>{
  assert.equal((await walker(undefined)).calls[0][0],0);
  assert.equal((await walker(0)).calls[0][0],0);
});

test('facing turns at a bounded rate instead of snapping',()=>{
  const s=new ActorService({},{},()=>{},()=>0),n=npc(1,0);
  const yaws=[];
  for(let t=0;t<120;t+=.1){s.wander([n],[0,0],()=>7,t);const l=s.walk.get(n.id)?.last;if(l)yaws.push(l.yaw);}
  for(let i=1;i<yaws.length;i++){
    const d=Math.abs(Math.atan2(Math.sin(yaws[i]-yaws[i-1]),Math.cos(yaws[i]-yaws[i-1])));
    assert.ok(d<=WANDER.turnRate*.1+1e-9,d);
  }
});
