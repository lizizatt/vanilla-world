import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldClient} from './world-client.js';

const fakeWorker=name=>({name,sent:[],postMessage(m){this.sent.push(m);}});

test('swap exchanges resident worlds but keeps each client\'s handlers and role', async () => {
  const near=[],far=[],a=new WorldClient(e=>{near.push(e.event);return true;},()=>{}),b=new WorldClient(e=>{far.push(e.event);return false;},()=>{});
  const wa=fakeWorker('azeroth'),wb=fakeWorker('elune');
  a.worker=wa;a.bind(wa);a.info={id:'azeroth'};a.bodyId='azeroth';
  b.worker=wb;b.bind(wb);b.info={id:'elune'};b.farOnly=true;b.bodyId='elune';
  a.swap(b);
  assert.equal(a.worker,wb);assert.equal(b.worker,wa);
  assert.equal(a.info.id,'elune');assert.equal(b.info.id,'azeroth');
  assert.equal(a.farOnly,undefined,'farOnly is a role and stays with the client object');
  assert.equal(b.farOnly,true);
  wb.onmessage({data:{event:'tile'}});wa.onmessage({data:{event:'tile'}});
  assert.deepEqual(near,['tile'],'the Elune worker now feeds the near (renderer) handler');
  assert.deepEqual(far,['tile'],'the Azeroth worker now feeds the far-only handler');
  const p=a.request('tuning',{values:[1]});
  assert.equal(wb.sent.at(-1).action,'tuning');
  wb.onmessage({data:{id:wb.sent.at(-1).id,result:{ok:1}}});
  assert.deepEqual(await p,{ok:1});
  assert.equal(a.bodyId,'elune');assert.equal(b.bodyId,'azeroth');
});

test('swap drops in-flight frames and stale replies from the old worker', () => {
  const a=new WorldClient(()=>true,()=>{}),b=new WorldClient(()=>false,()=>{}),wa=fakeWorker('a'),wb=fakeWorker('b');
  a.worker=wa;a.bind(wa);b.worker=wb;b.bind(wb);a.inFlight=true;a.pendingFrame={};
  a.swap(b);
  assert.equal(a.inFlight,false);assert.equal(a.pendingFrame,undefined);
  assert.doesNotThrow(()=>wa.onmessage({data:{id:999,result:{}}}));
});

test('returning to the same worker cannot revive an earlier role frame', async () => {
  const errors=[],a=new WorldClient(()=>true,e=>errors.push(e)),b=new WorldClient(()=>false,e=>errors.push(e));
  const wa=fakeWorker('a'),wb=fakeWorker('b');
  a.worker=wa;a.bind(wa);b.worker=wb;b.bind(wb);
  a.state={marker:'current'};
  a.frame(.01,0,0,0);
  const old=wa.sent.at(-1);
  a.swap(b);a.swap(b);
  a.frame(.01,0,0,0);
  const current=wa.sent.at(-1);
  assert.notEqual(current.id,old.id);
  wa.onmessage({data:{id:old.id,result:{marker:'stale',telemetry:Array(15).fill(0)}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.state.marker,'current','ABA worker identity is not role ownership');
  assert.equal(a.inFlight,true,'Old completion cannot release the new frame guard');
  wa.onmessage({data:{id:current.id,result:{marker:'new',telemetry:Array(15).fill(0)}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.state.marker,'new');assert.equal(a.inFlight,false);
  assert.deepEqual(errors,[]);
});

test('queued old replay events cannot reach the consumer before its latest rebind boundary',async()=>{
  const events=[],errors=[],a=new WorldClient(e=>{events.push(e);return true;},e=>errors.push(e)),
    b=new WorldClient(()=>false,e=>errors.push(e)),wa=fakeWorker('a'),wb=fakeWorker('b');
  a.worker=wa;a.bind(wa);b.worker=wb;b.bind(wb);
  const first=a.request('rebind'),old=wa.sent.at(-1).id;
  a.swap(b);a.swap(b);
  const second=a.request('rebind'),current=wa.sent.at(-1).id;
  wa.onmessage({data:{event:'renderer-bound',id:old}});
  wa.onmessage({data:{event:'horizon',near:1}});
  wa.onmessage({data:{event:'horizon-index',region:0}});
  wa.onmessage({data:{event:'far-scene',token:3,producer:2}});
  assert.deepEqual(events,[]);
  assert.deepEqual(wa.sent.at(-1),{action:'far-ack',token:3,producer:2},'Discarded old transfers still release producer backpressure');
  wa.onmessage({data:{event:'sky'}});
  wa.onmessage({data:{event:'renderer-bound',id:current}});
  wa.onmessage({data:{event:'horizon',near:2}});
  assert.deepEqual(events,[{event:'sky'},{event:'horizon',near:2}]);
  wa.onmessage({data:{id:old,result:{}}});wa.onmessage({data:{id:current,result:{}}});
  await Promise.all([first,second]);assert.deepEqual(errors,[]);
});
