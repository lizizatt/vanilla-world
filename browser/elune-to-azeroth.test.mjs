import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Race,validateTrack} from './race.js';
import {legs,transitions,checkTrack} from './track-legs.js';
import {trailChevrons,TRAIL_CAP,MAX_CHEVRONS} from './gate-trail.js';

const sample=()=>validateTrack(JSON.parse(readFileSync(new URL('./tracks/elune-to-azeroth.json',import.meta.url),'utf8')));
const raceFlags=readFileSync(new URL('./race-flags.js',import.meta.url),'utf8');

test('elune-to-azeroth is listed, valid, and has one Elune leg then one Azeroth leg',()=>{
  assert.match(raceFlags,/tracks\/elune-to-azeroth\.json/);
  const t=sample();
  assert.equal(checkTrack(t).errors.length,0);
  assert.deepEqual(legs(t).map(l=>l.body),['elune','azeroth']);
  assert.equal(transitions(t).length,1);
});

test('racing the sample across the jump keeps the timer and finishes on Azeroth',()=>{
  const t=sample(),r=new Race(t);r.start(0);r.lined(0);
  const along=(g,d)=>[g.pos[0]-Math.sin(g.yaw)*d,g.pos[1],g.pos[2]-Math.cos(g.yaw)*d];
  const pass=(g,time,body)=>{
    let e=r.update(along(g,-30),time,body);
    e=r.update(along(g,30),time+.1,body)||e;
    return e;
  };
  r.update(t.start.pos,3,'elune');
  const g=t.gates;
  const flown=[];
  for(const [i,gate] of g.slice(0,2).entries())flown.push(pass(gate,4+i,'elune'));
  assert.equal(r.next,2);
  assert.equal(r.update([0,9e4,0],7,'elune'),null);
  assert.equal(r.update(g[2].pos,8,null),null);
  assert.equal(r.next,2);assert.equal(r.state,'running');
  for(const [i,gate] of g.slice(2).entries())flown.push(pass(gate,9+i,'azeroth'));
  assert.equal(r.state,'finished');assert.equal(r.splits.length,4);assert.ok(r.time>5);
});

test('the cross-body trail beam stays short and finite however far the other body is',()=>{
  for(const d of [5e3,3e5,1e9]){
    const c=trailChevrons({delta:[d,-d/3,d/2],yaw:0,straight:true});
    assert.ok(c.length>0&&c.length<=MAX_CHEVRONS);
    for(const ch of c)for(const v of ch.at)assert.ok(Number.isFinite(v)&&Math.abs(v)<=TRAIL_CAP+1);
  }
});
