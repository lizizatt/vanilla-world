import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {WorldClient} from './world-client.js';
import {ARRIVAL,arrivalReadiness} from './loading-gate.js';

const code=(await readFile(new URL('./app-loading.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'');

function arrivalFixture(request,{timeout=false}={}) {
  const elements=new Map(),warnings=[],messages=[];
  const element=id=>{
    if(!elements.has(id))elements.set(id,{open:false,textContent:'',addEventListener(){},setAttribute(){},removeAttribute(){},
      showModal(){this.open=true;},close(){this.open=false;},focus(){}});
    return elements.get(id);
  };
  const app={canvas:element('world'),evidence:{},settings:{},loading:element('loading-screen'),
    loadingArt:{progress(){}},renderer:{tiles:new Map(),assets:new Map(),textures:new Map(),uploadMaterials(){}},
    client:{worker:{},roleGeneration:0,bodyId:'azeroth',discardFrame(){},
      request(action,fields){messages.push({action,...fields});return request(action,fields);}}};
  const context=createContext({ARRIVAL,arrivalReadiness,performance,DOMException,URLSearchParams,
    document:{getElementById:element},console:{warn:message=>warnings.push(message)},
    setTimeout:(fn,ms)=>setTimeout(fn,timeout&&ms===ARRIVAL.timeoutMs?0:ms),clearTimeout});
  runInContext(code,context);context.installLoading(app);
  return {app,messages,warnings,context};
}
const readyState=()=>({resident:[],arrival:{tiles:[],ground:true,waiting:0,
  resources:{selected:true,roots:[],keys:[],textures:[],loaded:0,critical:0,models:0,npcs:0}}});

test('arrival keeps the modal and zero-input stream pump active through placement and readiness',async()=>{
  const f=arrivalFixture(async()=>readyState());
  const result=await f.app.arrival(async()=>{
    assert(f.app.arriving);assert(f.app.loading.open);assert(f.app.evidence.loading.active);
    return 42;
  });
  assert.equal(result,42);assert.equal(f.app.evidence.loading.ready,true);
  assert.equal(f.app.arriving,false);assert.equal(f.app.loading.open,false);
  assert.equal(f.app.evidence.loading.active,false);
  assert(f.messages.length>=2);
  for(const m of f.messages){assert.equal(m.dt,0);assert.equal(m.throttle,0);assert.equal(m.steer,0);assert.equal(m.flags,0);assert.equal(m.loading,true);}
});

test('readiness deadline releases a stalled stream reply with a warning and no false ready signal',async()=>{
  let requests=0;
  const f=arrivalFixture(()=>++requests===1?Promise.resolve(readyState()):new Promise(()=>{}),{timeout:true});
  await f.app.arrival(async()=>{});
  assert.equal(f.app.evidence.loading.ready,false);assert.equal(f.app.evidence.loading.timedOut,true);
  assert.equal(f.app.loading.open,false);assert.equal(f.app.arriving,false);
  assert.match(f.warnings[0],/collision safety holds/);
});

test('automatic SOI handoff bypasses the modal while explicit body changes use it',async()=>{
  const f=arrivalFixture(async()=>readyState());
  runInContext('soiSwap=async(app,id)=>{app.swapped=id;return true;}',f.context);
  assert.equal(await f.app.soiSwap('elune',{seamless:true}),true);
  assert.equal(f.messages.length,0);assert.equal(f.app.evidence.loading,undefined);
  await f.app.soiSwap('azeroth');
  assert(f.messages.length>0);assert.equal(f.app.evidence.loading.ready,true);
});

test('inactive horizon events follow the swapped engine body instead of its initial moon',async()=>{
  const bodies={azeroth:{id:'azeroth'},elune:{id:'elune',rail:{}}},received=[];
  let active=bodies.azeroth;
  class Client extends WorldClient {
    async open(){this.worker={};this.info={};}
  }
  const context=createContext({WorldClient:Client,BODIES:bodies,bodiesEnabled:()=>true,
    activeBody:()=>active,location:{search:''},console});
  runInContext(code,context);
  const app={renderer:{bodyEvent:(body,data)=>received.push([body.id,data.event]),
    prepareBody:async()=>{}},client:new Client(()=>true,()=>{})};
  app.client.bodyId='azeroth';app.client.worker={};
  await context.openMoonEngine(app,[]);
  const engine=app.engines.elune;
  engine.onEvent({event:'horizon'});assert.deepEqual(received,[['elune','horizon']]);
  app.client.swap(engine);active=bodies.elune;
  engine.onEvent({event:'horizon-material'});
  assert.deepEqual(received.at(-1),['azeroth','horizon-material']);
  assert.equal(app.engineCounts.azeroth.events,1);
});
