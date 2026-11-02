import test from 'node:test';
import assert from 'node:assert/strict';
import {CreatureSoundCatalog,CreatureSounds,spatialGain,CREATURE_SOUND as C} from './creature-sound.js';

function dbc(fields,rows) {
  const strings=[0],offsets=new Map(),str=s=>{
    if(!s)return 0;
    if(!offsets.has(s)){offsets.set(s,strings.length);strings.push(...Buffer.from(s+'\0'));}
    return offsets.get(s);
  };
  const out=Buffer.alloc(20+rows.length*fields*4);
  out.write('WDBC');out.writeUInt32LE(rows.length,4);out.writeUInt32LE(fields,8);out.writeUInt32LE(fields*4,12);
  rows.forEach((row,r)=>{for(let f=0;f<fields;f++){
    const v=row[f]??0;out.writeUInt32LE(typeof v==='string'?str(v):v,20+r*fields*4+f*4);
  }});
  const table=Buffer.from(strings);out.writeUInt32LE(table.length,16);
  return new Uint8Array(Buffer.concat([out,table]));
}
const row=o=>Object.assign([],o);
// display 100 -> sound data 5 -> death entry 9 (two variants); display 101 -> data 6 (no death); display 102 -> no sound data
const displays=()=>dbc(14,[row({0:100,1:1,2:5}),row({0:101,1:1,2:6}),row({0:102,1:1,2:0})]);
const data=()=>dbc(30,[row({0:5,3:8,6:9}),row({0:6,3:8})]);
const entries=()=>dbc(29,[row({0:9,2:'WolfDeath',3:'WolfDeathA.wav',4:'WolfDeathB.wav',5:'../evil.txt',23:'Sound\\Creature\\Wolf'}),row({0:8,3:'Hurt.wav',23:'Sound\\Creature\\Wolf'})]);

test('catalog resolves display -> CreatureSoundData death -> validated SoundEntries paths',()=>{
  const c=new CreatureSoundCatalog(displays(),data(),entries());
  assert.deepEqual(c.deathPaths(100),['Sound\\Creature\\Wolf\\WolfDeathA.wav','Sound\\Creature\\Wolf\\WolfDeathB.wav']);
  assert.deepEqual(c.deathPaths(101),[],'sound data without a death entry');
  assert.deepEqual(c.deathPaths(102),[]);assert.deepEqual(c.deathPaths(999),[]);
});

test('malformed DBCs are rejected',()=>{
  assert.throws(()=>new CreatureSoundCatalog(new Uint8Array(4),data(),entries()));
  assert.throws(()=>new CreatureSoundCatalog(displays(),data(),dbc(28,[row({0:1})])),/layout/);
});

const source=files=>({read:async p=>{const f=files.get(p);if(!f)throw Object.assign(Error('missing'),{code:'ENOENT'});return f;}});
const dbcs=()=>new Map([['DBFilesClient\\CreatureDisplayInfo.dbc',displays()],['DBFilesClient\\CreatureSoundData.dbc',data()],['DBFilesClient\\SoundEntries.dbc',entries()]]);

test('service reads a death sound once, then only names it; no sound or missing Data is silent',async()=>{
  const files=dbcs();files.set('Sound\\Creature\\Wolf\\WolfDeathA.wav',new Uint8Array([1,2,3]));
  const s=new CreatureSounds(source(files),()=>0);
  const first=await s.death(100);
  assert.equal(first.path,'Sound\\Creature\\Wolf\\WolfDeathA.wav');assert.equal(first.bytes.length,3);
  assert.deepEqual(await s.death(100),{path:'Sound\\Creature\\Wolf\\WolfDeathA.wav'});
  assert.equal(await s.death(101),undefined);assert.equal(await s.death(999),undefined);
  assert.equal(await new CreatureSounds(source(new Map())).death(100),undefined,'no DBCs');
  assert.equal(await new CreatureSounds(source(dbcs())).death(100),undefined,'listed file missing from Data');
});

test('spatial gain falls off with distance and is dropped beyond maxDistance',()=>{
  const eye=[0,0,0],at=d=>spatialGain(eye,[d,0,0]);
  assert.equal(at(1).gain,C.gain);assert.equal(at(C.refDistance).gain,C.gain);
  assert.ok(at(40).gain<at(20).gain&&at(20).gain<C.gain);
  assert.equal(at(C.maxDistance+1).audible,false);assert.equal(at(C.maxDistance+1).gain,0);
  assert.equal(spatialGain(eye,[3,4,12]).distance,13);
});
