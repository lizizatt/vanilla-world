import test from 'node:test';
import assert from 'node:assert/strict';
import {MusicCatalog,MusicService} from './music.js';
import {MusicPlayer} from './world-music.js';

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
const area=(id,parent,zone)=>{const r=[];r[0]=id;r[2]=parent;r[8]=zone;return r;};
const catalog=()=>new MusicCatalog(
  dbc(25,[area(10,0,5),area(11,10,0),area(12,0,0),area(13,99,0)]),
  dbc(8,[[5,'Zone-Plains',100,200,300,400,7,8],[6,'Empty',1,2,3,4,0,0]]),
  dbc(29,[Object.assign([],{0:7,2:'day',3:'Day 1.mp3',4:'Day 2.mp3',5:'../evil.txt',23:'Sound\\Music\\ZoneMusic\\'}),
    Object.assign([],{0:8,2:'night',3:'Night.mp3',23:'Sound\\Music\\ZoneMusic'})]));

test('sub-areas inherit parent zone music and areas without music resolve to silence',()=>{
  const c=catalog();
  assert.equal(c.set(10),5);assert.equal(c.set(11),5);
  assert.equal(c.set(12),0);assert.equal(c.set(13),0);assert.equal(c.set(0),0);
});
test('day and night variants carry their own silence range and validated paths',()=>{
  const c=catalog();
  assert.deepEqual(c.tracks(5,false),{silence:[100,300],paths:['Sound\\Music\\ZoneMusic\\Day 1.mp3','Sound\\Music\\ZoneMusic\\Day 2.mp3']});
  assert.deepEqual(c.tracks(5,true),{silence:[200,400],paths:['Sound\\Music\\ZoneMusic\\Night.mp3']});
  assert.deepEqual(c.tracks(6,false).paths,[]);
});
test('malformed DBCs are rejected',()=>{
  assert.throws(()=>new MusicCatalog(new Uint8Array(4),dbc(8,[]),dbc(29,[])));
  assert.throws(()=>new MusicCatalog(dbc(24,[area(1,0,0)]),dbc(8,[[1,'x']]),dbc(29,[[1]])),/layout/);
});
test('service reads only the selected track and reports deferral for retry',async()=>{
  const files=new Map([['DBFilesClient\\AreaTable.dbc',dbc(25,[area(10,0,5)])],['DBFilesClient\\ZoneMusic.dbc',dbc(8,[[5,'Z',0,1,2,3,8,8]])],
    ['DBFilesClient\\SoundEntries.dbc',dbc(29,[Object.assign([],{0:8,3:'Night.mp3',23:'Sound\\Music\\Z'})])]]);
  files.set('Sound\\Music\\Z\\Night.mp3',new Uint8Array([1,2,3]));
  const reads=[],events=[];let defer=false;
  const source={read:async(path,options)=>{reads.push(path);if(defer&&path.endsWith('.mp3'))throw Object.assign(Error('d'),{code:'DEFERRED'});
    assert.equal(options.background,true);return files.get(path);}};
  const service=new MusicService(source,e=>events.push(e));
  await service.request({token:1,area:10,night:true,track:false});
  assert.equal(events[0].set,5);assert.equal(events[0].bytes,undefined);assert.ok(!reads.some(p=>p.endsWith('.mp3')));
  await service.request({token:2,area:10,night:true,track:true});
  assert.deepEqual(Array.from(events[1].bytes),[1,2,3]);
  defer=true;await service.request({token:3,area:10,night:true,track:true});
  assert.equal(events[2].retry,true);
});

function fixture() {
  const requests=[],time={now:0},tracks=[];
  const node=()=>({gain:{value:0,setValueAtTime(){},linearRampToValueAtTime(){},setTargetAtTime(){}},connect(){},disconnect(){}});
  const ctx={state:'running',currentTime:0,destination:{},createGain:()=>({...node(),context:ctx}),
    createMediaElementSource:()=>node()};
  globalThis.Audio=class{constructor(url){this.url=url;tracks.push(this);}play(){return Promise.resolve();}pause(){}load(){}removeAttribute(){}};
  const player=new MusicPlayer({request:r=>requests.push(r),context:()=>ctx,now:()=>time.now,random:()=>.5});
  return {player,requests,time,tracks,ctx};
}
test('player requests the set once per area change, plays a track, then waits out the silence gap',()=>{
  const {player,requests,time,tracks}=fixture();
  player.update(10,true);assert.equal(requests.length,1);assert.equal(requests[0].track,false);
  player.update(10,true);assert.equal(requests.length,1);
  player.event({area:10,set:5,silence:[1000,3000],tracks:2});
  player.update(10,true);assert.equal(requests.at(-1).track,true);
  player.event({area:10,set:5,silence:[1000,3000],tracks:2,path:'Sound\\Music\\a.mp3',bytes:new Uint8Array(2)});
  assert.equal(tracks.length,1);assert.equal(player.snapshot().active,true);
  player.update(10,true);assert.equal(requests.length,2);
  tracks[0].onended();
  assert.equal(player.snapshot().active,false);assert.equal(player.snapshot().playing,0);
  time.now=1500;player.update(10,true);assert.equal(requests.length,2);
  time.now=2100;player.update(10,true);assert.equal(requests.length,3);
});
test('leaving music for a no-music area silences it and stale replies are ignored',()=>{
  const {player,requests,time}=fixture();
  player.update(10,true);player.event({area:10,set:5,silence:[0,0],tracks:1});
  time.now=2000;player.update(11,true);
  player.event({area:10,set:5,silence:[0,0],tracks:1,path:'x.mp3',bytes:new Uint8Array(1)});
  assert.equal(player.snapshot().playing,0);
  player.event({area:11,set:0,silence:[0,0],tracks:0});
  time.now=9000;player.update(11,true);
  assert.equal(requests.filter(r=>r.track).length,0);
  player.update(11,false);player.stop();assert.equal(player.snapshot().set,0);
});

test('day is the default regardless of the clock and the toggle re-requests the other variant',()=>{
  const {player,requests,time}=fixture();
  player.update(10,true);assert.equal(requests[0].night,false);
  player.event({area:10,set:5,silence:[0,0],tracks:1});
  player.setNight(true);time.now=2000;player.update(10,true);
  assert.equal(requests.at(-1).night,true);assert.equal(requests.at(-1).track,false);
});
