import {WorldClient} from './world-client.js';
import {WorldRenderer} from './world-renderer.js';
import {rememberDataFolder,restoreDataFolder,forgetDataFolder,authorizeDataFolder} from './asset-folder.js';
import {worldSave,worldTuning,validateWorldSave,LAYOUT_VERSION} from './world-store.js';
import {overview,moveFlight} from './flight.js';
import {WorldInput,DRIVE_KEYS} from './world-input.js';
import {WorldAudio} from './world-audio.js';
import {TUNING_FIELDS,validateTuningRecord} from './world-tuning.js';
import {CameraCollision} from './camera-collision.js';
import {LoadingArt} from './loading-art.js';
import {MusicPlayer} from './world-music.js';

const $=id=>document.getElementById(id),canvas=$('world'),keys=new Set();
const input=new WorldInput(),audio=new WorldAudio();
const cameraCollision=new CameraCollision();
const evidence={ready:false,frames:0,errors:[],mode:'drive'};
window.worldEvidence=evidence;
let renderer,folder,flight,running=false,busy=false,last=0,frames=0,hudTime=0,hudFrames=0,permissionNeeded=false;
let orbit=[0,0],dragging=false,soundAttempt=0,soundError='',soundTime=0,reportTimer,testPads,frozenPresentation=false,tuningValues=TUNING_FIELDS.map(f=>f[1]);
const defaults={horizon:true,scenery:true,distant:true,controls:'native',cameraDistance:15,cameraSeconds:.5,sound:false,cockpit:false,night:false,clouds:true};
const settings={...defaults};
try{settings.night=localStorage.getItem('racer.night')==='1';}catch{}
const loading=$('loading-screen');
const loadingArt=new LoadingArt($('loading-art'),$('loading-bar-art'),loading);
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
const report=(text,temporary=false)=>{
  clearTimeout(reportTimer);if($('status').textContent!==text)$('status').textContent=text;
  if(temporary)reportTimer=setTimeout(()=>$('status').textContent='',4000);
};
function fail(error) {
  if(loading.open)loading.close();
  if(error.name==='AbortError')return;
  const message=error.message || String(error);
  console.error(error);evidence.errors.push(message);$('error').textContent=message;$('error').hidden=false;
}
const music=new MusicPlayer({request:fields=>client.music(fields),context:()=>audio.context});
const client=new WorldClient(data=>{
  try {
    evidence.eventRevision=(evidence.eventRevision||0)+1;
    if(data.event==='progress'){if(!evidence.ready){report(data.text);loadingProgress(data);}}
    else if(data.event==='music')music.event(data);
    else if(data.event==='loading-art')loadingArt.event(data);
    else if(data.event==='loading-art-warning'){
      console.warn(data.message);
      if(loading.open)$('loading-warning').textContent=data.message;
    }
    else {
      cameraCollision.event(data);
      if(data.event==='collision')renderer.clipCamera=(pivot,point,origin)=>{
        const pointWithClearance=cameraCollision.clip(pivot,point,origin);
        renderer.cameraCollisionReady=cameraCollision.ready;
        return pointWithClearance;
      };
      else renderer.event(data);
    }
    return true;
  } catch(error){
    if(data.event==='far-scene')renderer.clearFar();else running=false;
    fail(error);return false;
  }
},error=>{running=false;fail(error);},()=>running&&!busy&&!document.hidden&&!frozenPresentation);
function enabled(value) {
  document.querySelector('.meters').hidden=!value;
  for(const id of ['save','load','reset','retry','overview','fly','drive'])$(id).disabled=!value;
  $('tuning').disabled=!value || !Array.isArray(client.info?.tuning);
  $('cockpit').disabled=!value;
}
function syncSettings() {
  for(const key of ['horizon','scenery','distant','sound','night','clouds'])$(key).checked=settings[key];
  music.setNight(settings.night);
  $('control-profile').value=settings.controls;$('camera-distance').value=settings.cameraDistance;
  $('keyboard-guide').textContent=settings.controls==='legacy'
    ?'W/S thrust/reverse · A/D steer · X/Space brake · J hop · Shift boost · Ctrl/C drift · F9 reset.'
    :'W/S thrust/reverse · A/D steer · X brake · Space/J hop · Shift boost · Ctrl/C drift · F9 reset.';
  canvas.setAttribute('aria-label',`World. ${$('keyboard-guide').textContent} More controls in Controls and settings.`);
  syncSound();
}
function syncSound() {
  const paused=audio.context?.state!=='running' || !audio.enabled;
  evidence.audio={wanted:settings.sound,enabled:audio.enabled,state:audio.context?.state || 'off',voices:audio.voices.length,
    active:audio.active&&!paused,masterGain:audio.master?.gain.value || 0,error:soundError};
  $('sound').checked=settings.sound;
  $('resume-sound').hidden=!settings.sound || !paused;
  $('sound-status').textContent=!settings.sound?'':soundError || (paused?'':flight?'Paused in flight':!audio.active?'Paused':'');
}
function pauseAudio() {
  soundAttempt++;audio.mute();soundError='';syncSound();
}
async function resumeAudio(gesture=false) {
  if(!settings.sound || (!gesture&&!audio.context) || (audio.enabled&&audio.context?.state==='running'))return;
  const attempt=++soundAttempt;soundError='';
  try {await audio.enable();}
  catch(error){
    if(attempt===soundAttempt){soundError=error.message || String(error);console.error('Sound could not start',error);}
  } finally {if(attempt===soundAttempt)syncSound();}
}
function zoom(steps) {
  if(settings.cockpit){settings.cockpit=false;renderer.camera=undefined;}
  settings.cameraDistance=Math.max(0,Math.min(50,settings.cameraDistance-steps));
  $('camera-distance').value=settings.cameraDistance;
}
function cockpit() {
  if(!running || busy)return;
  settings.cockpit=!!flight || !settings.cockpit;flight=undefined;
  renderer.camera=undefined;orbit=[0,0];canvas.focus();
  if(settings.cockpit&&!renderer.craft?.anchor)
    report(renderer.craft?'Cockpit unavailable: craft has no posed seat.':'Cockpit waiting for craft.',true);
}
function fillTuning(values,seconds) {
  [...values,seconds].forEach((n,i)=>$(`tune-${i}`).value=n);
}
async function applyTuning(record) {
  validateTuningRecord(record);
  const values=await client.request('tuning',{values:record.values,validateOnly:true});
  const canonical={version:1,values:Array.from(values),cameraSeconds:Math.fround(record.cameraSeconds)};
  await worldTuning(client.info.id,canonical);
  await client.request('tuning',{values:canonical.values});
  tuningValues=canonical.values;settings.cameraSeconds=canonical.cameraSeconds;
  running=true;$('error').hidden=true;
  fillTuning(tuningValues,settings.cameraSeconds);$('tuning-status').textContent='Saved.';
}
async function restore(save) {
  validateWorldSave(save,client.info.id);
  if(!save)return false;
  client.state=await client.request('restore',{pose:save.vehicle});
  Object.assign(settings,{distant:true,controls:'legacy',cameraDistance:15,sound:false,cockpit:false,clouds:true},save.settings);syncSettings();
  if(!settings.sound)pauseAudio();else resumeAudio();
  flight=save.mode==='fly'?save.camera.slice():undefined;
  renderer.camera=undefined;
  return true;
}
async function open(selection,remember=false) {
  if(busy)return;
  busy=true;running=false;enabled(false);$('error').hidden=true;$('welcome').hidden=true;report('Loading world...');
  $('select').disabled=true;evidence.ready=false;
  loadingArt.clear();$('loading-warning').textContent='';
  loading.showModal();loadingProgress({text:'Opening local Data...'});
  let opened=false;
  try {
    const loadingMap=renderer.manifest?.regions[renderer.sceneRegion]?.map;
    renderer.reset();renderer.clipCamera=undefined;cameraCollision.reset();flight=undefined;pauseAudio();music.stop();Object.assign(settings,defaults);syncSettings();
    const result=await client.open(selection,loadingMap);
    renderer.configure(result.info.manifest);
    cameraCollision.configure(result.info.manifest);
    tuningValues=Array.isArray(result.info.tuning)?result.info.tuning.slice():TUNING_FIELDS.map(f=>f[1]);
    opened=true;
    if(remember)await rememberDataFolder(selection);
    evidence.info=result.info;evidence.source='local Data archives';
    $('welcome').hidden=true;enabled(true);running=true;
    loadingProgress({text:'Restoring local settings and saved position'});
    const save=await worldSave(result.info.id);
    const tune=await worldTuning(result.info.id);
    if(tune) {
      validateTuningRecord(tune);
      await client.request('tuning',{values:tune.values});
      tuningValues=tune.values.slice();settings.cameraSeconds=tune.cameraSeconds;
    }
    const restored=await restore(save);
    if(tune&&!restored)client.state=await client.request('reset');
    for(;;){
      const state=await client.request('frame',{dt:0,throttle:0,steer:0,flags:0,distant:settings.distant});
      client.state=state;
      const failed=state.scene.waitingCollisionDetails.find(item=>item.status!=='PENDING');
      if(failed)throw new Error(`Starting location collision unavailable: ${failed.key} (${failed.status})`);
      if(state.scene.waitingCollision&&state.scene.capacityBlocked)throw new Error('Starting collision cannot fit the scene budget');
      if(!state.required.every(i=>state.resident.includes(i)))throw new Error(state.failures.join('\n')||'Starting terrain unavailable');
      if(!state.scene.waitingCollision&&state.required.every(i=>renderer.tiles.has(i)))break;
      if(!$('error').hidden)throw new Error($('error').textContent);
      loadingProgress({text:`Preparing nearby scenery: ${state.scene.waitingCollision} collision assets remaining. Water: ${state.water.resident} tiles streamed.`});
      await new Promise(resolve=>setTimeout(resolve,16));
    }
    loading.close();
    evidence.ready=true;report(restored?'Loaded.':'',restored);canvas.focus();
  } catch(error) {
    fail(error);report('');
    if(opened){enabled(true);running=true;evidence.ready=true;}
    else {client.stop();$('welcome').hidden=false;}
  } finally {if(loading.open)loading.close();busy=false;$('select').disabled=false;}
}
async function select() {
  if(!renderer)return;
  try {
    if(permissionNeeded && folder) {
      if(!await authorizeDataFolder(folder,{request:true}))throw new Error('Read permission was not granted. Choose another Data folder or try again.');
      permissionNeeded=false;$('select').textContent='Choose Data';await open(folder,true);return;
    }
    if(!window.showDirectoryPicker){$('files').click();return;}
    const handle=await showDirectoryPicker({id:'vanilla-world-data',mode:'read'});
    folder=handle;await open(handle,true);
  } catch(error){fail(error);}
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
  try {await forgetDataFolder();folder=undefined;permissionNeeded=false;$('select').textContent='Choose Data';
    $('permission').textContent='Folder forgotten. World and saves retained.';}
  catch(error){fail(error);}
});
async function operation(action) {
  if(busy || !client.info)return;
  busy=true;client.discardFrame();
  try {await action();canvas.focus();}catch(error){fail(error);}finally{busy=false;}
}
$('save').addEventListener('click',()=>operation(async()=>{
  const state=await client.request('snapshot'),p=state.telemetry;
  const {cameraSeconds,...displaySettings}=settings;
  const record={version:1,layout:LAYOUT_VERSION,sourceId:client.info.id,
    mode:flight?'fly':'drive',vehicle:[p[0],p[1],p[2],p[3]],camera:flight?.slice(),settings:displaySettings};
  validateWorldSave(record,client.info.id);
  await worldSave(client.info.id,record);
  report('Saved.',true);
}));
$('load').addEventListener('click',()=>operation(async()=>{
  if(!await restore(await worldSave(client.info.id)))throw new Error('No save for this Data installation yet.');
  report('Loaded.',true);running=true;
}));
$('reset').addEventListener('click',()=>operation(async()=>{
  flight=undefined;client.state=await client.request('reset');renderer.camera=undefined;running=true;
  $('error').hidden=true;report('Reset. Save unchanged.',true);
}));
$('retry').addEventListener('click',()=>operation(async()=>{
  client.state=await client.request('retry');running=true;report('Retrying loading...',true);$('error').hidden=true;
}));
$('fly').addEventListener('click',()=>{
  const p=client.state?.telemetry;if(!p)return;
  flight=[p[0],p[1]+20,p[2]+20,p[3],-.25];canvas.focus();
});
$('overview').addEventListener('click',()=>{if(client.info){flight=overview(client.info.manifest);canvas.focus();}});
$('drive').addEventListener('click',()=>{flight=undefined;renderer.camera=undefined;canvas.focus();});
$('horizon').addEventListener('change',()=>{settings.horizon=$('horizon').checked;});
$('scenery').addEventListener('change',()=>{settings.scenery=$('scenery').checked;});
$('clouds').addEventListener('change',()=>{settings.clouds=$('clouds').checked;});
$('distant').addEventListener('change',()=>{settings.distant=$('distant').checked;});
function setNight(night) {
  settings.night=night;syncSettings();
  try{localStorage.setItem('racer.night',night?'1':'0');}catch{}
}
$('night').addEventListener('change',()=>{setNight($('night').checked);canvas.focus();});
$('control-profile').addEventListener('change',()=>{settings.controls=$('control-profile').value;keys.clear();input.keyboard();syncSettings();});
$('camera-distance').addEventListener('input',()=>{
  settings.cameraDistance=Number($('camera-distance').value);
  if(settings.cockpit){settings.cockpit=false;renderer.camera=undefined;}
});
$('music-volume').addEventListener('input',()=>music.setVolume(Number($('music-volume').value)/100));
$('sound').addEventListener('change',()=>{settings.sound=$('sound').checked;if(settings.sound)resumeAudio(true);else pauseAudio();canvas.focus();});
$('resume-sound').addEventListener('click',()=>{canvas.focus();resumeAudio(true);});
$('cockpit').addEventListener('click',cockpit);
for(const [i,field] of [...TUNING_FIELDS,['Chase damping (s)',.5]].entries()) {
  const label=document.createElement('label'),box=document.createElement('input');
  box.id=`tune-${i}`;box.type='number';box.step='any';box.min='0';box.required=true;box.value=field[1];
  label.append(document.createTextNode(field[0]),box);$('tuning-fields').append(label);
}
$('tuning').addEventListener('click',()=>operation(async()=>{
  tuningValues=Array.from(await client.request('tuning'));fillTuning(tuningValues,settings.cameraSeconds);
  $('tuning-status').textContent='';keys.clear();$('tuning-panel').showModal();
}));
$('tuning-form').addEventListener('submit',event=>{
  event.preventDefault();if(busy)return;
  busy=true;client.discardFrame();
  applyTuning({version:1,values:TUNING_FIELDS.map((_,i)=>Number($(`tune-${i}`).value)),cameraSeconds:Number($('tune-17').value)})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{busy=false;});
});
$('tuning-defaults').addEventListener('click',()=>{
  if(busy)return;busy=true;client.discardFrame();
  applyTuning({version:1,values:TUNING_FIELDS.map(f=>f[1]),cameraSeconds:.5})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{busy=false;});
});
$('tuning-close').addEventListener('click',()=>$('tuning-panel').close());
$('tuning-panel').addEventListener('close',()=>{keys.clear();canvas.focus();});
canvas.addEventListener('keydown',event=>{
  if(!event.repeat && event.code==='KeyN' && !event.ctrlKey && !event.altKey && !event.metaKey)setNight(!settings.night);
  if(DRIVE_KEYS.has(event.code)) {
    event.preventDefault();keys.add(event.code);if(!event.repeat)input.keyboard();
    if(!event.repeat && event.code==='F9')$('reset').click();
    if(!event.repeat && event.code==='KeyF' && !event.ctrlKey && !event.altKey)cockpit();
    if(!event.repeat && event.code==='KeyV' && event.ctrlKey && event.altKey && !event.shiftKey)cockpit();
    resumeAudio(true);
  }
});
canvas.addEventListener('pointerdown',event=>{
  canvas.focus();resumeAudio(true);
  if(event.button===2){dragging=true;canvas.setPointerCapture(event.pointerId);}
});
canvas.addEventListener('pointermove',event=>{if(dragging){orbit[0]+=event.movementX;orbit[1]+=event.movementY;}});
canvas.addEventListener('pointerup',()=>{dragging=false;});
canvas.addEventListener('lostpointercapture',()=>{dragging=false;});
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('wheel',event=>{if(running && !$('tuning-panel').open){event.preventDefault();zoom(-Math.sign(event.deltaY));}},{passive:false});
window.addEventListener('keyup',event=>keys.delete(event.code));
canvas.addEventListener('blur',()=>{keys.clear();orbit=[0,0];dragging=false;});
window.addEventListener('blur',()=>{keys.clear();pauseAudio();});
window.addEventListener('focus',()=>resumeAudio());
document.addEventListener('visibilitychange',()=>{keys.clear();last=0;if(document.hidden)pauseAudio();else resumeAudio();});
function frame(now) {
  requestAnimationFrame(frame);
  if(now-soundTime>250){syncSound();soundTime=now;}
  const dt=last?Math.min((now-last)/1000,.1):0;last=now;
  if(!running || !client.state || busy || document.hidden) {
    client.discardFrame();
    if(client.state){audio.update(client.state,{throttle:0,flags:1},0,false);music.update(client.state.area,false);}
    return;
  }
  try {
    const focused=document.hasFocus(),editing=$('tuning-panel').open;
    const accepts=document.activeElement===canvas && focused && !editing;
    const controls=input.sample(keys,testPads || Array.from(navigator.getGamepads?.() || []),accepts,settings.controls,!focused||!editing);
    if(controls.reset)$('reset').click();
    if(controls.flight)$(flight?'drive':'fly').click();
    if(controls.help)$('preferences').open=!$('preferences').open;
    if(controls.cockpit)cockpit();
    if(controls.zoom)zoom(controls.zoom);
    const cameraOrbit=orbit;orbit=[0,0];
    if(flight) {
      flight=moveFlight(flight,keys,dt);flight[3]-=cameraOrbit[0]*.004;
      flight[4]=Math.max(-1.55,Math.min(1.55,flight[4]-cameraOrbit[1]*.004));
    }
    if(!frozenPresentation)client.frame(dt,controls.throttle,controls.steer,controls.flags,flight?.slice(0,3),settings.distant,renderer.view);
    cameraCollision.frame(client.state,renderer.sceneRegion ?? client.state.telemetry[10]);
    const stats=renderer.draw(frozenPresentation || flight?client.state.telemetry:client.presentation(),flight,dt,frozenPresentation?0:now/1000,
      {...settings,cameraLook:controls.look,cameraOrbit},keys.has('KeyV')&&!keys.has('AltLeft')&&!keys.has('AltRight'));
    const cameraWarning=stats.cameraBlocked==='pending'?'Cockpit view waiting for nearby camera geometry.'
      :stats.cameraBlocked?'Cockpit view blocked by nearby geometry.':'';
    $('camera-blocked').hidden=!cameraWarning;
    if($('camera-blocked').textContent!==cameraWarning)$('camera-blocked').textContent=cameraWarning;
    const audible=document.hasFocus()&&!$('tuning-panel').open&&!flight&&!frozenPresentation;
    audio.update(client.state,controls,dt,audible);music.update(client.state.area,audible);evidence.music=music.snapshot();
    frames++;Object.assign(evidence,{frames,state:client.state,mode:flight?'fly':'drive',camera:flight?.slice(),render:stats,adapter:renderer.adapter});
    evidence.input={...controls,device:input.device};evidence.view=renderer.camera?.slice();
    evidence.cockpit={requested:settings.cockpit,active:renderer.cameraMode==='cockpit',available:stats.cockpitAvailable};
    evidence.cameraCollision={ready:cameraCollision.ready,terrainTiles:cameraCollision.tiles.size,triangles:(cameraCollision.tree?.vertices.length||0)/9};
    if(now-hudTime>250) {
      const s=client.state,p=s.telemetry,scene=s.scene;
      const held=!!scene?.waitingCollision || !!p[8];
      $('speed').textContent=flight?'FLY':p[5]<10000?p[5].toFixed(0).padStart(3,'0'):p[5].toExponential(1);
      $('direction').textContent=flight?'FREE':p[14]<-.1?'REV':p[14]>.1?'FWD':p[5]<.1?'IDLE':'--';
      $('drive-state').textContent=flight?'FLIGHT':scene?.waitingCollision||p[8]===1?'WAIT':p[8]===3?'CONTACT':p[8]===2?'NO GROUND':p[7]?'HOVER':'AIR';
      document.querySelector('.meters').dataset.held=String(held);
      $('boost').textContent=`${Math.round(p[6]*100)}%`;$('boost-meter').value=p[6];
      $('speed-meter').value=Math.min(1,p[5]/tuningValues[1]);
      $('drive').hidden=!flight;$('fly').hidden=!!flight;
      $('cockpit').setAttribute('aria-pressed',String(settings.cockpit&&!flight));
      $('motion').textContent=flight?'':scene?.waitingCollision||p[8]===1?'Loading nearby ground'
        :p[8]===2?'Unsupported surface':p[8]===3?'Obstacle or steep ground':'';
      if($('diagnostics').open) {
      $('input-device').textContent=input.device==='controller'?'Controller':'Keyboard';
      $('camera-status').textContent=flight?'Flight camera is collision-free':settings.cockpit
        ?cameraWarning||(renderer.cameraMode==='cockpit'?'Cockpit / exact posed seat':'Cockpit waiting for craft'):!cameraCollision.ready?'Chase clearance waiting for geometry'
        :cameraCollision.coverageLimited?'Chase distance limited to its collision window':'Vehicle-relative chase collision ready';
      $('place').textContent=flight?'FREE FLIGHT':p[10]===-1?'THE GREAT SEA':p[10]===1?'EASTERN KINGDOMS':'KALIMDOR';
      $('coordinates').textContent=`${(flight?.[0]??p[0]).toFixed(0)} E / ${(flight?.[2]??p[2]).toFixed(0)} S`;
      $('resident').textContent=`${s.resident.length}/${s.limit} terrain tiles · ${stats.horizonTiles} distant patches · ${stats.sceneInstances||0} scene instances`;
      $('population').textContent=scene?.population || 'Reading static population…';
      $('material-status').textContent=s.terrain
        ?`Terrain textures ${stats.texturedTerrainTiles}/${s.resident.length} · terrain cache ${(s.terrain.bytes/1048576).toFixed(1)} MiB · far minimaps ${s.terrain.minimaps}/${s.horizon.patches} (${s.terrain.farPending} pending, ${s.terrain.missingMinimaps?.length||0} unavailable previews, ${s.terrain.errors.length} resource errors)`
        :'Terrain material progress unavailable';
      if(s.water)$('material-status').textContent+=` · authored water ${s.water.resident} tiles / ${(s.water.bytes/1048576).toFixed(1)} MiB (${s.water.pending} pending${s.water.deferred?`, ${s.water.deferred} background deferrals`:''}${s.water.limited?', nearest-water cache full':''})`;
      $('details').textContent=`${client.info.archiveCount} local archives · ${((scene?.bytes||0)/1048576).toFixed(1)} MiB scene cache · ${scene?.pending||0} pending assets${scene?.capacityBlocked?' · scene capacity reached':''}${!flight&&scene?.waitingCollision?` · waiting for ${scene.waitingCollision} nearby collision assets`:''}${stats.gpuOmittedInstances?` · ${stats.gpuOmittedInstances} meshes beyond GPU budget`:''}`;
      if(s.distant?.scene)$('details').textContent+=` · distant worker ${(s.distant.scene.bytes/1048576).toFixed(1)} MiB / ${s.distant.scene.pending} pending${s.distant.scene.capacityBlocked?' / visual cache full':''}`;
      $('craft-status').textContent=stats.craftReady?`Authored racer display 10318 / ${stats.craftPose}`
        :stats.craftStatus==='failed'?'Player craft failed to load; temporary body remains':'Loading authored player craft; temporary body shown';
      }
      const errors=[...s.failures,...(s.distant?.failures||[]),...(s.distant?.scene?.errors||[]),...(s.terrain?.errors||[]),...(scene?.errors||[]),
        ...(stats.craftError?[`Player craft: ${stats.craftError}`]:[])].map(e=>typeof e==='string'?e:JSON.stringify(e));
      const missing=s.terrain?.missingMinimaps||[];
      $('resource-problems').querySelector('summary').textContent=[
        errors.length?`${errors.length} loading issues`:'',
        missing.length?`${missing.length} optional map previews unavailable`:'',
      ].filter(Boolean).join(' · ');
      $('problems').textContent=[...errors,...(missing.length?
        ['Optional map previews are absent from this installation. Terrain and collision are unaffected.',...missing]:[])].join('\n');
      $('resource-problems').hidden=!errors.length&&!missing.length;
      evidence.fps=(frames-hudFrames)*1000/(now-hudTime);hudFrames=frames;hudTime=now;
    }
  } catch(error){running=false;fail(error);}
}
async function start() {
  try {
    renderer=await WorldRenderer.create(canvas,error=>{running=false;fail(error);});
    $('select').disabled=false;$('fallback').disabled=false;evidence.started=performance.now();
    report('');
    if('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('./sw.js');
      $('offline').textContent='Offline ready.';
    }
    folder=await restoreDataFolder();
    if(folder) {
      if(await authorizeDataFolder(folder))await open(folder);
      else {permissionNeeded=true;$('select').textContent='Reconnect Data';
        $('permission').textContent='Reconnect to allow reading your remembered folder.';}
    }
    if(new URLSearchParams(location.search).has('test'))window.worldTest={
      focus:pose=>{flight=pose.slice();},
      instances:()=>renderer.instances.filter(i=>i.kind==='group').slice(0,8),
      npcs:()=>renderer.instances.filter(i=>i.id.includes(':npc:')).slice(0,5),
      request:async(action,fields)=>{const s=await client.request(action,fields);if(s.telemetry)client.state=s;return s;},
      gamepads:pads=>{testPads=pads;},
      freezePresentation:value=>{frozenPresentation=value;if(value)client.discardFrame();},
      audioRms:()=>{if(!audio.analyser)return 0;const samples=new Float32Array(audio.analyser.fftSize);audio.analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((n,s)=>n+s*s,0)/samples.length);},
    };
    requestAnimationFrame(frame);
  } catch(error){fail(error);}
}
start();
