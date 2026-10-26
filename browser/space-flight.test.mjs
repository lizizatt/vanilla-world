import test from 'node:test';
import assert from 'node:assert/strict';
import {flySpeed,createFlight,stepFlight,clampSurface,eyeRelative,FLY} from './space-flight.js';
import {ELUNE,AZEROTH,centreAt,toInertial,altitudeAbove} from './bodies.js';

const unit=a=>{const n=Math.hypot(...a);return a.map(v=>v/n);};
const axes=look=>{const up0=Math.abs(look[1])>.9?[1,0,0]:[0,1,0],r=unit([look[1]*up0[2]-look[2]*up0[1],look[2]*up0[0]-look[0]*up0[2],look[0]*up0[1]-look[1]*up0[0]]);
  return {look,right:r,up:unit([r[1]*look[2]-r[2]*look[1],r[2]*look[0]-r[0]*look[2],r[0]*look[1]-r[1]*look[0]])};};

/** Fly from 1200 yd over Azeroth to 1200 yd over Elune, aiming at Elune every frame. Returns seconds and parent trace. */
function transfer(fast,hz=60) {
  const dt=1/hz;let t=1440;
  let s=createFlight(toInertial(AZEROTH,[0,1200,0],t),t,'azeroth');
  const parents=[];let secs=0,swapAt=null;
  while(secs<400) {
    const c=centreAt(ELUNE,t),aim=unit(c.map((v,i)=>v-s.pos[i]));
    const next=stepFlight(s,{...axes(aim),forward:1,fast},dt,t);
    if(next.parent!==s.parent){swapAt=secs;parents.push(next.parent);}
    s=next;t+=dt*2;secs+=dt;
    if(altitudeAbove(ELUNE,s.pos,t)<1200)break;
  }
  return {secs,parents,swapAt,s,t};
}

test('speed law: floors, proportional to altitude', () => {
  assert.equal(flySpeed(0,false),FLY.walkFloor);
  assert.equal(flySpeed(0,true),FLY.fastFloor);
  assert.ok(Math.abs(flySpeed(100000,false)-31000)<1);
  assert.ok(flySpeed(100000,true)>flySpeed(100000,false));
});

test('walking Azeroth -> Elune takes about 30 s', () => {
  const r=transfer(false);assert.ok(r.secs>22&&r.secs<40,String(r.secs));
});

test('Shift takes about 6 s (Elune rail is 100 kyd out)', () => {
  const r=transfer(true);assert.ok(r.secs>4&&r.secs<9,String(r.secs));
});

test('the parent well swaps exactly once, without a position pop', () => {
  const r=transfer(true);assert.deepEqual(r.parents,['elune']);
  // continuity: replay and compare per-frame displacement to max speed
  let t=1440,s=createFlight(toInertial(AZEROTH,[0,1200,0],t),t,'azeroth'),maxStepOver=0;
  for(let i=0;i<60*14;i++) {
    const aim=unit(centreAt(ELUNE,t).map((v,j)=>v-s.pos[j])),n=stepFlight(s,{...axes(aim),forward:1,fast:true},1/60,t);
    const d=Math.hypot(...n.pos.map((v,j)=>v-s.pos[j])),cap=(flySpeed(Math.min(altitudeAbove(ELUNE,s.pos,t),altitudeAbove(AZEROTH,s.pos,t)),true)+300)/60;
    maxStepOver=Math.max(maxStepOver,d-cap);s=n;t+=2/60;
    if(altitudeAbove(ELUNE,s.pos,t)<1200)break;
  }
  assert.ok(maxStepOver<1,String(maxStepOver));
});

test('after the swap the ship co-moves with Elune (not left behind)', () => {
  const t=5000,c=centreAt(ELUNE,t),pos=[c[0]+ELUNE.radius+500,c[1],c[2]];
  let s=createFlight(pos,t,'elune');const start=eyeRelative(s,ELUNE,t);
  for(let i=0;i<60;i++){s=stepFlight(s,{look:[1,0,0],right:[0,0,1],up:[0,1,0],forward:0},1/60,t+i*2/60);}
  const end=eyeRelative(s,ELUNE,t+2);
  assert.ok(Math.hypot(...end.map((v,i)=>v-start[i]))<5,'drift '+Math.hypot(...end.map((v,i)=>v-start[i])));
});

test('cannot fly through a surface', () => {
  const t=0,c=centreAt(ELUNE,t),inside={pos:[c[0]+ELUNE.radius-100,c[1],c[2]],parent:'elune',carry:[0,0,0],from:null,age:Infinity};
  const out=clampSurface(inside,t);
  assert.ok(Math.abs(altitudeAbove(ELUNE,out.pos,t)-FLY.minAltitude)<1e-6);
});

test('floating origin keeps eye offsets small near a body', () => {
  const t=3000,c=centreAt(ELUNE,t),s=createFlight([c[0]+ELUNE.radius+10,c[1],c[2]],t,'elune');
  const rel=eyeRelative(s,ELUNE,t);assert.ok(Math.abs(Math.hypot(...rel)-ELUNE.radius-10)<1e-6);
  assert.ok(Math.abs(Math.fround(rel[0])-rel[0])<1e-3);
});

test('1000x warp: camera stays over the same ground within 2000 yd, is inertial far away, and does not drift over long sim time', async () => {
  const {stepFlight,createFlight}=await import('./space-flight.js');
  const {ELUNE,AZEROTH,toInertial,fromInertial,centreAt}=await import('./bodies.js');
  const input={look:[1,0,0],right:[0,0,1],up:[0,1,0],forward:0,strafe:0,lift:0,simRate:2000};
  const run=(body,alt,steps)=>{
    const chart=[body.centre[0]+300,alt,body.centre[1]+200];let t=1000;
    let s=createFlight(toInertial(body,chart,t),t,body.id,2000);const p0=fromInertial(body,s.pos,t);
    for(let i=0;i<steps;i++){s=stepFlight(s,input,1/60,t);t+=2000/60;}
    return {p0,p1:fromInertial(body,s.pos,t,p0[0]),s,t};
  };
  for(const [body,alt] of [[ELUNE,300],[ELUNE,1500],[AZEROTH,300],[AZEROTH,1500]]) {
    const {p0,p1}=run(body,alt,3600);
    assert.ok(Math.hypot(p1[0]-p0[0],p1[2]-p0[2])<.5,`${body.id}@${alt} ground drift`);
    assert.ok(Math.abs(p1[1]-p0[1])<.5,`${body.id}@${alt} altitude drift`);
  }
  const far=run(ELUNE,40000,600),p=toInertial(ELUNE,[ELUNE.centre[0]+300,40000,ELUNE.centre[1]+200],1000);
  assert.ok(Math.hypot(far.s.pos[0]-p[0],far.s.pos[1]-p[1],far.s.pos[2]-p[2])<1e-6,'far camera is inertial under warp');
  const c0=centreAt(ELUNE,1000),c1=centreAt(ELUNE,far.t);assert.ok(Math.hypot(c1[0]-c0[0],c1[2]-c0[2])>1000);
});
