import {rememberDataFolder,forgetDataFolder,authorizeDataFolder} from './asset-folder.js';
import {worldSave,worldTuning,validateWorldSave,LAYOUT_VERSION} from './world-store.js';
import {overview} from './flight.js';
import {nearChunksReady} from './loading-gate.js';
import {TUNING_FIELDS,validateTuningRecord,migrateTuning} from './world-tuning.js';
import {unstuckPoses} from './race.js';
import {loadTracks} from './race-flags.js';
import {loadGateKit} from './race-gates.js';
import {getSwe1r} from './swe1r/ui.js';
import {classifyPickError} from './swe1r/attach.js';
import {loadPodModel} from './swe1r/skin.js';
import {ELUNE_GRAVITY_SCALE,BODIES,bodiesEnabled} from './bodies.js';
import {activeBody,setActiveBody} from './body-shaders.js';
const LUNAR_GRAVITY=48*ELUNE_GRAVITY_SCALE;
import {WorldClient} from './world-client.js';
export function installLoading(app) {
const {canvas,cameraCollision,evidence,defaults,settings,loading,loadingArt,mapPanel,music,client}=app;
const $=id=>document.getElementById(id);
Object.assign(app,{loadingProgress,fail,open,showReconnect,operation,soiSwap:id=>soiSwap(app,id)});
loading.addEventListener('cancel',event=>event.preventDefault());
loading.addEventListener('close',()=>{if(!loading.open){loadingArt.clear();client.stopLoadingArt();}});
function loadingProgress({text,completed,total}) {
  if(!loading.open)return;
  $('loading-stage').textContent=text;
  const bar=$('loading-progress'),known=Number.isFinite(total)&&total>0&&Number.isFinite(completed);
  if(known){
    bar.max=total;bar.value=completed;
    bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',total);bar.setAttribute('aria-valuenow',completed);
  } else {
    bar.removeAttribute('value');
    for(const name of ['aria-valuemin','aria-valuemax','aria-valuenow'])bar.removeAttribute(name);
  }
  $('loading-count').textContent=known?`${completed} / ${total}`:'';
  bar.setAttribute('aria-valuetext',text);
  loadingArt.progress(completed,total);
}
app.report=(text,temporary=false)=>{
  clearTimeout(app.reportTimer);if($('status').textContent!==text)$('status').textContent=text;
  if(temporary)app.reportTimer=setTimeout(()=>$('status').textContent='',4000);
};
function fail(error) {
  if(loading.open)loading.close();
  if(error.name==='AbortError')return;
  const message=error.message || String(error);
  console.error(error);evidence.errors.push(message);$('error').textContent=message;$('error').hidden=false;
}
function dockFolderButtons(inMenu) {
  const host=$(inMenu?'data-folder':'folder-extras');
  for(const id of ['different','fallback','forget','swe1r-row'])if($(id).parentNode!==host)host.append($(id));
}
function enabled(value) {
  document.querySelector('.meters').hidden=!value;$('menu-hint').hidden=!value;dockFolderButtons(value);
  for(const id of ['save','load','reset','unstuck','retry','overview','fly','drive'])$(id).disabled=!value;
  $('tuning-panel').inert=!value || !Array.isArray(client.info?.tuning);
  $('cockpit').disabled=!value;
}
async function restore(save) {
  validateWorldSave(save,client.info.id);
  if(!save)return false;
  client.state=await client.request('restore',{pose:save.vehicle});app.race?.jump();
  Object.assign(settings,{distant:true,controls:'legacy',cameraDistance:15,sound:true,cockpit:false,clouds:true},save.settings);app.syncSettings();
  if(!settings.sound)app.pauseAudio();else app.resumeAudio();
  app.flight=save.mode==='fly'?save.camera.slice():undefined;
  app.renderer.camera=undefined;
  return true;
}
async function open(selection,remember=false) {
  if(app.busy)return;
  app.busy=true;app.running=false;enabled(false);$('error').hidden=true;$('welcome').hidden=true;app.report('Loading world...');
  $('select').disabled=true;evidence.ready=false;
  loadingArt.clear();$('loading-warning').textContent='';
  loading.showModal();loadingProgress({text:'Opening local Data...'});
  let opened=false;
  try {
    const loadingMap=app.renderer.manifest?.regions[app.renderer.sceneRegion]?.map;
    app.renderer.reset();app.renderer.clipCamera=undefined;app.renderer.cameraFloor=undefined;cameraCollision.reset();app.flight=undefined;app.pauseAudio();music.stop();Object.assign(settings,defaults);app.syncSettings();
    app.applyMemoryBudget();
    const result=await client.open(selection,loadingMap);client.bodyId=activeBody().id;
    app.renderer.configure(result.info.manifest);client.sky();client.animate(settings.animateNpcs);mapPanel.configure(result.info.manifest);
    void loadTracks().then(async found=>{app.shipped=found;app.tracks=await app.withOverrides(found);app.gateKey=undefined;});
app.gateKit=undefined;void loadGateKit((a,p)=>client.request(a,p),()=>getSwe1r()&&loadPodModel(getSwe1r(),{index:309,scale:1/600})).then(kit=>{app.gateKit=kit;app.gateKey=undefined;});
    cameraCollision.configure(result.info.manifest);
    app.tuningValues=Array.isArray(result.info.tuning)?result.info.tuning.slice():TUNING_FIELDS.map(f=>f[1]);
    opened=true;
    void openMoonEngine(app,selection);
    if(remember)await rememberDataFolder(selection);
    evidence.info=result.info;evidence.source='local Data archives';
    $('welcome').hidden=true;enabled(true);app.running=true;
    loadingProgress({text:'Restoring local settings and saved position'});
    const save=await worldSave(result.info.id);
    const tune=migrateTuning(await worldTuning(result.info.id));
    if(tune) {
      validateTuningRecord(tune);
      await client.request('tuning',{values:tune.values});
      app.tuningValues=tune.values.slice();settings.cameraSeconds=tune.cameraSeconds;
    }
    if(selection==='elune'){settings.clouds=false;app.syncSettings();const values=app.tuningValues.slice();values[14]=LUNAR_GRAVITY;await client.request('tuning',{values});app.tuningValues=values;}
    const restored=await restore(save);
    if(tune&&!restored)client.state=await client.request('reset');
    const gateStart=performance.now();
    for(;;){
      const state=await client.request('frame',{dt:0,throttle:0,steer:0,flags:0,distant:settings.distant});
      client.state=state;
      const failed=state.scene.waitingCollisionDetails.find(item=>item.status!=='PENDING');
      if(failed)throw new Error(`Starting location collision unavailable: ${failed.key} (${failed.status})`);
      if(state.scene.waitingCollision&&state.scene.capacityBlocked)throw new Error('Starting collision cannot fit the scene budget');
      if(!state.required.every(i=>state.resident.includes(i)))throw new Error(state.failures.join('\n')||'Starting terrain unavailable');
      if(!state.scene.waitingCollision&&state.required.every(i=>app.renderer.tiles.has(i))&&nearChunksReady(state.nearTerrain,performance.now()-gateStart))break;
      if(!$('error').hidden)throw new Error($('error').textContent);
      loadingProgress({text:`Preparing nearby scenery: ${state.scene.waitingCollision} collision assets remaining. Water: ${state.water.resident} tiles streamed.`});
      await new Promise(resolve=>setTimeout(resolve,16));
    }
    loading.close();
    evidence.ready=true;app.report(restored?'Loaded.':'',restored);canvas.focus();app.applySkin();
    await app.applyUrlPose();
  } catch(error) {
    fail(error);app.report('');
    if(opened){enabled(true);app.running=true;evidence.ready=true;}
    else {client.stop();$('welcome').hidden=false;
      if(selection===app.folder&&selection?.kind==='directory'){app.folder=undefined;await forgetDataFolder().catch(()=>{});}}
  } finally {if(loading.open)loading.close();app.busy=false;$('select').disabled=false;}
}
// A remembered handle whose permission needs a click offers one continue button plus a way to pick another folder.
function showReconnect(on) {
  $('select').textContent=on?`Continue with ${app.folder.name}`:'Choose Data';$('different').hidden=!on;
}
$('different').addEventListener('click',async()=>{app.permissionNeeded=false;showReconnect(false);app.folder=undefined;await select();});
async function select() {
  if(!app.renderer)return;
  try {
    if(app.permissionNeeded && app.folder) {
      if(!await authorizeDataFolder(app.folder,{request:true}))throw new Error('Read permission was not granted. Choose another Data folder or try again.');
      app.permissionNeeded=false;showReconnect(false);await open(app.folder,true);return;
    }
    if(!window.showDirectoryPicker){$('files').click();return;}
    const handle=await showDirectoryPicker({id:'vanilla-world-data',mode:'read'});
    app.folder=handle;await open(handle,true);
  } catch(error){
    if(error.name==='AbortError')$('permission').textContent='No folder chosen. If your browser said it "contains system files", use Choose folder as files, or copy the Data folder outside Program Files/AppData.';
    else fail(classifyPickError(error).kind==='blocked'?new Error('Your browser refuses this folder (Program Files, Windows, AppData). Use Choose folder as files, or copy the Data folder elsewhere.'):error);
  }
}
$('select').addEventListener('click',select);

$('fallback').addEventListener('click',()=>$('files').click());
$('files').addEventListener('change',()=>{
  const files=[...$('files').files];
  if(files.length) {
    $('permission').textContent='Reselect Data after reload. Saves stay local.';
    open(files.map(file=>({path:file.webkitRelativePath || file.name,file})));
  }
});
$('forget').addEventListener('click',async()=>{
  try {await forgetDataFolder();app.folder=undefined;app.permissionNeeded=false;showReconnect(false);
    $('permission').textContent='Folder forgotten. World and saves retained.';}
  catch(error){fail(error);}
});
async function operation(action) {
  if(app.busy || !client.info)return;
  app.busy=true;client.discardFrame();
  try {await action();canvas.focus();}catch(error){fail(error);}finally{app.busy=false;}
}
$('save').addEventListener('click',()=>operation(async()=>{
  const state=await client.request('snapshot'),p=state.telemetry;
  const {cameraSeconds,...displaySettings}=settings;
  const record={version:1,layout:LAYOUT_VERSION,sourceId:client.info.id,
    mode:app.flight?'fly':'drive',vehicle:[p[0],p[1],p[2],p[3]],camera:app.flight?.slice(),settings:displaySettings};
  validateWorldSave(record,client.info.id);
  await worldSave(client.info.id,record);
  app.report('Saved.',true);
}));
$('load').addEventListener('click',()=>operation(async()=>{
  if(!await restore(await worldSave(client.info.id)))throw new Error('No save for this Data installation yet.');
  app.report('Loaded.',true);app.running=true;
}));
$('unstuck').addEventListener('click',()=>operation(async()=>{
  const p=client.state?.telemetry;if(!p)return;
  for(const pose of unstuckPoses(p)){
    try{client.state=await client.request('restore',{pose});app.flight=undefined;app.race?.jump();app.renderer.camera=undefined;app.running=true;app.report('Unstuck: moved 10 m up.',true);return;}catch{/* fall through to the next recovery pose */}
  }
  app.report('Unstuck failed: no free space above.',true);
}));
$('reset').addEventListener('click',()=>operation(async()=>{
  app.flight=undefined;client.state=await client.request('reset');app.race?.jump();app.renderer.camera=undefined;app.running=true;
  $('error').hidden=true;app.report('Reset. Save unchanged.',true);
}));
$('retry').addEventListener('click',()=>operation(async()=>{
  client.state=await client.request('retry');app.running=true;app.report('Retrying loading...',true);$('error').hidden=true;
}));
$('fly').addEventListener('click',()=>{
  const p=client.state?.telemetry;if(!p||app.race)return;
  app.flight=[p[0],p[1]+20,p[2]+20,p[3],-.25];canvas.focus();
});
$('overview').addEventListener('click',()=>{if(client.info&&!app.race){app.flight=overview(client.info.manifest);canvas.focus();}});
$('drive').addEventListener('click',()=>{app.flight=undefined;app.renderer.camera=undefined;canvas.focus();});
}

