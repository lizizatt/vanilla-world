import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collisionFixture,frameFixture,runInContext} from './world-worker-fixtures.mjs';

test('invalid orbital controls fail at the worker boundary before physics',async()=>{
  const f=frameFixture();
  await f.dispatch({id:1,action:'frame',dt:.025,throttle:0,steer:0,flags:0,podControl:{active:true,mouse:[NaN,0],stick:[0,0]}});
  assert.match(f.events.find(e=>e.id===1).error,/Invalid orbital pod control/);
  assert.equal(f.events.filter(e=>e.event==='tick').length,0);
});
test('releasing a journey returns a fresh snapshot without stale charge or SOI authority',async()=>{
  const f=frameFixture();
  runInContext("pod.journey={parent:'azeroth'};pod.remaining=9;pod.hold=1;",f.context);
  await f.dispatch({id:1,action:'pod-release'});
  const state=f.events.find(e=>e.id===1).result;
  assert.equal(state.pod.journey,null);assert.equal(state.pod.remaining,0);assert.equal(state.pod.hold,0);
});

test('frame pitch reaches every fixed tick and invalid pitch is rejected before physics',async()=>{
  const f=frameFixture(),pitches=[];
  f.context.dependencies.world.tick=(_throttle,_steer,_flags,pitch)=>pitches.push(pitch);
  await f.dispatch({id:1,action:'frame',dt:.025,throttle:1,steer:0,flags:2,pitch:.7});
  assert.deepEqual(pitches,[.7,.7,.7]);
  await f.dispatch({id:2,action:'frame',dt:.01,throttle:1,steer:0,flags:2,pitch:NaN});
  assert.match(f.events.find(e=>e.id===2).error,/Pitch must be finite/);
  assert.equal(pitches.length,3);
});

test('only explicit open capability true enables resource-only instance deltas',async()=>{
  for(const capability of [undefined,false,'true',1,true]) {
    const f=collisionFixture();
    f.context.openAssetSource=async()=>{throw new Error('Stop after capability negotiation');};
    await assert.rejects(f.request({action:'open',sceneInstanceDeltas:capability}),/Stop after capability/);
    assert.equal(runInContext('sceneInstanceDeltas',f.context),capability===true);
  }
});

test('post-response visuals require a separate explicit capability',async()=>{
  for(const capability of [undefined,false,'true',1,true]) {
    const f=collisionFixture();
    f.context.openAssetSource=async()=>{throw new Error('Stop after capability negotiation');};
    await assert.rejects(f.request({action:'open',sceneInstanceDeltas:true,postFrameVisuals:capability}),/Stop after capability/);
    assert.equal(runInContext('postFrameVisuals',f.context),capability===true);
  }
});

test('ordered instance updates require a separate explicit capability',async()=>{
  for(const capability of [undefined,false,'true',1,true]) {
    const f=collisionFixture();
    f.context.openAssetSource=async()=>{throw new Error('Stop after capability negotiation');};
    await assert.rejects(f.request({action:'open',sceneInstanceUpdates:capability}),/Stop after capability/);
    assert.equal(runInContext('sceneInstanceUpdates',f.context),capability===true);
  }
});

test('hop edges survive zero ticks, are examined once, and are not buffered until landing',async()=>{
  const f=frameFixture(),flags=[];
  f.context.dependencies.world.tick=(_throttle,_steer,value)=>flags.push(value);
  const send=(id,dt,hop,held=0)=>f.dispatch({id,action:'frame',dt,hop,throttle:0,steer:0,flags:held});
  const ack=id=>f.events.find(e=>e.id===id).result.hopConsumed;
  await send(1,.003,1);
  assert.deepEqual(flags,[]);assert.equal(ack(1),0);
  await send(2,.014,1);
  assert.deepEqual(flags,[8,0]);assert.equal(ack(2),1);
  assert.equal(f.body[7],0,'Even an airborne numerical attempt consumes the edge');
  f.body[7]=1;
  await send(3,1/120,1);
  assert.equal(flags.at(-1),0,'Landing cannot replay an acknowledged press');
  await send(4,.025,2,8);
  assert.deepEqual(flags.slice(-3),[8,8,8]);assert.equal(ack(4),2);
  await send(5,1/120,2);
  assert.equal(flags.at(-1),0);
  await send(6,.01,-1);
  assert.match(f.events.find(e=>e.id===6).error,/Invalid hop sequence/);
});

test('pose timestamps describe fixed ticks in the input clock and do not advance on zero-step replies',async()=>{
  const f=frameFixture();
  const frame=async(id,dt,sampleTime)=>{
    await f.dispatch({id,action:'frame',dt,sampleTime,throttle:1,steer:0,flags:0});
    return f.events.find(e=>e.id===id);
  };
  assert.equal((await frame(1,.006,1006)).result.poseTime,1000);
  assert.equal((await frame(2,.001,1007.2)).result.poseTime,1000);
  assert(Math.abs((await frame(3,.003,1010)).result.poseTime-(1000+1000/120))<1e-9);
  assert(Math.abs((await frame(4,.006,1016.2)).result.poseTime-(1000+1000/120))<1e-9);
  assert.equal((await frame(5,.001,undefined)).result.poseTime,undefined,'Legacy frames do not claim a clock');
  assert.match((await frame(6,.001,NaN)).error,/Invalid input sample time/);
});

test('post-response failure surfaces once, blocks subsequent physics and retries only explicitly',async()=>{
  const f=frameFixture();
  f.add(100);
  const push=f.events.push.bind(f.events);let reject=true;
  f.events.push=event=>{
    if(event.event==='scene' && reject){reject=false;throw new Error('Deferred scene publication failed');}
    return push(event);
  };
  await f.frame(1);
  assert.equal(f.events.filter(e=>e.id===1).length,1);
  assert(f.events.find(e=>e.id===1).result);
  assert.match(f.events.find(e=>e.event==='world-error').error,/Deferred scene publication failed/);
  assert.equal(f.events.some(e=>e.event==='pump'),false);
  await f.frame(2);
  assert.match(f.events.find(e=>e.id===2).error,/Deferred scene publication failed/);
  assert.equal(f.events.filter(e=>e.event==='tick').length,1);
  assert.equal(f.events.filter(e=>e.event==='world-error').length,1);
  await f.dispatch({id:3,action:'retry'});
  const sent=f.events.find(e=>e.event==='scene');
  assert.deepEqual(Array.from(sent.assets,a=>a.key),['100']);
  await f.frame(4);
  assert.equal(f.events.filter(e=>e.event==='tick').length,2);
});

test('visual tail finishes before the next queued physics request begins',async()=>{
  const f=frameFixture();
  f.add(100);
  await Promise.all([f.frame(1),f.frame(2)]);
  assert.deepEqual(f.events.map(e=>e.event||`reply:${e.id}`),
    ['collision','tick','reply:1','scene','pump','tick','reply:2','pump']);
});
