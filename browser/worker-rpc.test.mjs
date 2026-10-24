import test from 'node:test';
import assert from 'node:assert/strict';
import {RpcTable,errorFields,errorText,replyError,isRequestId} from './worker-rpc.js';

test('request ids are unique and a reply settles its entry exactly once',()=>{
  const table=new RpcTable(),a=table.open({}),b=table.open({});
  assert.notEqual(a,b);assert.equal(table.size,2);
  assert.ok(table.take(a));
  assert.equal(table.take(a),undefined,'a duplicate reply is ignored');
  assert.equal(table.take(999),undefined,'a stale or unknown id is ignored');
  assert.equal(table.size,1);
});

test('rejectAll settles every pending promise and leaves nothing behind',async()=>{
  const table=new RpcTable(),outcomes=[];
  const promises=[1,2,3].map(()=>new Promise((resolve,reject)=>table.open({resolve,reject})).catch(e=>outcomes.push(e.code)));
  table.rejectAll(Object.assign(Error('closed'),{code:'CLOSED'}));
  await Promise.all(promises);
  assert.deepEqual(outcomes,['CLOSED','CLOSED','CLOSED']);
  assert.equal(table.size,0);
});

test('errors cross the worker boundary as text plus code',()=>{
  const fields=errorFields(Object.assign(Error('boom'),{code:'DEFERRED'}));
  assert.deepEqual(fields,{error:'boom',code:'DEFERRED'});
  const rebuilt=replyError(fields);
  assert.ok(rebuilt instanceof Error);assert.equal(rebuilt.message,'boom');assert.equal(rebuilt.code,'DEFERRED');
  assert.equal(errorText('plain wasm string'),'plain wasm string','wasm throws strings, not Errors');
});

test('request ids must be positive safe integers',()=>{
  for(const bad of [0,-1,1.5,NaN,'1',undefined,2**53])assert.equal(isRequestId(bad),false);
  assert.equal(isRequestId(1),true);
});
