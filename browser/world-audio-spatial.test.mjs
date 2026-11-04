import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldAudio} from './world-audio.js';
import {CREATURE_SOUND as C} from './creature-sound.js';

// A fake AudioContext that records the graph so the death-cry path can be checked without a browser.
function fake({decode=async()=>({duration:1}),state='running'}={}){
  const made=[],node=extra=>({connect(){},disconnect(){},...extra}),param=()=>({value:0});
  const ctx={state,currentTime:0,decodes:0,
    listener:{positionX:param(),positionY:param(),positionZ:param(),forwardX:param(),forwardY:param(),forwardZ:param(),upX:param(),upY:param(),upZ:param()},
    decodeAudioData(b){ctx.decodes++;return decode(b);},
    createPanner(){const p=node({positionX:param(),positionY:param(),positionZ:param()});made.push(p);return p;},
    createGain(){return node({gain:param()});},
    createBufferSource(){const s=node({start(){this.started=true;},started:false});made.push(s);return s;}};
  const audio=new WorldAudio();audio.context=ctx;audio.enabled=true;audio.analyser=node();
  return {audio,ctx,sources:()=>made.filter(n=>'started' in n),panners:()=>made.filter(n=>'positionX' in n)};
}
const view={eye:[0,0,0],look:[0,0,-1],up:[0,1,0]},bytes=()=>new Uint8Array([1,2,3]);

test('death cry plays at full gain with no distance rolloff or cutoff, however far',async()=>{
  const {audio,panners}=fake();
  for(const d of [5,500,50000]){assert.equal(await audio.spatial(`k${d}`,bytes(),[d,0,0],view),true);}
  for(const p of panners()){assert.equal(p.rolloffFactor,0);assert.equal(p.distanceModel,'linear');assert.ok(p.maxDistance>=1e9);}
  assert.equal(audio.lastSpatial.reason,'played');
});

test('a later kill of the same file plays even when the first message was dropped or arrived while muted',async()=>{
  const {audio,sources}=fake();
  audio.enabled=false;
  assert.equal(await audio.spatial('wolf',bytes(),[1,0,0],view),false);assert.equal(audio.lastSpatial.reason,'disabled');
  audio.enabled=true;
  assert.equal(await audio.spatial('wolf',bytes(),[1,0,0],view),true,'bytes ride along with every event, so this decodes and plays');
  assert.equal(sources().length,1);
});

test('a failed decode is not remembered: the next kill with bytes retries it',async()=>{
  let fail=true;const {audio,ctx}=fake({decode:async()=>{if(fail)throw Error('bad');return {duration:1};}});
  assert.equal(await audio.spatial('k',bytes(),[1,0,0],view),false);assert.equal(audio.lastSpatial.reason,'decode-failed');
  fail=false;
  assert.equal(await audio.spatial('k',bytes(),[1,0,0],view),true);assert.equal(ctx.decodes,2);
});

test('two kills while the first decode is still in flight both play, decoding once',async()=>{
  let finish;const {audio,ctx,sources}=fake({decode:()=>new Promise(r=>{finish=()=>r({duration:1});})});
  const a=audio.spatial('k',bytes(),[1,0,0],view),b=audio.spatial('k',bytes(),[2,0,0],view);
  finish();assert.deepEqual(await Promise.all([a,b]),[true,true]);assert.equal(ctx.decodes,1);assert.equal(sources().length,2);
});

test('suspended context and missing eye are reported, not thrown',async()=>{
  const s=fake({state:'suspended'});
  assert.equal(await s.audio.spatial('k',bytes(),[1,0,0],view),false);assert.equal(s.audio.lastSpatial.reason,'suspended');
  const r=fake();assert.equal(await r.audio.spatial('k',bytes(),[1,0,0],{}),false);assert.equal(r.audio.lastSpatial.reason,'no-eye');
  assert.equal(await r.audio.spatial('new',undefined,[1,0,0],view),false);assert.equal(r.audio.lastSpatial.reason,'no-bytes');
});

test('voice cap holds and cannot leak: slots free on ended, and by timer when ended never fires',async()=>{
  const {audio,sources}=fake();
  for(let i=0;i<C.maxVoices;i++)assert.equal(await audio.spatial('k',bytes(),[1,0,0],view),true);
  assert.equal(await audio.spatial('k',bytes(),[1,0,0],view),false);assert.equal(audio.lastSpatial.reason,'voices');
  sources()[0].onended();sources()[0].onended();
  assert.equal(audio.spatialVoices,C.maxVoices-1,'ended is idempotent');
  assert.equal(await audio.spatial('k',bytes(),[1,0,0],view),true);
  // A suspended context never fires `ended`; the fallback timer reclaims the slots.
  await new Promise(r=>setTimeout(r,3100));
  assert.equal(audio.spatialVoices,0);
});

test('a source that throws on start gives its slot back',async()=>{
  const {audio,ctx}=fake();
  ctx.createBufferSource=()=>({connect(){},disconnect(){},start(){throw Error('x');}});
  assert.equal(await audio.spatial('k',bytes(),[1,0,0],view),false);assert.equal(audio.spatialVoices,0);
});
