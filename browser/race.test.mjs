import test from 'node:test';
import assert from 'node:assert/strict';
import {lapTimes,Race,crossesGate,crossingAt,breakoffDistance,validateTrack,BREAKOFF_MARGIN,formatTime,bearing,addScore,validScores,SCORE_LIMIT,unstuckPoses,UNSTUCK_YD} from './race.js';

// Gates face -z (yaw 0), spaced 100 yd apart northward.
const gate=z=>({pos:[0,0,z],yaw:0,width:40});
const track={id:'t',start:{pos:[0,0,50],yaw:0},gates:[gate(-50),gate(-150)],mode:'p2p'};
const drive=(race,zs,t0=10,x=0)=>{const ev=[];zs.forEach((z,i)=>ev.push(race.update([x,0,z],t0+i)));return ev;};
const run=r=>{r.start(0);r.lined(0);r.update([0,0,50],3);};

test('gate crossing needs forward direction, width and height',()=>{
  const g=gate(-50);
  assert.ok(crossesGate(g,[0,0,-40],[0,0,-60]));
  assert.ok(!crossesGate(g,[0,0,-60],[0,0,-40]));
  assert.ok(!crossesGate(g,[30,0,-40],[30,0,-60]));
  assert.ok(!crossesGate(g,[0,500,-40],[0,500,-60]));
  assert.ok(crossesGate({...g,yaw:Math.PI/2},[0,0,-50].map((v,i)=>i===0?v+10:v),[-10,0,-50]));
});
test('breakoff is max pairwise distance plus margin unless overridden',()=>{
  assert.equal(breakoffDistance(validateTrack(track)),200+BREAKOFF_MARGIN);
  assert.equal(breakoffDistance({...track,breakoff:900}),900);
});
test('state machine runs idle -> lineup -> countdown -> running -> finished',()=>{
  const r=new Race(track);assert.equal(r.state,'idle');
  r.start(0);assert.equal(r.state,'lineup');
  r.lined(1);assert.equal(r.state,'countdown');assert.equal(r.countdown(2),2);
  assert.equal(r.update([0,0,50],3),null);assert.equal(r.update([0,0,50],4),'go');assert.equal(r.state,'running');
  assert.deepEqual(drive(r,[-40,-60],5),[null,'gate']);
  assert.equal(r.nextGate.pos[2],-150);
  assert.deepEqual(drive(r,[-140,-160],8),[null,'finish']);
  assert.equal(r.state,'finished');assert.equal(r.time,r.splits[1]);assert.equal(r.splits.length,2);
});
test('pause freezes the countdown and the running clock',()=>{
  const r=new Race(track);r.start(0);r.lined(0);
  r.pause(1);r.resume(11);assert.equal(r.countdown(11),2);
  r.update([0,0,50],13);assert.equal(r.state,'running');
  r.pause(15);r.resume(115);assert.equal(r.elapsed(116),3);
  r.resume(200);assert.equal(r.elapsed(116),3);
});
test('abandoned race records no time',()=>{
  const r=new Race(track);run(r);r.cancel('abandoned');
  assert.equal(r.state,'cancelled');assert.equal(r.reason,'abandoned');assert.equal(r.time,null);
});
test('gates must be crossed in order',()=>{
  const r=new Race(track);run(r);
  r.update([100,0,50],5);r.update([100,0,-100],6);r.update([0,0,-100],7);
  assert.equal(r.update([0,0,-160],8),null);
  assert.equal(r.next,0);
});
test('laps loop the gate list and finish after the last gate of the last lap',()=>{
  const r=new Race({...track,mode:'lap',laps:2,gates:[gate(-50)]});
  r.start(0);r.lined(0);r.update([0,0,50],3);
  assert.equal(r.update([0,0,-40],4),null);assert.equal(r.update([0,0,-60],5),'gate');
  assert.equal(r.state,'running');assert.equal(r.lap,2);
  r.update([0,0,-40],6);assert.equal(r.update([0,0,-60],7),'finish');
});
test('far from the whole course cancels without a time',()=>{
  const r=new Race(track);run(r);r.update([0,0,50],4);
  assert.equal(r.update([5000,0,50],5),null);
  assert.equal(r.state,'cancelled');assert.equal(r.reason,'breakoff');assert.equal(r.time,null);
});
test('cancel keeps no result and finished races ignore cancel',()=>{
  const r=new Race(track);run(r);r.cancel('abandon');assert.equal(r.state,'cancelled');
  const f=new Race({...track,gates:[gate(-50)]});run(f);f.update([0,0,-40],4);f.update([0,0,-60],5);
  f.cancel();assert.equal(f.state,'finished');
});
test('invalid tracks are rejected',()=>{
  assert.throws(()=>validateTrack({...track,gates:[]}));
  assert.throws(()=>validateTrack({...track,gates:[{pos:[0,0,0],yaw:0,width:0}]}));
  assert.throws(()=>validateTrack({...track,id:'Bad Id'}));
  assert.throws(()=>validateTrack({...track,mode:'p2p',laps:2}));
});
test('formatTime pads seconds and carries minutes',()=>{
  assert.equal(formatTime(5.4),'0:05.40');assert.equal(formatTime(75.456),'1:15.46');assert.equal(formatTime(-1),'0:00.00');
});
test('bearing is signed: right positive, ahead zero, behind pi',()=>{
  assert.ok(Math.abs(bearing([0,0,0],0,[0,0,-10]))<1e-9);
  assert.ok(Math.abs(bearing([0,0,0],0,[10,0,0])-Math.PI/2)<1e-9);
  assert.ok(Math.abs(bearing([0,0,0],0,[-10,0,0])+Math.PI/2)<1e-9);
  assert.ok(Math.abs(Math.abs(bearing([0,0,0],0,[0,0,10]))-Math.PI)<1e-9);
  assert.ok(Math.abs(bearing([0,0,0],Math.PI/2,[-10,0,0]))<1e-9);
});
test('scoreboard keeps the fastest runs, reports rank and rejects damaged records',()=>{
  let record,run;
  for(const time of [30,20,40]){({record}=addScore(record,{time,splits:[time],date:'d'}));}
  assert.deepEqual(record.runs.map(r=>r.time),[20,30,40]);
  const result=addScore(record,run={time:25,splits:[25],date:'d'});
  assert.equal(result.rank,1);
  for(let i=0;i<20;i++)record=addScore(record,{time:100+i,splits:[],date:'d'}).record;
  assert.equal(record.runs.length,SCORE_LIMIT);
  assert.deepEqual(validScores({version:1,runs:[{time:'x',splits:[]}]}).runs,[]);
  assert.deepEqual(validScores(undefined).runs,[]);
});

