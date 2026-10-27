export {sceneReady} from './scene-stream.js';
export {sceneVisible} from './world-view.js';
export {craftMatrix} from './world-camera.js';
export {cameraAxes,renderMatrix,sceneSelection,terrainEdgeMask,readySceneInstances,AdmissionFade} from './renderer-helpers.js';
import {depthAttachment,depthTexture} from './render-passes.js';
import {sceneReady} from './scene-stream.js';
import {MINIMAP_SIZE} from './terrain-stream.js';
import {cameraView,craftMatrix} from './world-camera.js';
import {partMatrix,wreckFrame,WRECK_SECONDS} from './wreck.js';
import {maelstromCentre,resolveCloudQuality,SlowFrameGuard,sunDirection} from './clouds.js';
import {exhaustPoints,emitPlumes,emitDebris,emitHeatSmoke,emitGroundDust,emitWaterFx,overWater,QUALITY,INSTANCE_FLOATS,particleUniform,emitLamps,emitDomeMist} from './particles.js';
import {domePlacement} from './dome-shell.js';
import {domeMask} from './elune-sites.js';
import {beamState} from './beam.js';
import {horizonDip} from './space.js';
import {planetFactorsFor,bodiesEnabled} from './bodies.js';
import {activeBody} from './body-shaders.js';
import {skyUniform,DAY} from './sky.js';
import {eluneSkyAt,AIRLESS_SKY} from './elune-sky.js';
import {localSunAt,solarTime} from './local-sun.js';
import {SimClock,sanitiseScale,daylightAt,CloudClock} from './sim-clock.js';
import {sceneVisible,boundsVisible,viewChanged} from './world-view.js';
import {cameraAxes,AdmissionFade,sceneSelection} from './renderer-helpers.js';
import {posedAsset,npcMoves,moveMatrix,pose} from './renderer-actors.js';
import {buffer,texture,drawable,setFlags,setGates,releaseMaterial,release,uploadMaterials,drawTerrain,refreshOcean} from './renderer-terrain.js';
import {destroyCraft,releaseCraft,buildCraft,startWreck,wreckChunk,endWreck,setProps,setCraftOverride,domeDraw} from './renderer-craft.js';
import {reset,configure,event,clearFar,swapPlanetState,bodyEvent} from './renderer-events.js';
import {scenePipeline,prepareBatches,sceneMatrix,drawScene} from './renderer-scene.js';
import {zoneBlend,setSky,setSkyDome,horizonColour,planetRects,drawPlanet,sharedFrame,drawPatches,drawBodies,drawBodyClouds,drawLights,drawSkyDome,sampleSky,noteLitInstance} from './renderer-sky.js';
import {drawShadow,enableHighClouds,highCloudGroup,maskEntries,drawClouds} from './renderer-clouds.js';
import {initialize,prepareBody,useBody} from './renderer-init.js';
const OCEAN_MESH_CEILING=90000;
const DAY_SKY=[.08,.15,.20],NIGHT_SKY=[.008,.016,.045];
export class WorldRenderer {
  static async create(canvas,onError) {
    if(!navigator.gpu)throw new Error('WebGPU is unavailable. Use current Edge/Chrome with hardware acceleration.');
    const adapter=await navigator.gpu.requestAdapter();
    if(!adapter)throw new Error('No WebGPU adapter. Enable hardware acceleration.');
    const device=await adapter.requestDevice();
    device.addEventListener('uncapturederror',event=>onError(event.error));
    device.lost.then(info=>onError(new Error(`WebGPU device lost: ${info.message}`)));
    const result=new WorldRenderer(canvas,device);
    result.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter};
    await result.initialize();
    return result;
  }
  constructor(canvas,device) {
    this.sharedSpace=typeof location!=='undefined'&&bodiesEnabled(location.search);
    this.canvas=canvas;this.device=device;this.format=navigator.gpu.getPreferredCanvasFormat();
    this.context=canvas.getContext('webgpu');this.context.configure({device,format:this.format,alphaMode:'opaque'});
    this.tiles=new Map();this.seams=new Map();this.horizon=[];this.water=[];this.flags=[];this.gates=[];this.coast=new Map();this.indices=new Map();
    this.coastBytes=0;
    this.admissionFade=new AdmissionFade();
    this.assets=new Map();this.textures=new Map();this.items=new Map();this.instances=[];this.pipelines=new Map();
    this.materialPending=new Map();this.minimapAtlases=[];
    this.pendingEvents=[];this.poses=new Map();this.moves=new Map();
    this.terrainBundleBuilds=0;this.sceneBundleBuilds=0;
    this.uniformData=new Float32Array(16384*64);
    this.frameUniforms=device.createBuffer({size:this.uniformData.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  }
  posedAsset(instance,base){return posedAsset(this,instance,base);}
  npcMoves(data){return npcMoves(this,data);}
  moveMatrix(instance,mv,region,origin){return moveMatrix(this,instance,mv,region,origin);}
  pose(data){return pose(this,data);}
  buffer(data,usage){return buffer(this,data,usage);}
  initialize(){return initialize(this);}
  texture(width,height,rgba){return texture(this,width,height,rgba);}
  drawable(vertices,placement,map){return drawable(this,vertices,placement,map);}
  setFlags(positions){return setFlags(this,positions);}
  setGates(items){return setGates(this,items);}
  releaseMaterial(item){return releaseMaterial(this,item);}
  release(item){return release(this,item);}
  destroyCraft(craft){return destroyCraft(this,craft);}
  releaseCraft(){return releaseCraft(this);}
  buildCraft(data,display,key,maxIndices){return buildCraft(this,data,display,key,maxIndices);}
  startWreck(state,seed,speed){return startWreck(this,state,seed,speed);}
  wreckChunk(chunk){return wreckChunk(this,chunk);}
  endWreck(){return endWreck(this);}
  setProps(list){return setProps(this,list);}
  setCraftOverride(model){return setCraftOverride(this,model);}
  prepareBody(body){return prepareBody(this,body);}
  useBody(body){return useBody(this,body);}
  reset(options){return reset(this,options);}
  swapPlanetState(from,to){return swapPlanetState(this,from,to);}
  bodyEvent(body,data){return bodyEvent(this,body,data);}
  configure(manifest){return configure(this,manifest);}
  event(data){return event(this,data);}
  clearFar(){return clearFar(this);}
  uploadMaterials(){return uploadMaterials(this);}
  scenePipeline(batch){return scenePipeline(this,batch);}
  prepareBatches(batches){return prepareBatches(this,batches);}
  sceneMatrix(instance,region,origin){return sceneMatrix(this,instance,region,origin);}
  drawTerrain(pass,terrain){return drawTerrain(this,pass,terrain);}
  setSky(data){return setSky(this,data);}
  setSkyDome(data){return setSkyDome(this,data);}
  horizonColour(key,part){return horizonColour(this,key,part);}
  refreshOcean(){return refreshOcean(this);}
  planetRects(){return planetRects(this);}
  drawPlanet(pass,pf,near){return drawPlanet(this,pass,pf,near);}
  sharedFrame(){return sharedFrame(this);}
  drawPatches(pass){return drawPatches(this,pass);}
  drawBodies(pass,pf,near){return drawBodies(this,pass,pf,near);}
  drawBodyClouds(pass,time,daylight,near){return drawBodyClouds(this,pass,time,daylight,near);}
  drawLights(pass,pf){return drawLights(this,pass,pf);}
  drawSkyDome(pass){return drawSkyDome(this,pass);}
  sampleSky(){return sampleSky(this);}
  drawShadow(pass,state,near){return drawShadow(this,pass,state,near);}
  enableHighClouds(){return enableHighClouds(this);}
  highCloudGroup(){return highCloudGroup(this);}
  maskEntries(){return maskEntries(this);}
  drawClouds(pass,time,daylight,near,high){return drawClouds(this,pass,time,daylight,near,high);}
  drawScene(pass,draws){return drawScene(this,pass,draws);}
  draw(state,flight,dt,time,settings,lookBack=false) {
    this.uploadMaterials();
    const canvas=this.canvas,width=Math.max(1,Math.round(canvas.clientWidth*Math.min(devicePixelRatio,2)));
    const height=Math.max(1,Math.round(canvas.clientHeight*Math.min(devicePixelRatio,2)));
    if(!this.depth || canvas.width!==width || canvas.height!==height) {
      canvas.width=width;canvas.height=height;this.depth?.destroy();
      this.depth=depthTexture(this.device,width,height);
      this.shadowGroup=this.device.createBindGroup({layout:this.shadowPipeline.getBindGroupLayout(0),
        entries:[{binding:0,resource:{buffer:this.shadowBuffer}},{binding:1,resource:this.depth.createView()}]});
      this.cloudGroup=this.device.createBindGroup({layout:this.cloudPipeline.getBindGroupLayout(0),
        entries:[{binding:0,resource:{buffer:this.cloudBuffer}},{binding:1,resource:this.depth.createView()},...this.maskEntries()]});
      this.cloudHighGroup=this.cloudHigh&&this.highCloudGroup();
    }
    const origin=flight?[Math.round(flight[0]),Math.round(flight[2])]:[state[11],state[12]];
    const p=[state[0]-origin[0],state[1],state[2]-origin[1]];
    const {look,near,up:cameraUp}=cameraView(this,state,flight,dt,origin,settings,lookBack);
    const {right,up}=cameraAxes(look,cameraUp);
    this.cameraLook=look;
    const aspect=width/height;
    this.view={eye:[this.camera[0]+origin[0],this.camera[1],this.camera[2]+origin[1]],right,up,look,aspect};
    const planetOn=!!flight&&settings.planet!==false,pf=this.planet=planetFactorsFor(activeBody(),planetOn?this.view.eye[1]:0,planetOn);pf.mesh=planetOn&&!!settings.globeMesh;pf.registry=planetOn&&!!settings.globeRegistry;
    const clock=this.clock??=new SimClock(DAY,1);
    clock.scale=flight?Math.min(sanitiseScale(settings.timeScale),this.warpCap??Infinity):1;clock.step(dt);
    const cc=this.cloudClock??=new CloudClock(time);cc.step(dt,clock.scale);pf.flowScale=cc.stretch;pf.flowCycles=cc.cycles;
    this.cloudTime=cc.time;const waterTime=this.cloudTime%7200;
    this.timeOfDay=this.timeLock??clock.now();
    const airless=activeBody().id==='elune',moonSky=airless?eluneSkyAt(state[0],state[2],this.timeOfDay):undefined;
    // Atmospheric bodies light from where the camera stands: the local sun and the clock reading that sun corresponds to drive every day/night and Light.dbc lookup.
    this.sunLocal=moonSky?moonSky.sun:localSunAt(activeBody(),this.view.eye[0],this.view.eye[2],this.timeOfDay);
    this.localTime=moonSky?this.timeOfDay:solarTime(this.sunLocal);
    const daylight=this.daylight=moonSky?moonSky.daylight:daylightAt(this.localTime);
    const sky0=airless?AIRLESS_SKY:DAY_SKY.map((v,i)=>NIGHT_SKY[i]+(v-NIGHT_SKY[i])*daylight);
    const game=airless?undefined:zoneBlend(this.sampleSky(),pf.zone),sky=game?game.fog:sky0;pf.fog=(game?game.horizon:sky).slice(0,3);
    this.gameSky=game;
    const skyFloats=game?[...game.fog,1,...game.sun,0,...game.horizon,0,...game.mid,0]:new Array(16).fill(0);
    if(this.manifest?.world_bounds){const [mx,mz]=maelstromCentre(this.manifest);skyFloats[7]=mx-origin[0];skyFloats[11]=mz-origin[1];skyFloats[15]=1;}
    const view=[...this.camera,200000,...right,origin[0]%4096,...up,origin[1]%4096,...look,daylight];
    const distant=settings.horizon?this.horizon.filter(h=>!this.tiles.has(h.near)):[];
    const coastal=[...this.coast].flatMap(([index,item])=>
      this.tiles.has(index)?item.backing?[item.backing]:[]:settings.horizon?[item]:[]);
    this.refreshOcean();
    const allTerrain=this.cameraBlocked?[]:[...distant,...this.tiles.values(),...(settings.horizon?this.seams.values():[]),...(this.view.eye[1]>OCEAN_MESH_CEILING&&planetOn?this.water.filter(w=>w!==this.oceanFill):this.water),...coastal,...this.flags,...this.gates];
    if(!flight&&!this.craft&&!this.cameraBlocked)allTerrain.push(this.body);
    const cachedView=this.terrainView;
    if(!cachedView || cachedView.bent!==(pf.bend>0) || viewChanged(cachedView.view,this.view) ||
      cachedView.all.length!==allTerrain.length || allTerrain.some((item,i)=>cachedView.all[i]!==item))
      this.terrainView={view:this.view,all:allTerrain,bent:pf.bend>0,
        visible:allTerrain.filter(item=>item===this.body || pf.bend>0 || boundsVisible(item.bounds,this.view))};
    const terrain=this.terrainView.visible;
    this.fadeTime=Math.max(this.fadeTime||0,time);
    const fadeTime=this.fadeTime;
    let uniformCount=0;
    const u=this.uniformData,sunDir=this.sunLocal;
    const writeUniform=item=>{
      if(uniformCount>=16384)throw Error('World draw uniform budget exceeded');
      const base=uniformCount++*64;
      item.offset=base*4;u.set(view,base);u.set(skyFloats,base+40);u[base+28]=u[base+60]=pf.bend;u[base+30]=u[base+62]=this.view.eye[2];u[base+29]=u[base+61]=pf.space;u.set(sunDir,base+32);return base;
    };
    for(const item of terrain){
      const base=writeUniform(item),body=item===this.body;
      u.set(p,base+16);u[base+19]=body?state[3]:(item.edgeMask||0);
      if(item.material&&item.materialSince===undefined)item.materialSince=fadeTime;
      u[base+20]=aspect;u[base+21]=waterTime;
      u[base+22]=body?state[4]:Math.min(1,Math.max(0,(fadeTime-(item.materialSince??fadeTime))/.35));u[base+23]=near;
      u[base+24]=body?0:item.placement[0]-origin[0];u[base+25]=0;
      u[base+26]=body?0:item.placement[1]-origin[1];u[base+27]=item.cell??-1;
    }
    const fxIn={...this.fxInput,...this.fxOverride},beam=beamState({throttle:fxIn.throttle,boosting:fxIn.boosting,heat:fxIn.heat,health:fxIn.health});
const lamps=[],draws=[],selection=this.cameraBlocked?{selected:[],omitted:0}:
      sceneSelection(this.instances.filter(i=>(settings.distant!==false || !i.distant)&&
        (!i.distant||sceneReady(i,this.assets,this.textures))),this.assets,(instance,asset)=>
        sceneVisible(asset.bounds,this.sceneMatrix(instance,this.manifest.regions[this.sceneRegion],origin),
          this.camera,right,up,look,aspect));
    const append=(asset,instance,m,textures,items)=>{
        const distance=Math.hypot(m[12]-this.camera[0],m[13]-this.camera[1],m[14]-this.camera[2]);
        this.admissionFade??=new AdmissionFade();
        const coverage=instance.craft?1:this.admissionFade.opacity(instance.id,fadeTime);
        const cached=instance.drawItems || (instance.drawItems=[]);
        if(asset.lamps&&distance<220&&lamps.length<24)lamps.push({points:asset.lamps,matrix:m});
        for(let b=0;b<asset.batches.length;b++) {
          const batch=asset.batches[b];
          if((batch.emissive||batch.sidn)&&!instance.litNoted&&!instance.craft&&!instance.id.includes(':npc:')){instance.litNoted=1;noteLitInstance(this,m[12]+origin[0],m[14]+origin[1]);}
          const texture=(batch.texture&&textures.get(batch.texture))||this.white;
          let item=cached[b];
          if(!item || item.texture!==texture || item.asset!==asset) {
            const key=`${instance.id}:${instance.key}:${b}`;
            item=items.get(key);
            if(!item || item.texture!==texture || item.asset!==asset) {
              const sampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',
                addressModeU:batch.wrapX?'repeat':'clamp-to-edge',addressModeV:batch.wrapY?'repeat':'clamp-to-edge'});
              item={id:instance.id,key:instance.key,asset,texture,group:this.device.createBindGroup({layout:this.sceneLayout,entries:[
                {binding:0,resource:{buffer:this.frameUniforms,size:256}},{binding:1,resource:texture.createView()},{binding:2,resource:sampler},
                {binding:3,resource:this.waterNormals.createView()},{binding:4,resource:this.waveSampler}]} )};
              items.set(key,item);
            }
            cached[b]=item;
          }
          const base=writeUniform(item);
          u[base+16]=aspect;u[base+17]=time;u[base+18]=batch.water?1:0;u[base+19]=near;u.set(m,base+20);
          u[base+36]=batch.alphaCutoff||0;u[base+37]=batch.emissive?1:batch.sidn?2+(batch.sidn[0]>>4<<8|batch.sidn[1]>>4<<4|batch.sidn[2]>>4):0;u[base+38]=instance.distant&&!instance.landmark?1:0;
          u[base+39]=distance<128?1:coverage;
if(batch.beam&&instance.craft&&beam)u.set(beam,base+56);else u.fill(0,base+56,base+60);
          draws.push({asset,batch,item,distant:instance.distant,craft:instance.craft,pipeline:batch.pipeline,distance});
        }
    };
    if(settings.scenery && this.sceneRegion!==undefined) {
      const r=this.manifest.regions[this.sceneRegion];
      for(const instance of selection.selected) {
        const asset=this.posedAsset(instance,this.assets.get(instance.key));if(!asset)continue;
        const mv=this.moves?.size&&instance.id.includes(':npc:')?this.moves.get(instance.id):undefined;
        append(asset,instance,mv?this.moveMatrix(instance,mv,r,origin):this.sceneMatrix(instance,r,origin),this.textures,this.items);
      }
    }
    const wreckAge=this.wreck?performance.now()/1000-this.wreck.t0:0;
    if(this.wreck&&wreckAge>WRECK_SECONDS)this.endWreck();
    const wreckFrameNow=this.wreck&&wreckFrame(this.wreck,wreckAge);
    if(wreckFrameNow)this.wreck.parts.forEach((p,i)=>append(p.asset,p.instance,partMatrix(wreckFrameNow.subarray(i*7,i*7+7),p.center,this.wreck.scale,origin),this.craft.textures,this.craft.items));
    else if((!flight||this.showCraftInFlight)&&this.craft&&this.cameraMode!=='cockpit')append(this.craft.asset,this.craft.instance,
      craftMatrix(state,origin,this.craft.metadata.scale),this.craft.textures,this.craft.items);
    for(const p of [...(this.props||[]),...[domeDraw(this,activeBody().id,time)].filter(Boolean)]){const c=Math.cos(p.yaw),s=Math.sin(p.yaw),k=p.scale;
      append(p.craft.asset,p.craft.instance,p.space==='craft'?craftMatrix([p.pos[0],p.pos[1],p.pos[2],p.yaw,0],origin,k):
        new Float32Array([c*k,0,-s*k,0,0,k,0,0,s*k,0,c*k,0,p.pos[0]-origin[0],p.pos[1],p.pos[2]-origin[1],1]),p.craft.textures,p.craft.items);}
    if(!this.wreck&&!flight&&this.craft?.flame&&this.cameraMode!=='cockpit') {
      const m=craftMatrix(state,origin,this.craft.metadata.scale),k=(.35+.9*Math.min(1,Math.abs(state[5])/150))*(1+.08*Math.sin(time*45));
      for(const part of this.craft.flame.parts) {
        const [x,y,z]=part.at,f=new Float32Array(m);
        for(let i=0;i<3;i++){f[i]=m[i]*k;f[12+i]=m[12+i]+m[i]*x+m[4+i]*y+m[8+i]*z;}
        append(this.craft.flame.asset,part.instance,f,this.craft.textures,this.craft.items);
      }
    }
    draws.sort((a,b)=>a.batch.transparent-b.batch.transparent || (a.batch.transparent?b.distance-a.distance:0));
    // Race props (gates, beacons) draw after the clouds so nearer props are never veiled by them.
    const propDraws=draws.filter(d=>d.item.id.startsWith('prop:'));
    if(propDraws.length)for(let i=draws.length;i--;)if(draws[i].item.id.startsWith('prop:'))draws.splice(i,1);
    if(uniformCount)this.device.queue.writeBuffer(this.frameUniforms,0,this.uniformData.buffer,0,uniformCount*256);
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginRenderPass({
      colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:sky[0],g:sky[1],b:sky[2],a:1},loadOp:'clear',storeOp:'store'}],
      depthStencilAttachment:depthAttachment('main',this.depth.createView()),
    });
    if(!this.cameraBlocked){
      if(game){this.device.queue.writeBuffer(this.skyBuffer,0,skyUniform(this.view,game,this.localTime,horizonDip(this.view.eye[1],pf.bend),pf.space));pass.setPipeline(this.skyPipeline);pass.setBindGroup(0,this.skyGroup);pass.draw(3);this.drawSkyDome(pass);}
      if(pf.globe>0)this.drawPlanet(pass,pf,near);
      if(pf.globe>0&&pf.mesh)this.drawPatches(pass);
      if(pf.globe>0)this.drawBodies(pass,pf,near);
      this.drawTerrain(pass,terrain);this.drawScene(pass,draws);
      if(pf.globe>0)this.drawLights(pass,pf);
    }
    pass.end();
    if(!this.cameraBlocked&&!flight&&settings.shadows!==false) {
      const shadowPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}]});
      this.drawShadow(shadowPass,state,near);shadowPass.end();
    }
    const nowMs=performance.now(),auto=settings.cloudQuality!=='high'&&settings.cloudQuality!=='standard';
    this.cloudGuard??=new SlowFrameGuard();
    if(auto&&!this.cloudSlow&&this.cloudHighGroup&&settings.clouds!==false&&this.cloudGuard.push(nowMs-(this.lastRenderMs??nowMs))){this.cloudSlow=true;console.warn('auto clouds: slow frames, using Standard');}
    this.lastRenderMs=nowMs;
    const highClouds=resolveCloudQuality(settings.cloudQuality,{highFailed:this.cloudHighFailed,slow:this.cloudSlow});
    if(highClouds&&!this.cloudHigh&&!this.cloudHighFailed)this.enableHighClouds();
    if(!this.cameraBlocked&&(settings.clouds!==false||settings.farClouds!==false)) {
      // Clouds read the finished scene depth to clip their ray march, so they never need a depth-test bias.
      const cloudPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}]});
      if(settings.clouds!==false&&activeBody().clouds&&this.manifest?.world_bounds)this.drawClouds(cloudPass,this.cloudTime??time,daylight,near,highClouds);
      if(settings.farClouds!==false&&pf.globe>0)this.drawBodyClouds(cloudPass,this.cloudTime??time,daylight,near);cloudPass.end();
    }
    if(!this.cameraBlocked&&propDraws.length) {
      const propPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}],
        depthStencilAttachment:depthAttachment('props',this.depth.createView())});
      for(const {asset,batch,item,pipeline} of propDraws) {
        propPass.setPipeline(pipeline);propPass.setBindGroup(0,item.group,[item.offset]);propPass.setVertexBuffer(0,asset.vertices);
        propPass.setIndexBuffer(asset.indices,'uint32');propPass.drawIndexed(batch.indexCount,1,batch.firstIndex);
      }
      propPass.end();
    }
    const fx=this.particles,quality=QUALITY[settings.particles]??QUALITY.medium;
    if(fx)fx.quality=quality;
    const craft=this.craft;
    if(fx&&quality>0&&craft?.source&&!this.wreck&&!this.cameraBlocked&&(!flight||this.showCraftInFlight)&&this.cameraMode!=='cockpit') {
      const input=this.fxInput||{},speed=Math.abs(state[5]),scale=craft.metadata.scale;
      craft.fx??={points:exhaustPoints(craft.source.vertices,craft.source.indices,craft.metadata),length:craft.size[0]};
      emitPlumes(fx,{points:craft.fx.points,matrix:craftMatrix(state,origin,scale),origin,scale,length:craft.fx.length,speed,
        thrust:input.throttle??Math.min(1,speed/150),boosting:!!input.boosting,dt:Math.min(dt,.1)});
      const wet=overWater(state[1],craft.fx.length),fxArgs={matrix:craftMatrix(state,origin,scale),origin,scale,length:craft.fx.length,speed,drift:!!input.drifting,grounded:state[7]>0,dt:Math.min(dt,.1),time:performance.now()/1000};
      if(wet)emitWaterFx(fx,fxArgs);else emitGroundDust(fx,fxArgs);
      if(input.heat)emitHeatSmoke(fx,{points:craft.fx.points,matrix:craftMatrix(state,origin,scale),origin,length:craft.fx.length,heat:input.heat,dt:Math.min(dt,.1)});
    }
    if(fx&&quality>0&&!this.cameraBlocked){
      emitLamps(fx,lamps,origin,Math.min(dt,.1),1-daylight);
      const dome=this.dome?.craft&&domePlacement(activeBody().id);
      if(dome)emitDomeMist(fx,{eye:this.view.eye,level:domeMask(activeBody().id,this.view.eye[0],this.view.eye[2],30,15,this.view.eye[1]-dome.pos[1]),ground:dome.pos[1],dt:Math.min(dt,.1)});
    fx.update(Math.min(dt,.1));
      const count=fx.fill(this.particleInstances,this.view.eye);
      if(count){
        this.device.queue.writeBuffer(this.particleBuffer,0,this.particleInstances,0,count*INSTANCE_FLOATS);
        this.device.queue.writeBuffer(this.particleUniformBuffer,0,particleUniform(this.view,near));
        const fxPass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}],
          depthStencilAttachment:depthAttachment('fx',this.depth.createView())});
        fxPass.setPipeline(this.particlePipeline);fxPass.setBindGroup(0,this.particleGroup);fxPass.setVertexBuffer(0,this.particleBuffer);
        fxPass.draw(6,count);fxPass.end();
      }
    }
    if(fx&&quality>0&&this.wreck&&wreckFrameNow&&craft?.fx) {
      const size=craft.fx.length/3.5,sdt=Math.max(1/240,Math.min(dt,.1));
      this.wreck.parts.forEach((p,i)=>{const f=wreckFrameNow.subarray(i*7,i*7+7);emitDebris(fx,p.memo??={},[f[0],f[1],f[2]],wreckAge,sdt,size,`w${i}`,WRECK_SECONDS);});
    }
    this.particleCount=fx?.count||0;
    this.device.queue.submit([encoder.finish()]);
    return {horizonTiles:distant.length,detailedTiles:this.tiles.size,sceneInstances:this.instances.length,
      culledTerrainDraws:allTerrain.length-terrain.length,
      texturedTerrainTiles:[...this.tiles.values()].filter(t=>t.material).length,
      terrainGpuBytes:[...this.tiles.values()].reduce((n,t)=>n+(t.material?.bytes||0),0),
      terrainUploadPending:this.materialPending.size,minimapGpuBytes:this.minimapAtlases.length*(64*MINIMAP_SIZE)**2*4,
      uniformUploads:uniformCount?1:0,uniformBytes:uniformCount*256,terrainBundleBuilds:this.terrainBundleBuilds,
      sceneBundleBuilds:this.sceneBundleBuilds,
      craftDraws:draws.filter(d=>d.craft).length,craftPose:this.craft?.metadata.pose||'placeholder',craftGpuBytes:this.craft?.bytes||0,
      craftReady:!!this.craft,cockpitAvailable:!!this.craft?.anchor,cameraMode:this.cameraMode,
      cameraBlocked:this.cameraBlocked,worldDraws:terrain.length+draws.length,
      coastalWaterTiles:coastal.length,coastalWaterGpuBytes:this.coastBytes,
      waterShaderGpuBytes:this.waterNormalBytes||0,wmoWaterDraws:draws.filter(d=>d.batch.water).length,
      craftSize:this.craft?.size,craftSource:this.craft&&this.craft===this.override?'model':'game data',craftStatus:this.craft?'ready':this.craftError?'failed':'loading',
      craftTriangles:this.craft?this.craft.asset.count/3:0,craftError:this.craftError,
      npcInstances:this.instances.filter(i=>i.id.includes(':npc:')).length,
      wmoInstances:this.instances.filter(i=>i.kind==='group').length,
      texturedDraws:draws.filter(d=>d.item.texture!==this.white).length,
      alphaDraws:draws.filter(d=>d.batch.alphaCutoff>0).length,
      sceneTriangles:draws.reduce((n,d)=>n+d.batch.indexCount/3,0),gpuOmittedInstances:selection.omitted,culledSceneInstances:selection.culled||0,
      distantDraws:draws.filter(d=>d.distant).length,distantAlphaDraws:draws.filter(d=>d.distant&&d.batch.alphaCutoff>0).length,
      sceneDraws:draws.length,sceneGpuMeshBytes:[...this.assets.values()].reduce((n,a)=>n+a.bytes,0),origin};
  }
}
