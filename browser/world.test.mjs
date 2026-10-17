import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldRenderer,renderMatrix,sceneSelection} from './world-renderer.js';
import {WorldClient} from './world-client.js';
import {validateWorldSave,LAYOUT_VERSION} from './world-store.js';
import {moveFlight,overview} from './flight.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function clientFixture(canFrame=()=>true) {
  const calls=[],errors=[],client=new WorldClient(()=>{},error=>errors.push(error),canFrame);
  client.worker={terminate(){}};
  client.request=(action,fields)=>new Promise((resolve,reject)=>calls.push({action,fields,resolve,reject}));
  return {client,calls,errors};
}
test('worker replies immediately drain one coalesced latest-input frame with the existing time cap',async()=>{
  const {client,calls}=clientFixture();
  client.frame(.01,1,0,0);
  client.frame(.02,.5,.1,1,[1,2,3],true);
  client.frame(.03,-1,.2,2,[4,5,6],false);
  assert.equal(calls.length,1);assert(client.inFlight);
  calls[0].resolve({pose:1});await settle();
  assert.equal(calls.length,2);assert.deepEqual(client.state,{pose:1});
  assert.deepEqual(calls[1].fields,{dt:.05,throttle:-1,steer:.2,flags:2,focus:[4,5,6],distant:false});
  client.frame(.09,1,0,0);client.frame(.09,0,0,1);
  calls[1].resolve({pose:2});await settle();
  assert.equal(calls.length,3);assert.equal(calls[2].fields.dt,.1);assert.equal(calls[2].fields.throttle,0);
  calls[2].resolve({pose:3});await settle();
  assert.equal(calls.length,3);assert(!client.inFlight);assert.equal(client.elapsed,0);
});
test('pause and frame failure discard queued time without retrying stale input',async()=>{
  let active=true;
  const {client,calls,errors}=clientFixture(()=>active);
  client.frame(.01,1,0,0);client.frame(.04,1,0,0);
  active=false;calls[0].resolve({pose:1});await settle();
  assert.equal(calls.length,1);assert.equal(client.elapsed,0);
  active=true;client.frame(.02,0,0,1);
  assert.equal(calls[1].fields.dt,.02);
  client.frame(.04,1,0,0);
  const failure=new Error('Scene unavailable');calls[1].reject(failure);await settle();
  assert.deepEqual(errors,[failure]);assert.equal(calls.length,2);assert.equal(client.elapsed,0);
});
test('old worker completion cannot clear or submit frames for a replacement world',async()=>{
  const {client,calls,errors}=clientFixture();
  client.frame(.01,1,0,0);client.frame(.04,1,0,0);client.stop();
  client.worker={terminate(){}};client.frame(.02,0,0,1);
  calls[0].reject(new Error('Old world failed'));await settle();
  assert(client.inFlight);assert.equal(calls.length,2);assert.deepEqual(errors,[]);
  calls[1].resolve({pose:'new'});await settle();
  assert.deepEqual(client.state,{pose:'new'});assert(!client.inFlight);
});
test('failed worker post does not retain an unanswerable request',async()=>{
  const client=new WorldClient(()=>{},()=>{});
  client.worker={postMessage(){throw new Error('Transfer failed');}};
  await assert.rejects(client.request('frame'),/Transfer failed/);
  assert.equal(client.requests.size,0);
});
test('new clients explicitly negotiate resource-only scene updates at open',async()=>{
  const old=globalThis.Worker,sent=[];
  globalThis.Worker=class {
    postMessage(message){
      sent.push(message);
      queueMicrotask(()=>this.onmessage({data:{id:message.id,result:{info:{},state:{}}}}));
    }
    terminate(){}
  };
  try{
    const client=new WorldClient(()=>{},error=>{throw error;});
    await client.open({kind:'fixture'});
    assert.equal(sent[0].action,'open');assert.equal(sent[0].sceneInstanceDeltas,true);assert.equal(sent[0].postFrameVisuals,true);
    client.stop();
  } finally{if(old===undefined)delete globalThis.Worker;else globalThis.Worker=old;}
});
test('post-response worker faults stop pending input and stale workers cannot fault a new world',async()=>{
  const old=globalThis.Worker,workers=[],errors=[],events=[];
  let active=true;
  globalThis.Worker=class {
    constructor(){workers.push(this);}
    postMessage(message){
      queueMicrotask(()=>this.onmessage({data:{id:message.id,result:{info:{},state:{}}}}));
    }
    terminate(){}
  };
  try{
    const client=new WorldClient(event=>events.push(event),error=>{errors.push(error.message);active=false;},()=>active);
    await client.open({kind:'first'});
    client.frame(.01,1,0,0);client.frame(.03,1,0,0);
    workers[0].onmessage({data:{event:'world-error',error:'Visual transfer failed'}});
    assert.deepEqual(errors,['Visual transfer failed']);assert.deepEqual(events,[]);
    assert.equal(client.pendingFrame,undefined);assert.equal(client.elapsed,0);
    await settle();assert(!client.inFlight);
    active=true;await client.open({kind:'second'});
    workers[0].onmessage({data:{event:'world-error',error:'Old failure'}});
    workers[0].onmessage({data:{event:'scene',instances:[]}});
    workers[0].onerror({message:'Old worker error'});
    assert.deepEqual(errors,['Visual transfer failed']);assert.deepEqual(events,[]);
    client.stop();
  } finally{if(old===undefined)delete globalThis.Worker;else globalThis.Worker=old;}
});
test('reset and restore invalidate unsent input and block draining until the new pose is returned',async()=>{
  for(const action of ['reset','restore']){
    const sent=[],client=new WorldClient(()=>{},error=>{throw error;});
    client.worker={postMessage:message=>sent.push(message)};
    const respond=(index,result)=>{
      const pending=client.requests.get(sent[index].id);
      client.requests.delete(sent[index].id);pending.resolve(result);
    };
    client.frame(.01,1,0,0);client.frame(.04,1,0,0);
    const transition=client.request(action,{pose:[10,20,30,0]});
    client.frame(.02,1,0,0);
    respond(0,{pose:'old'});await settle();
    assert.equal(sent.length,2);assert.equal(client.elapsed,0);assert(!client.pendingFrame);
    respond(1,{pose:'new'});await transition;
    client.frame(.03,0,0,1);
    assert.equal(sent.length,3);assert.equal(sent[2].dt,.03);assert.equal(sent[2].throttle,0);
    respond(2,{pose:'new'});await settle();
  }
});