test('shipped tracks validate and gates are reachable in order from the start pose',async()=>{
  const {readFile,readdir}=await import('node:fs/promises');
  for(const f of (await readdir(new URL('./tracks/',import.meta.url))).filter(n=>n.endsWith('.json'))){
    const t=validateTrack(JSON.parse(await readFile(new URL(`./tracks/${f}`,import.meta.url),'utf8')));
    assert.ok(breakoffDistance(t)>BREAKOFF_MARGIN,f);
    for(const g of t.gates)assert.ok(Math.hypot(g.pos[0]-t.start.pos[0],g.pos[2]-t.start.pos[2])<breakoffDistance(t),f);
  }
});

const mk=(over={})=>({id:'t',start:{pos:[0,0,0],yaw:0},gates:[{pos:[0,0,-100],yaw:0,width:20},{pos:[0,0,-300],yaw:0,width:20}],...over});
const go=r=>{r.start(0);r.lined(0);r.update([0,0,0],3);return r;};
test('finish gate is the last gate of the last lap (1 lap, p2p, multi-lap)',()=>{
  const r=go(new Race(mk()));
  assert.equal(r.finishing,false);r.update([0,0,-50],4);r.update([0,0,-150],5);
  assert.equal(r.finishing,true);
  const l=go(new Race(mk({mode:'lap',laps:2})));
  const seen=[];for(let i=0;i<4;i++){seen.push(l.finishing);l.update([0,0,-100-(i%2)*200+50],4+i*2);l.update([0,0,-100-(i%2)*200-50],5+i*2);}
  assert.deepEqual(seen,[false,false,false,true]);
  const one=go(new Race(mk({gates:[{pos:[0,0,-100],yaw:0,width:20}]})));
  assert.equal(one.finishing,true);
});
test('swept crossing: 1000+ yd/s step and hitch gaps count once, with interpolated time',()=>{
  const r=go(new Race(mk()));
  assert.equal(r.update([0,0,-1500],4),'finish');           // one step passes both gates
  assert.equal(r.splits.length,2);
  assert.ok(Math.abs(r.splits[0]-(100/1500))<1e-6);       // t=3 -> 4 interpolated
  assert.equal(r.update([0,0,-3000],5),null);                // finished: no recount
});
test('grazing, outside width, wrong direction and teleports do not or only validly count',()=>{
  const g={pos:[0,0,0],yaw:0,width:20};
  assert.ok(crossingAt(g,[10,0,10],[10,0,-10])>=0);          // exactly on the edge
  assert.equal(crossingAt(g,[10.5,0,10],[10.5,0,-10]),-1);
  assert.equal(crossingAt(g,[0,0,-10],[0,0,10]),-1);
  assert.equal(crossingAt(g,[0,0,10],[0,0,5]),-1);
  const r=go(new Race(mk()));
  r.jump();assert.equal(r.update([0,0,-150],4),null);        // respawn past the gate is not a crossing
  assert.equal(r.update([0,0,-350],5),null);                 // gate 1 still pending (needs a real pass)
  assert.equal(r.next,0);
});
test('same gate cannot trigger twice in one step',()=>{
  const r=go(new Race(mk({mode:'lap',laps:3,gates:[{pos:[0,0,-100],yaw:0,width:20}]})));
  assert.equal(r.update([0,0,-200],4),'gate');assert.equal(r.next,1);
});
test('lapTimes splits cumulative gate times into per-lap durations',()=>{
  assert.deepEqual(lapTimes([5,10,20,25,30,45],3),[20,25]);
  assert.deepEqual(lapTimes([5,10],3),[]);
  assert.deepEqual(lapTimes([4,9],1),[4,5]);
});