// Extra resident engines (design/elune.md): every other moon body gets its own far-only, physics-free worker beside the parent, keyed by body id, with ?bodies&moonEngine. Events are counted per body until the renderer sink lands.
async function openMoonEngine(app,selection) {
  if(!bodiesEnabled(location.search)||!bodiesEnabled(location.search,'moonEngine'))return;
  app.engines??={};app.engineCounts??={};
  for(const body of Object.values(BODIES)) {
    if(!body.rail||body.id===selection||app.engines[body.id])continue;
    app.engineCounts[body.id]={events:0,farScenes:0};
    const engine=new WorldClient(data=>{const counts=app.engineCounts[engine.bodyId]??={events:0,farScenes:0};counts.events++;if(data.event==='far-scene')counts.farScenes++;return false;},error=>console.warn(engine.bodyId+' engine',error));
    engine.farOnly=true;engine.bodyId=body.id;app.engines[body.id]=engine;
    try{await engine.open(body.id);void app.renderer?.prepareBody?.(body).catch(e=>console.warn(body.id+' pipelines',e));}catch(error){console.warn(body.id+' engine unavailable',error);engine.stop();delete app.engines[body.id];}
  }
}

/** In-page gravity-well swap (design/elune.md): the warm resident engine of the new parent becomes the near one and the old near world goes far-only, so there is no reload.
 * Returns false (caller falls back to the reload handoff) if that engine is not ready. */
