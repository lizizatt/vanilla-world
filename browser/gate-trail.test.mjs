import test from 'node:test';
import assert from 'node:assert/strict';
import {trailChevrons,packChevrons,TRAIL_CAP,MAX_CHEVRONS,CHEVRON_FLOATS,GATE_CLEAR,trailWanted,gateInFrustum,stepFade,FAR_ON,FAR_OFF,FADE_SECONDS} from './gate-trail.js';
import {gateGuide} from './gate-guide.js';
import {validateTrack,Race,gateBody,trackBody} from './race.js';
import {AZEROTH,ELUNE} from './bodies.js';

const base={yaw:0,reduced:true};
const reach=c=>Math.hypot(...c.at);
const wellFormed=list=>list.every(c=>c.at.every(Number.isFinite)&&Math.abs(Math.hypot(...c.dir)-1)<1e-9&&c.size>0&&c.size<6&&c.alpha>=0&&c.alpha<=1);

test('gate dead ahead: straight trail of facing chevrons, fading, capped by the near range', () => {
  const t=trailChevrons({...base,delta:[0,0,-300]});
  assert.equal(t.length,Math.floor(TRAIL_CAP/7));
  assert.ok(wellFormed(t));
  t.forEach(c=>{assert.ok(Math.abs(c.at[0])<1e-9);assert.ok(c.dir[2]<-.99);});
  assert.ok(Math.abs(reach(t.at(-1))-TRAIL_CAP)<1,'last chevron sits at the cap');
  assert.ok(t[0].alpha>t.at(-1).alpha+.2,'fades with distance');
  assert.ok(t[0].alpha<=.6&&t[0].alpha>.4,'reduced opacity, still readable');
});

test('gate to the side: trail leaves along the heading and bends toward the gate', () => {
  const left=trailChevrons({...base,delta:[-300,0,0]}),right=trailChevrons({...base,delta:[300,0,0]});
  assert.ok(left[0].dir[2]<-.7&&left[0].dir[0]>-.7,'starts near the heading');
  assert.ok(left.at(-1).dir[0]<-.8,'ends pointing at the gate');
  assert.ok(left.every(c=>c.at[0]<=0)&&right.every(c=>c.at[0]>=0));
  assert.ok(Math.abs(left.at(-1).at[0]+right.at(-1).at[0])<1e-9,'mirror image');
});

test('far gates are bounded: same size and count at 1e3 .. 1e6 yd, only the direction matters', () => {
  const near=trailChevrons({...base,delta:[-300,0,-300]}),far=trailChevrons({...base,delta:[-3e5,0,-3e5]}),huge=trailChevrons({...base,delta:[-1e6,0,-1e6]});
  for(const t of [far,huge]){assert.equal(t.length,near.length);assert.ok(wellFormed(t));assert.ok(t.every(c=>reach(c)<=TRAIL_CAP+1e-6));}
  assert.deepEqual(far.map(c=>c.size),huge.map(c=>c.size));
  assert.ok(far.at(-1).dir[0]<-.5);
});

test('near gate: trail stops short of the gate, very near shows nothing', () => {
  const t=trailChevrons({...base,delta:[0,0,-30]});
  assert.ok(t.length>=1&&t.every(c=>reach(c)<=30-GATE_CLEAR+1e-6));
  assert.deepEqual(trailChevrons({...base,delta:[0,0,-8]}),[]);
  assert.deepEqual(trailChevrons({...base,delta:[0,0,0]}),[]);
  assert.deepEqual(trailChevrons({...base,delta:[NaN,0,-100]}),[]);
});

test('above and below: the trail climbs or dives toward the gate', () => {
  const up=trailChevrons({...base,delta:[0,200,-200]}),down=trailChevrons({...base,delta:[0,-200,-200]});
  assert.ok(up.at(-1).at[1]>20&&down.at(-1).at[1]<-20);
  assert.ok(up.at(-1).dir[1]>.5&&down.at(-1).dir[1]<-.5);
  assert.ok(wellFormed(up)&&wellFormed(down));
});

test('straight mode (orbit, other body) is a plain line to the gate direction', () => {
  const d=[-3,4,-12],n=Math.hypot(...d),t=trailChevrons({...base,delta:d.map(v=>v*1e4/n),straight:true,yaw:1.2});
  t.forEach(c=>d.forEach((v,i)=>assert.ok(Math.abs(c.dir[i]-v/n)<1e-9)));
});

