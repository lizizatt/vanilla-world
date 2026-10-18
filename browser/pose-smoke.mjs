import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initSync,Voyage} from './pkg/flats_racer_web.js';
import {WorldClient} from './world-client.js';

initSync({module:await readFile(new URL('./pkg/flats_racer_web_bg.wasm',import.meta.url))});
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
  }finally{world.free();}
}
