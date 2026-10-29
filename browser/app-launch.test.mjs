import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

const source=(await readFile(new URL('./app-launch.js',import.meta.url),'utf8'))
  .replace(/^import [^;]*;\r?\n/gm,'').replace(/^export /gm,'');
function fixture(){
  let body='elune',swaps=0;
  const errors=[],snapshot=c=>({pod:structuredClone(c.worker.pod)});
  const client=id=>{
    const c={worker:{pod:{journey:null,remaining:0,spent:[]}},info:{id},discardFrame(){},clearPose(){},
      async request(action,value){
        if(action==='pod-adopt')this.worker.pod=structuredClone(value.pod);
        if(action==='pod-release')Object.assign(this.worker.pod,{journey:null,remaining:0,hold:0});
        return snapshot(this);
      }};
    c.state=snapshot(c);return c;
  };
  const app={client:client('elune'),engines:{azeroth:client('azeroth')},editor:{},
    renderer:{setLaunchProps(){this.launchProps=[];}},fail:e=>errors.push(e),prepareEngines:Promise.resolve(),
    async soiSwap(target){
      swaps++;
      const other=this.engines[target],previous=body;
      for(const key of ['worker','info','state']){const saved=this.client[key];this.client[key]=other[key];other[key]=saved;}
      delete this.engines[target];this.engines[previous]=other;body=target;return true;
    }};
  const context=createContext({structuredClone,activeBody:()=>({id:body}),launchObjects:async()=>[],
    validateLaunchObjects:x=>x,launchAsset:()=>{},simEpoch:{days:0},DAY_PERIOD:1440,wrapTime:t=>t,app});
  runInContext(source+'\ninstallLaunch(app);',context);
  return {app,errors,swaps:()=>swaps,body:()=>body};
}

test('automatic handoff clears the parked snapshot before a manual return can re-swap',async()=>{
  const f=fixture(),{app}=f;
  app.client.state.pod={journey:{parent:'azeroth',time:720},remaining:4,spent:[]};
  app.client.worker.pod=structuredClone(app.client.state.pod);
  assert.equal(app.launchFrame(),true);await app.podSwap;
  assert.equal(f.body(),'azeroth');
  assert.equal(app.engines.elune.state.pod.journey,null);
  assert.equal(app.engines.elune.state.pod.remaining,0);
  await app.launch.cancel();
  await app.launch.swap('elune');
  assert.equal(app.launchFrame(),false);assert.equal(f.body(),'elune');assert.equal(f.swaps(),2);
  assert.equal(app.client.state.pod.journey,null);assert.equal(app.client.state.pod.remaining,0);
  assert.deepEqual(f.errors,[]);
});

test('manual cancellation waits for an in-flight handoff and clears both authorities and cached snapshots',async()=>{
  const f=fixture(),{app}=f;
  app.client.state.pod={journey:{parent:'azeroth',time:720},remaining:9,spent:[]};
  app.client.worker.pod=structuredClone(app.client.state.pod);
  app.launchFrame();
  const cancelled=app.launch.cancel();
  assert.equal(app.launch.cancel(),cancelled);
  assert.equal(app.launchFrame(),true);
  await cancelled;
  for(const client of [app.client,...Object.values(app.engines)]){
    assert.equal(client.worker.pod.journey,null);assert.equal(client.state.pod.journey,null);
    assert.equal(client.worker.pod.remaining,0);assert.equal(client.state.pod.remaining,0);
  }
  assert.equal(app.swapHold,false);assert.equal(app.podCancel,undefined);
  assert.deepEqual(f.errors,[]);
});