test('gate behind: U-turn toward its side, cyan double-chevron style, never colour alone', () => {
  const t=trailChevrons({...base,delta:[40,0,300],behind:true}),l=trailChevrons({...base,delta:[-40,0,300],behind:true});
  assert.ok(t.every(c=>c.style===1)&&t.at(-1).dir[2]>.3,'ends heading back');
  assert.ok(t.at(-1).at[0]>0&&l.at(-1).at[0]<0,'turns toward the gate side');
  assert.ok(wellFormed(t));
  const blink=trailChevrons({delta:[0,0,300],yaw:0,behind:true,time:Math.PI/18*3.0});
  assert.ok(new Set(blink.map(c=>c.alpha>0.5)).size>=1);
});

test('final gate: last chevron is the checkered style, others amber', () => {
  const t=trailChevrons({...base,delta:[0,0,-300],final:true});
  assert.deepEqual(t.map(c=>c.style),t.map((c,i)=>i===t.length-1?2:0));
});

test('pulse honours reduced motion', () => {
  const a=trailChevrons({delta:[0,0,-300],yaw:0,time:0,reduced:true}),b=trailChevrons({delta:[0,0,-300],yaw:0,time:.4,reduced:true});
  assert.deepEqual(a.map(c=>c.alpha),b.map(c=>c.alpha));
  const p=trailChevrons({delta:[0,0,-300],yaw:0,time:0,reduced:false}),q=trailChevrons({delta:[0,0,-300],yaw:0,time:.4,reduced:false});
  assert.notDeepEqual(p.map(c=>c.alpha),q.map(c=>c.alpha));
});

test('packChevrons rebases on the eye and respects the instance budget', () => {
  const t=trailChevrons({...base,delta:[0,0,-300]}),out=new Float32Array(MAX_CHEVRONS*CHEVRON_FLOATS);
  assert.equal(packChevrons(t,[1,2,3],out),t.length);
  assert.ok(Math.abs(out[0]-(t[0].at[0]+1))<1e-6&&Math.abs(out[2]-(t[0].at[2]+3))<1e-5&&Math.abs(out[3]-t[0].size)<1e-5);
  assert.equal(packChevrons(t,[0,0,0],new Float32Array(2*CHEVRON_FLOATS)),2);
});

// A race whose first gate is on Elune and second on Azeroth (or the reverse) is plain track data: `body` on the track and per gate.
const cross=(start,other)=>({id:'moon-hop',body:start,start:{pos:[0,5,0],yaw:0},gates:[{pos:[0,5,-100],yaw:0,width:40},{pos:[1000,5,-2000],yaw:0,width:40,body:other}]});

test('a track with a gate on another body is valid and the race sees the gate body', () => {
  for(const [a,b] of [['elune','azeroth'],['azeroth','elune']]){
    const track=validateTrack(cross(a,b)),r=new Race(track);
    assert.deepEqual([trackBody(track),gateBody(track,track.gates[0]),gateBody(track,track.gates[1])],[a,a,b]);
    assert.equal(r.track.gates.length,2);
  }
});

test('cross-body trail stays well formed at ~1e5 yd, in either direction and across a body swap', () => {
  const bodies={elune:ELUNE,azeroth:AZEROTH},rows=[];
  for(const [a,b] of [['elune','azeroth'],['azeroth','elune']]) {
    const track=validateTrack(cross(a,b)),gate=track.gates[1];
    for(const t of [720,1500,9000]) {
      const pos=[0,5,0],g=gateGuide({pos,yaw:.3,gate,body:a,gateBody:b,frame:{active:bodies[a],target:bodies[b],t}});
      assert.ok(g.visible&&g.cross);assert.ok(g.rangeYd>5e4);
      const trail=trailChevrons({delta:g.delta,yaw:.3,behind:g.behind,straight:true,final:true,time:1,reduced:true});
      assert.ok(trail.length>=5&&wellFormed(trail));
      trail.forEach(c=>assert.ok(reach(c)<=TRAIL_CAP+1e-6));
      const dir=g.delta.map(v=>v/g.rangeYd);
      trail.forEach(c=>dir.forEach((v,i)=>assert.ok(Math.abs(c.dir[i]-v)<1e-9,'points along the line to the other body')));
      rows.push(trail.map(c=>c.size.toFixed(6)).join());
    }
  }
  assert.equal(new Set(rows).size,1,'trail size does not depend on the distance to the other body');
});

