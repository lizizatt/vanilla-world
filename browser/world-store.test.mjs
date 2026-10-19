import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const code=(await readFile(new URL('./world-store.js',import.meta.url),'utf8')).replaceAll('export ','');
function store() {
  const opens=[],records=new Map(),transactions=[];
  const context=createContext({indexedDB:{open(){
    const request={};opens.push(request);
    const db={closed:false,close(){this.closed=true;},transaction(name,mode){
      assert(!this.closed);
      const tx={objectStore:()=>({
        get:key=>({result:records.get(key)}),
        put:(value,key)=>{records.set(key,value);return {result:key};},
      })};
      transactions.push({name,mode,tx});queueMicrotask(()=>tx.oncomplete());return tx;
    }};
    request.result=db;queueMicrotask(()=>request.onsuccess());return request;
  }}});
  runInContext(code+'\nglobalThis.api={worldSave,worldTuning,worldLiquids};',context);
  return {...context.api,opens,transactions,records};
}
test('liquids and saved overrides share one asynchronous connection while preserving save and tuning keys',async()=>{
  const s=store();
  await Promise.all([s.worldSave('install',{pose:1}),s.worldTuning('install',{speed:150}),
    s.worldLiquids('install','0:1:2',new Float32Array([1,2,3]))]);
  assert.equal(s.opens.length,1);assert.equal(s.transactions.length,3);
  assert.deepEqual([...s.records.keys()].sort(),['3:install','liquids:2:install:0:1:2','tuning:3:install']);
  assert.equal((await s.worldTuning('install')).speed,150);
  assert.equal(s.opens.length,1);assert(!s.opens[0].result.closed);
  s.opens[0].result.onversionchange();assert(s.opens[0].result.closed);
  assert.equal((await s.worldSave('install')).pose,1);assert.equal(s.opens.length,2);
  s.opens[1].result.onclose();await s.worldSave('install');assert.equal(s.opens.length,3);
});

test('blocked or failed opens stay explicit and cannot leave a late untracked connection alive',async()=>{
  const requests=[],context=createContext({indexedDB:{open(){const request={};requests.push(request);return request;}}});
  runInContext(code+'\nglobalThis.open=database;',context);
  const blocked=context.open(),checked=assert.rejects(blocked,/blocked by another tab/);
  requests[0].onblocked();await checked;
  const replacement=context.open();
  let closed=false;requests[0].result={close(){closed=true;}};
  requests[0].onsuccess();assert(closed);
  requests[1].error=Error('storage unavailable');
  const failed=assert.rejects(replacement,/storage unavailable/);requests[1].onerror();await failed;
  const recovered=context.open(),db={close(){}};
  requests[2].result=db;requests[2].onsuccess();
  assert.equal(await recovered,db);assert.equal(await context.open(),db);assert.equal(requests.length,3);
});