test('source matrix uses the same east/up/south basis and preserves floating-origin precision',()=>{
  const matrix=[2,0,0,0,0,2,0,0,0,0,2,0,-100,-200,30,1];
  const r={placement:[1e9,-1e9],tile_origin:[32,32]};
  const out=renderMatrix(matrix,r,[1e9+199.875,-1e9+99.75]);
  assert.deepEqual([...out.slice(12)],[.125,30,.25,1]);
  assert.equal(out[2],-2);assert.equal(out[4],-2);assert.equal(out[9],2);
});
test('static instance matrices retain precision and refresh with origin, region and source',()=>{
  const renderer=Object.create(WorldRenderer.prototype);
  const instance={matrix:[1,0,0,0,0,1,0,0,0,0,1,0,-100,-200,30,1]};
  const region={placement:[1e9,-1e9],tile_origin:[32,32]},origin=[1e9+199.875,-1e9+99.75];
  const first=renderer.sceneMatrix(instance,region,origin);
  assert.equal(renderer.sceneMatrix(instance,region,origin),first);
  assert.deepEqual([...first.slice(12)],[.125,30,.25,1]);
  for(const [nextRegion,nextOrigin] of [[region,[origin[0]+256,origin[1]]],[{...region,placement:[0,0]},origin]]){
    const next=renderer.sceneMatrix(instance,nextRegion,nextOrigin);
    assert.notEqual(next,first);assert.deepEqual(next,renderMatrix(instance.matrix,nextRegion,nextOrigin));
  }
  instance.matrix=instance.matrix.map((n,i)=>i===14?n+1:n);
  assert.deepEqual(renderer.sceneMatrix(instance,region,origin),renderMatrix(instance.matrix,region,origin));
});
test('direct uniform packing matches shader layouts and cached bindings follow texture and geometry changes',()=>{
  const renderer=Object.create(WorldRenderer.prototype),texture=()=>({createView:()=>({})});
  const region={placement:[1e9,-1e9],tile_origin:[32,32]},origin=[1e9,-1e9];
  const instance={id:'model:1',key:'model',kind:'m2',matrix:[1,0,0,0,0,1,0,0,0,0,1,0,-3,-4,8,1]};
  const asset={vertices:{},indices:{},bytes:48,batches:[{texture:'model.blp',indexCount:3,firstIndex:0,
    blend:'opaque',transparent:false,pipeline:{},alphaCutoff:.5,emissive:true}]};
  const horizon={placement:[origin[0]+32,origin[1]+48],region:0,near:5,cell:9};
  const detail={placement:[origin[0]+64,origin[1]+80],edgeMask:3,cell:10};
  let groups=0;
  Object.assign(renderer,{canvas:{clientWidth:128,clientHeight:64,width:128,height:64},depth:texture(),
    context:{getCurrentTexture:texture},device:{queue:{writeBuffer(){},submit(){}},
      createSampler:()=>({}),createBindGroup:()=>({id:++groups}),
      createCommandEncoder:()=>({beginRenderPass:()=>({end(){}}),finish:()=>({})})},
    uploadMaterials(){},drawTerrain(_pass,items){this.drawnTerrain=items;},drawScene(_pass,draws){this.drawnScene=draws;},
    uniformData:new Float32Array(16384*64),frameUniforms:{},body:{placement:[0,0]},
    horizon:[horizon],tiles:new Map([[1,detail]]),seams:new Map(),water:[],
    instances:[instance],assets:new Map([['model',asset]]),textures:new Map([['model.blp',texture()]]),
    items:new Map(),white:texture(),manifest:{regions:[region]},sceneRegion:0,
    materialPending:new Map(),minimapAtlases:[]});
  const state=[origin[0]+.125,20,origin[1]+.25,.4,.2,0,0,1,0,0,0,...origin];
  const old=globalThis.devicePixelRatio;globalThis.devicePixelRatio=1;
  try{
    renderer.draw(state,undefined,1/60,123,{horizon:true,scenery:true});
    const u=renderer.uniformData,view=[...u.slice(0,16)],p=[.125,20,.25];
    for(const item of renderer.drawnTerrain){
      const body=item===renderer.body,base=item.offset/4;
      assert.deepEqual(u.slice(base,base+28),new Float32Array([...view,...p,body?state[3]:(item.edgeMask||0),
        2,123,state[4],.1,body?0:item.placement[0]-origin[0],0,body?0:item.placement[1]-origin[1],item.cell??-1]));
    }
    const base=renderer.drawnScene[0].item.offset/4;
    assert.deepEqual(u.slice(base,base+40),new Float32Array([...view,2,123,0,.1,
      ...renderMatrix(instance.matrix,region,origin),.5,1,0,0]));
    renderer.draw(state,undefined,1/60,124,{horizon:true,scenery:true});assert.equal(groups,1);
    renderer.textures.set('model.blp',texture());
    renderer.draw(state,undefined,1/60,125,{horizon:true,scenery:true});assert.equal(groups,2);
    renderer.assets.set('model',{...asset,vertices:{}});
    renderer.draw(state,undefined,1/60,126,{horizon:true,scenery:true});assert.equal(groups,3);
  } finally{if(old===undefined)delete globalThis.devicePixelRatio;else globalThis.devicePixelRatio=old;}
});
test('GPU scene budget retains a nearest-first prefix below two million triangles',()=>{
  const instances=Array.from({length:12},(_,id)=>({id,key:'model'}));
  const assets=new Map([['model',{batches:[{indexCount:600000}]}]]);
  const selection=sceneSelection(instances,assets);
  assert.equal(selection.triangles,2000000);assert.equal(selection.omitted,2);
  assert.deepEqual(selection.selected.map(i=>i.id),[0,1,2,3,4,5,6,7,8,9]);
  assets.set('model',{batches:Array.from({length:1000},()=>({indexCount:3}))});
  assert.equal(sceneSelection(instances,assets).selected.length,4);
});
test('save validation isolates source/layout and rejects malformed flight/vehicle state',()=>{
  const save={version:1,layout:LAYOUT_VERSION,sourceId:'install-a',mode:'drive',
    vehicle:[0,2,0,0],settings:{horizon:true,scenery:true}};
  assert.doesNotThrow(()=>validateWorldSave(save,'install-a'));
  assert.doesNotThrow(()=>validateWorldSave({...save,settings:{...save.settings,distant:false}},'install-a'));
  assert.doesNotThrow(()=>validateWorldSave({...save,settings:{...save.settings,controls:'native',cameraDistance:0,sound:true}},'install-a'));
  for(const invalid of [{...save,sourceId:'b'},{...save,layout:2},{...save,vehicle:[0,NaN,0,0]},
    {...save,mode:'fly',camera:[0,200000,0,0,0]},{...save,settings:{}},
    {...save,settings:{...save.settings,distant:'yes'}},{...save,settings:{...save.settings,controls:'unknown'}},
    {...save,settings:{...save.settings,cameraDistance:Infinity}},{...save,settings:{...save.settings,sound:'yes'}}]) {
    assert.throws(()=>validateWorldSave(invalid,'install-a'),/retained/);
  }
  assert.equal(save.vehicle[1],2);
});
test('flight keyboard movement and overview include translated complete continents',()=>{
  const p=[0,30,0,0,0],q=moveFlight(p,new Set(['KeyW','ShiftLeft']),.1);
  assert.deepEqual(p,[0,30,0,0,0]);assert.equal(q[2],-800);
  const m={regions:[{placement:[0,0],tile_origin:[0,0]},{placement:[30000,11200],tile_origin:[0,0]}],
    horizons:[{region:0,source_bounds:[0,0,50,56]},{region:1,source_bounds:[0,0,20,42]}]};
  const view=overview(m);assert(Math.abs(view[0]-20333.3333333333)<.001);
  assert(Math.abs(view[1]-30500)<.001 && Math.abs(view[2]-30626.6666666667)<.001);
});