async function soiSwap(app,parentId) {
  const {cameraCollision,evidence,settings,mapPanel,client}=app;
  const engine=app.engines?.[parentId],body=BODIES[parentId],prev=activeBody();
  if(!engine?.worker||!engine.info||!body||app.busy||prev.id===parentId)return false;
  app.busy=true;
  const prof={to:parentId,phases:{},start:performance.now()};let mark=prof.start;const lap=name=>{const t=performance.now();prof.phases[name]=+(t-mark).toFixed(1);mark=t;};
  try {
    await app.renderer.prepareBody(body);lap('prepare');
    app.bodyTuning??={};app.bodyTuning[prev.id]=app.tuningValues.slice();app.bodyClouds??={};app.bodyClouds[prev.id]=settings.clouds;
    client.swap(engine);
    delete app.engines[parentId];app.engines[prev.id]=engine;engine.farOnly=true;client.farOnly=false;
    setActiveBody(body);
    await app.renderer.useBody(body);lap('use');
    app.renderer.swapPlanetState(prev.id,parentId);
    app.renderer.reset({keepPlanet:true});app.renderer.clipCamera=undefined;app.renderer.cameraFloor=undefined;cameraCollision.reset();
    const manifest=client.info.manifest;
    app.renderer.configure(manifest);client.sky();client.animate(settings.animateNpcs);mapPanel.configure(manifest);    cameraCollision.configure(manifest);lap('configure');
    void engine.request('rebind',{replay:false}).catch(e=>console.warn('demote rebind',e));// old near world sheds its near residency; its events are only counted now
    await client.request('rebind');lap('rebind');// new near world forgets what it "already sent" so streaming and the horizon reach the fresh renderer
    app.gateKey=undefined;
    const values=app.bodyTuning[parentId]?.slice()??(Array.isArray(client.info.tuning)?client.info.tuning.slice():app.tuningValues.slice());
    if(parentId==='elune'&&!app.bodyTuning[parentId])values[14]=LUNAR_GRAVITY;
    await client.request('tuning',{values});lap('tuning');app.tuningValues=values;
    settings.clouds=app.bodyClouds[parentId]??(body.atmosphereEdge>0);app.syncSettings();
    evidence.info=client.info;evidence.bodySwaps=(evidence.bodySwaps||0)+1;
        prof.total=+(performance.now()-prof.start).toFixed(1);(evidence.swapProfiles??=[]).push(prof);
        return true;
  } finally {app.busy=false;}
}