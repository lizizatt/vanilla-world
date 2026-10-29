import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {WorldClient} from './world-client.js';

const code=(await readFile(new URL('./app-loading.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'');

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