test('cross-body direction is stable under f32 rounding of the poses', () => {
  const gate={pos:[1000,5,-2000]},pos=[3.3,10.1,-7.7],f=v=>v.map(Math.fround);
  const frame={active:ELUNE,target:AZEROTH,t:Math.fround(4321.123)};
  const a=gateGuide({pos,yaw:.4,gate,body:'elune',gateBody:'azeroth',frame:{...frame,t:4321.123}}),b=gateGuide({pos:f(pos),yaw:.4,gate:{pos:f(gate.pos)},body:'elune',gateBody:'azeroth',frame});
  const u=g=>g.delta.map(v=>v/g.rangeYd),ua=u(a),ub=u(b);
  assert.ok(Math.hypot(...ua.map((v,i)=>v-ub[i]))<2e-3,'direction agrees to a fraction of a degree');
  assert.ok(Math.abs(a.rangeYd-b.rangeYd)/a.rangeYd<1e-3);
});

// Visibility rule: camera looks along -z, right is +x, up is +y.
const view={eye:[0,0,0],right:[1,0,0],up:[0,1,0],look:[0,0,-1],aspect:16/9,near:.1};
const wanted=(rel,extra={})=>trailWanted({rel,range:Math.hypot(...rel),view,...extra});

test('trail is off for a gate in view and near, on when in view but beyond 1000 yd', () => {
  assert.equal(wanted([0,0,-300]),false);
  assert.equal(wanted([100,20,-500]),false);
  assert.equal(wanted([0,0,-1500]),true);
  assert.equal(wanted([0,0,-FAR_ON-1]),true);
});

test('trail is on for gates off screen at any range, and behind the near plane', () => {
  assert.equal(wanted([800,0,-100]),true,'far to the side');
  assert.equal(wanted([0,500,-100]),true,'far above');
  assert.equal(wanted([30,0,-20]),true,'close but beside');
  assert.equal(wanted([0,0,300]),true,'behind');
  assert.equal(wanted([0,0,-.05]),true,'inside the near plane');
  assert.equal(gateInFrustum([0,0,-300],view),true);
  assert.equal(gateInFrustum([0,0,300],view),false);
  assert.equal(gateInFrustum([0,0,-300],undefined),false);
});

test('hysteresis at the frustum edge and the 1000 yd boundary', () => {
  const z=-400,edge=.55*(16/9)*400;
  const near=[edge*.95,0,z],inside=[edge*.5,0,z];
  assert.equal(wanted(near,{was:false}),false,'in view, trail stays off');
  assert.equal(wanted(near,{was:true}),true,'trail on: near the edge it stays on');
  assert.equal(wanted(inside,{was:true}),false,'well inside it switches off');
  const mid=[0,0,-(FAR_OFF+50)];
  assert.equal(wanted(mid,{was:false}),false,'between 900 and 1000 off stays off');
  assert.equal(wanted(mid,{was:true}),true,'between 900 and 1000 on stays on');
  assert.equal(wanted([0,0,-(FAR_OFF-10)],{was:true}),false);
});

test('cross-body gates always keep the trail on, whatever the view says', () => {
  assert.equal(trailWanted({rel:[0,0,-100],range:100,cross:true,view,was:false}),true);
  assert.equal(trailWanted({rel:[0,0,-8.7e4],range:8.7e4,cross:true,view,was:true}),true);
  assert.equal(trailWanted({rel:undefined,range:NaN,view,was:false}),true,'unknown geometry fails to on');
});

test('fade eases in and out over FADE_SECONDS without jumping', () => {
  let l=0;
  for(let i=0;i<10;i++)l=stepFade(l,true,FADE_SECONDS/10);
  assert.ok(Math.abs(l-1)<1e-9);
  assert.equal(stepFade(1,true,1),1);
  assert.ok(Math.abs(stepFade(1,false,FADE_SECONDS/2)-.5)<1e-9);
  assert.equal(stepFade(.1,false,5),0);
  assert.equal(stepFade(.5,true,-1),.5);
  const half=trailChevrons({...base,delta:[0,0,-100],fade:.5}),full=trailChevrons({...base,delta:[0,0,-100]});
  assert.ok(Math.abs(half[0].alpha*2-full[0].alpha)<1e-9);
});