test('unstuck lifts 10 m (yards) straight up, keeping x/z/yaw, with 2x/4x retries',()=>{
  assert.ok(Math.abs(UNSTUCK_YD-10.936)<.01);
  const [a,b,c]=unstuckPoses([1,2,3,.5]);
  assert.deepEqual(a.map((v,i)=>i===1?0:v),[1,0,3,.5]);
  assert.ok(Math.abs(a[1]-2-UNSTUCK_YD)<1e-9&&Math.abs(c[1]-2-4*UNSTUCK_YD)<1e-9&&b[0]===1);
});

test('a gate pass counts high above the ground when the reach is widened (low gravity), not at the default window', async () => {
  const {Race,GATE_REACH}=await import('./race.js');const {gateReach}=await import('./bodies.js');
  assert.equal(gateReach('azeroth'),GATE_REACH);assert.equal(gateReach('elune'),400);
  const track={id:'hi',start:{pos:[0,0,50],yaw:0},gates:[{pos:[0,10,0],yaw:0,width:70}]};
  for(const [reach,passes] of [[GATE_REACH,false],[gateReach('elune'),true]]){
    const r=new Race(track,reach);r.start(0);r.lined(0);r.update([0,300,40],3);r.update([0,300,40],3.1);
    assert.equal(r.update([0,300,-40],3.2),passes?'finish':null);
  }
});
