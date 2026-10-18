import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initSync,Voyage} from './pkg/flats_racer_web.js';
import {WorldClient} from './world-client.js';
import {createContext,runInContext} from 'node:vm';
import {boundsWithin,transformedBounds,globalCollisionVertices,placementMatrix,SCENE_LIMITS} from './scene-stream.js';

const wasm=initSync({module:await readFile(new URL('./pkg/flats_racer_web_bg.wasm',import.meta.url))});
for(const speed of [250,500])for(const shift of [0,1e9]){
  const tile=1600/3;
  const manifest={version:1,label:'Confirmed global pose regression',sea_level:0,
    regions:[
      {id:'west',map:'Kalimdor',tile_origin:[41,33],tile_count:[1,1],placement:[shift,0]},
      {id:'east',map:'Azeroth',tile_origin:[28,51],tile_count:[1,1],placement:[shift+10000,0]}],
    tiles:[
      {region:0,x:41,y:33,file:'Kalimdor_41_33.adt',bytes:1,sha256:'a'.repeat(64)},
      {region:1,x:28,y:51,file:'Azeroth_28_51.adt',bytes:1,sha256:'a'.repeat(64)}],
    ocean:[shift+tile,0,shift+10000,tile],spawn:[shift+200,1.1,64,-Math.PI/2],
    destination:[shift+10200,64]};
  const world=new Voyage(JSON.stringify(manifest)),tuning=world.tuning();
  world.restore(new Float64Array([shift+700,1.1,64,-Math.PI/2]));
  tuning[0]=tuning[1]=speed;tuning[2]=speed*120;tuning[3]=tuning[5]=0;
  world.set_tuning(tuning);
  const client=new WorldClient(()=>{},error=>{throw error;});
  let previous,maxStep=0,maxRebaseStep=0,rebases=0;
  try{
    for(let i=0;i<360;i++){
      world.tick(1,0,0);
      const raw=Array.from(world.telemetry()),time=100+i*1000/120;
      client.recordPose({telemetry:raw,poseTime:time,scene:{waitingCollision:0}});
      const drawn=client.presentation(time);
      if(i>12){
        const step=drawn[0]-previous.drawn[0];
        maxStep=Math.max(maxStep,step);
        if(raw[13]!==previous.raw[13]){rebases++;maxRebaseStep=Math.max(maxRebaseStep,step);}
        assert(step>=-1e-3&&step<=speed/120+1e-3,`Origin-only rebase changed global motion: ${speed} yd/s, shift ${shift}, tick ${i}, step ${step}`);
        assert(Math.abs(raw[0]-drawn[0]-speed*.03)<1e-3,'Confirmed delay remains exactly30ms');
        assert.equal(drawn[11],raw[11],'Renderer origin remains the latest authoritative origin');
      }
      previous={raw,drawn};
    }
    assert(rebases>=2,'Actual Rust simulation must cross multiple floating origins');
    console.log(JSON.stringify({speed,shift,rebases,maxStep,maxRebaseStep}));
    if(speed===250&&shift===0)await fallingRoof(world);
  }finally{world.free();}
}

async function fallingRoof(world){
  const tuning=world.tuning();tuning[0]=36;tuning[1]=50;tuning[2]=18;tuning[3]=22;tuning[15]=100;
  world.set_tuning(tuning);
  const fall=()=>{
    world.restore(new Float64Array([700,1.1,64,0]));world.tick(0,0,8);
    let previous=world.telemetry()[1];
    for(let i=0;i<1500;i++){
      world.tick(0,0,0);const p=Array.from(world.telemetry());
      if(p[1]>20&&p[1]<23&&p[1]<previous)return p;
      previous=p[1];
    }
    throw Error('Actual hop did not produce the falling-roof trajectory');
  };
  const before=fall(),bounds=[[-66,-702,17],[-62,-698,17]];
  const point=[-before[2],-before[0],before[1]],horizontal=4+world.frame_sweep_distance();
  const vertical=4+world.frame_vertical_sweep_distance();
  assert(!boundsWithin(bounds,point,horizontal),'Old horizontal sphere misses the pending roof');
  assert(boundsWithin(bounds,point,horizontal,vertical));
  for(let i=0;i<12;i++)world.tick(0,0,0);
  const unguardedY=world.telemetry()[1];assert(unguardedY<17);
  assert.deepEqual(fall().slice(0,10),before.slice(0,10));
  const ticks=world.physics_stats()[0],events=[];
  const state={instances:[],collisionInstances:[],unresolvedCollision:[{id:'roof',kind:'group',boundsKnown:true,bounds}],
    assets:new Map(),textures:new Map()};
  const scene={revision:1,selectionRevision:1,update(){this.selectionRevision=this.revision;},
    snapshot:()=>state,async pump(){}};
  const context=createContext({performance,init:async()=>wasm,postMessage:message=>events.push(message),
    setTimeout,clearTimeout,boundsWithin,transformedBounds,globalCollisionVertices,SCENE_LIMITS});
  const worker=(await readFile(new URL('./world-worker.js',import.meta.url),'utf8')).replace(/^import .*;\r?$/gm,'');
  runInContext(worker,context);await runInContext('ready',context);
  context.dependencies={world,scene,manifest:{ocean:[10000,0,20000,0],
    regions:[{placement:[0,0],tile_origin:[32,32]}]}};
  runInContext(`({world,scene,manifest}=dependencies);horizon={wasmPeakBytes:0};source={stats:{}};
    terrain={snapshot:()=>({errors:[]})};stream=async()=>{};prepareDistant=()=>{};
    postFrameVisuals=true;startOptionalWork=()=>{};`,context);
  const frame=async id=>{
    context.onmessage({data:{id,action:'frame',dt:.1,throttle:0,steer:0,flags:0}});
    await runInContext('queue',context);
    const reply=events.find(e=>e.id===id);assert(reply);assert(!reply.error,reply.error);return reply.result;
  };
  const waiting=await frame(1);
  assert.equal(waiting.scene.waitingCollision,1);
  assert.equal(world.physics_stats()[0],ticks,'Pending roof must hold before any numerical tick');
  assert.deepEqual(Array.from(waiting.telemetry).slice(0,10),before.slice(0,10));
  const instance={id:'roof',key:'roof',kind:'group',bounds,boundsKnown:true,
    matrix:placementMatrix({position:[-64,-700,17],rotation:[0,180,0],scale:1})};
  state.instances.push(instance);state.collisionInstances.push(instance);state.unresolvedCollision=[];
  state.assets.set('roof',{vertices:new Float32Array(),indices:new Uint32Array(),batches:[],
    collisionVertices:new Float32Array([-2,-2,0,2,-2,0,0,2,0]),collisionIndices:new Uint32Array([0,1,2])});
  scene.revision++;
  const loaded=await frame(2);
  assert.equal(loaded.scene.waitingCollision,0);
  assert(world.physics_stats()[0]>ticks);
  assert(loaded.telemetry[1]>=17,'Admitted exact collision must prevent passing through the roof');
  console.log(JSON.stringify({fallingY:before[1],unguardedY,horizontal,vertical,guardedY:loaded.telemetry[1]}));
}
