import {activeBody} from './body-shaders.js';
import {launchObjects} from './world-store.js';
import {validateLaunchObjects,launchAsset} from './pod-launch.js';
import {simEpoch,DAY_PERIOD,wrapTime} from './sim-clock.js';

export function installLaunch(app) {
  let key,list=[],loading,drawKey,loadError,saving=false;
  const body=()=>activeBody().id;
  const draw=()=>{
    const spent=new Set(app.client.state?.pod?.spent||[]);
    app.renderer.setLaunchProps(list.filter(o=>!spent.has(o.id)).map(o=>({
      asset:launchAsset(o),textures:[],pos:o.pos,yaw:o.yaw,scale:1,space:'world'
    })));
    drawKey=JSON.stringify([...spent]);
  };
  const ready=async()=>{
    const current=`${app.client.info.id}:${body()}`;
    if(current===key)return loading;
    key=current;list=[];drawKey=undefined;loadError=undefined;
    const owner=app.client.worker,id=app.client.info.id,target=body();
    loading=(async()=>{
      const saved=await launchObjects(id,target);
      const objects=validateLaunchObjects(saved??[]);
      if(objects.some(o=>o.body!==target))throw Error('Saved launch objects belong to another body; record retained');
      if(owner!==app.client.worker||key!==current)return;
      list=objects;await app.client.request('launch-objects',{objects:list});draw();
    })().catch(error=>{if(key===current)loadError=error;throw error;}).finally(()=>{if(key===current)loading=undefined;});
    return loading;
  };
  const save=async objects=>{
    await ready();validateLaunchObjects(objects);
    if(loadError)throw loadError;
    if(objects.some(o=>o.body!==body()))throw Error('Objects belong to another body');
    if(saving)throw Error('Wait for the current launch-object save');
    const owner=app.client.worker,current=key;
    saving=true;
    try{
      await launchObjects(app.client.info.id,body(),objects);
      if(owner!==app.client.worker||key!==current)throw Error('Launch objects saved to the previous world; world changed during save');
      await app.client.request('launch-objects',{objects});
      if(owner!==app.client.worker||key!==current)return;
      list=structuredClone(objects);draw();
    }finally{saving=false;}
  };
  const place=async(pos,yaw,kind,angle)=>{
    await ready();
    const [surface]=await app.client.request('probe',{points:[[pos[0],pos[2]]]});
    if(surface[0]!==0)throw Error('Wait for ground to load before placing a launch object');
    const floor=Math.max(...surface.slice(1,3).filter(Number.isFinite));
    if(!Number.isFinite(floor))throw Error('No supported placement surface');
    const object={id:`launch-${crypto.randomUUID()}`,body:body(),kind,pos:[pos[0],floor,pos[2]],yaw,
      ...(kind==='ramp'?{angle}:{})};
    await save([...list,object]);return object;
  };
  const release=async client=>{
    client.discardFrame();
    client.state=await client.request('pod-release');
    client.clearPose();
  };
  const cancel=()=>{
    if(app.podCancel)return app.podCancel;
    app.swapHold=true;
    app.podCancel=(async()=>{
      if(app.podSwap)await app.podSwap;
      await Promise.all([app.client,...Object.values(app.engines||{})].filter(c=>c.worker).map(release));
      app.renderer.podTime=undefined;
    })().finally(()=>{app.swapHold=false;app.podCancel=undefined;});
    return app.podCancel;
  };
  app.launch={ready,save,place,cancel,list:()=>list,swap:async target=>{
    await app.prepareEngines;
    if(!await app.soiSwap(target))throw Error(`The ${target} world is not ready; load local Data before interplanetary travel`);
    await ready();
  }};
  app.editor.launch={
    list:()=>list,
    place,
    remove:id=>save(list.filter(o=>o.id!==id)),
    rotate:(id,yaw)=>save(list.map(o=>o.id===id?{...o,yaw}:o)),
  };
  app.launchFrame=()=>{
    if(app.podCancel)return true;
    if(!app.client.info)return false;
    if(`${app.client.info.id}:${body()}`!==key)void ready().catch(app.fail);
    const state=app.client.state?.pod,j=state?.journey;
    if(j&&!app.flight){simEpoch.days=Math.floor(j.time/DAY_PERIOD);app.renderer.podTime=wrapTime(j.time);}
    else app.renderer.podTime=undefined;
    const stamp=JSON.stringify(state?.spent||[]);if((drawKey!==stamp||!app.renderer.launchProps)&&!loading)draw();
    // Promise identity prevents a resumed tick from queuing a second swap.
    if(j&&j.parent!==body()&&!app.podSwap){
      app.swapHold=true;
      const previousBody=body();
      app.podSwap=(async()=>{
        await app.launch.swap(j.parent);
        const adopted=await app.client.request('pod-adopt',{pod:state});
        app.client.state=adopted;app.client.clearPose();
        await release(app.engines[previousBody]);
      })().catch(error=>{app.running=false;app.fail(error);}).finally(()=>{app.swapHold=false;app.podSwap=undefined;});
      return true;
    }
    return !!app.podSwap;
  };
}
