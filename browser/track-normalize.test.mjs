import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeTrack,formatTrack} from './track-normalize.js';
import {clampTrack} from './track-edit.js';

const track=()=>({id:'t',name:'T',vehicle:'podracer',mode:'lap',laps:1,start:{pos:[0,-5,0],yaw:.5},
  gates:[{pos:[10,200,0],yaw:1,width:70},{pos:[20,-55.75,0],yaw:2,width:40},{pos:[30,3,0],yaw:3,width:70}]});
// ground 10 everywhere, water 30 at x>=20
const sample=p=>({ground:10,water:p[0]>=20?30:NaN});

test('gates go to max(ground,water)+20; start only rises; other fields untouched',()=>{
  const {track:t,report,unresolved}=normalizeTrack(track(),sample);
  assert.deepEqual(t.gates.map(g=>g.pos[1]),[30,50,50]);
  assert.equal(t.start.pos[1],10);
  assert.deepEqual(unresolved,[]);
  assert.equal(report[2].delta,105.75,'delta is new-old');
  assert.deepEqual(t.gates.map(g=>[g.yaw,g.width]),[[1,70],[2,40],[3,70]]);
  assert.deepEqual([t.id,t.name,t.vehicle,t.mode,t.laps,t.start.yaw],['t','T','podracer','lap',1,.5]);
});

test('a start already above the surface is left alone',()=>{
  const src=track();src.start.pos[1]=99;
  assert.equal(normalizeTrack(src,sample).track.start.pos[1],99);
});

test('idempotent: a second run changes nothing',()=>{
  const once=normalizeTrack(track(),sample).track,twice=normalizeTrack(once,sample);
  assert.deepEqual(twice.track,once);
  assert.ok(twice.report.every(r=>r.status==='same'&&r.delta===0));
  assert.equal(formatTrack(twice.track),formatTrack(once));
});

test('unloaded tiles are flagged and left as authored, never guessed',()=>{
  const {track:t,unresolved,report}=normalizeTrack(track(),p=>p[0]===20?undefined:{ground:10,water:NaN});
  assert.deepEqual(unresolved,['gate 2']);
  assert.equal(t.gates[1].pos[1],-55.75);
  assert.equal(report[3].status,'changed');
});

test('agrees with clampTrack at the minimum clearance (same surface base)',()=>{
  const surfaces=[track().start.pos,...track().gates.map(g=>g.pos)].map(p=>sample(p));
  const clamped=clampTrack(normalizeTrack(track(),sample).track,surfaces);
  assert.deepEqual(clamped.gates.map(g=>g.pos[1]),[30,50,50]);
});

test('format: 2-space JSON, CRLF, trailing newline, and matches the shipped steamwheedle layout',async()=>{
  const text=formatTrack(track());
  assert.ok(text.endsWith('}\r\n')&&!/[^\r]\n/.test(text));
  const shipped=await readFile(new URL('./tracks/steamwheedle.json',import.meta.url),'utf8');
  assert.equal(formatTrack(JSON.parse(shipped)),shipped.replace(/\r?\n/g,'\r\n'));
});
