import {WorldClient} from './world-client.js';
import {WorldRenderer} from './world-renderer.js';
import {rememberDataFolder,restoreDataFolder,forgetDataFolder,authorizeDataFolder} from './asset-folder.js';
import {worldSave,worldTuning,validateWorldSave,LAYOUT_VERSION,raceScores,trackOverride} from './world-store.js';
import {overview,moveFlight} from './flight.js';
import {WorldInput,DRIVE_KEYS} from './world-input.js';
import {WorldAudio} from './world-audio.js';
import {TUNING_FIELDS,validateTuningRecord,migrateTuning} from './world-tuning.js';
import {CameraCollision} from './camera-collision.js';
import {LoadingArt} from './loading-art.js';
import {MusicPlayer} from './world-music.js';
import {MapPanel} from './map-panel.js';
import {Race,unstuckPoses,formatTime,lapTimes,bearing,addScore,validScores,validateTrack} from './race.js';
import {createTrackEditor} from './track-editor.js';
import {clampTrack} from './track-edit.js';
import {loadTracks,nearestFlag,flagPosition} from './race-flags.js';
import {loadVehicleModel} from './vehicle-model.js';
import {bootChoice,writeChoice,tracksFor,vehicleOf,VEHICLES,canSwitch,normalizeChoice,skinOf,setRuntimeSkins,stepSkin} from './vehicles.js';
import {initSwe1rRow,onSwe1r,getSwe1r,attachSwe1r} from './swe1r/ui.js';
import {classifyPickError} from './swe1r/attach.js';
import {podSkinList,loadPodModel} from './swe1r/skin.js';
import {SFX,HEAT,STINGER,WIPEOUT_NAMES,wipeoutBlast,pickRaceMusic,loadSfx} from './swe1r/sfx.js';
import {pickVoice,raceEndEvents} from './swe1r/voice-map.js';
import {hitFlash,boostFx} from './swe1r/hud.js';
import {WRECK_CHUNK,WRECK_CHUNKS,gibTrigger,overheatTrigger} from './wreck.js';
import {loadHudSprites,loadCountdownSprites,createDial,createHeatGauge,lapText,lapTimesText,lapBanner,finishBanner} from './swe1r/hud.js';
const flashMem={},boostMem={};let dial,heatGauge,hudOn=false,countdownSprites;

const $=id=>document.getElementById(id),canvas=$('world'),keys=new Set();
const input=new WorldInput(),audio=new WorldAudio();
const cameraCollision=new CameraCollision();
const evidence={ready:false,frames:0,errors:[],mode:'drive'};
window.worldEvidence=evidence;
let choice=bootChoice(),tracks=[],race,raceBest,promptTrack,goUntil=0,boardTimer=0,againTrack,againUntil=0;
const raceAgain=()=>againTrack&&performance.now()<againUntil?againTrack:undefined;
let renderer,folder,flight,running=false,busy=false,last=0,frames=0,hudTime=0,hudFrames=0,permissionNeeded=false;
let orbit=[0,0],dragging=false,mouseButtons=0,soundAttempt=0,soundError='',soundTime=0,reportTimer,testPads,frozenPresentation=false,tuningValues=TUNING_FIELDS.map(f=>f[1]);
const defaults={horizon:true,scenery:true,distant:true,controls:'native',cameraDistance:15,cameraSeconds:.5,sound:true,cockpit:false,night:false,clouds:true,music:true,particles:'medium',animateNpcs:true};
const settings={...defaults};
const gib={on:true,speed:100,overheat:true},gibMem={};
try{gib.on=localStorage.getItem('racer.gib')!=='0';gib.overheat=localStorage.getItem('racer.overheat')!=='0';gib.speed=Math.max(20,Math.min(400,Number(localStorage.getItem('racer.gibSpeed'))||100));}catch{}
try{settings.night=localStorage.getItem('racer.night')==='1';settings.music=localStorage.getItem('racer.music')!=='0';settings.animateNpcs=localStorage.getItem('racer.animateNpcs')!=='0';}catch{}
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
const mapPanel=new MapPanel({dialog:$('map-panel'),canvas:$('map-canvas'),stage:$('map-stage'),status:$('map-status'),close:$('map-close')},{
  requestArt:names=>client.worldmap(names),pose:()=>client.state?.telemetry,
  teleport:icon=>operation(async()=>{
    flight=undefined;client.state=await client.request(icon.reset?'reset':'restore',icon.reset?undefined:{pose:icon.pose});race?.jump();
    renderer.camera=undefined;running=true;$('error').hidden=true;report(`Teleported to ${icon.label}.`,true);
  }),
});
mapPanel.dialog.addEventListener('close',()=>canvas.focus());
mapPanel.dialog.addEventListener('keydown',event=>{if(event.code==='KeyM'&&!event.repeat){event.preventDefault();mapPanel.toggle();}});
const music=new MusicPlayer({request:fields=>client.music(fields),context:()=>audio.context});
const client=new WorldClient(data=>{
  try {
    evidence.eventRevision=(evidence.eventRevision||0)+1;
    if(data.event==='progress'){if(!evidence.ready){report(data.text);loadingProgress(data);}}
    else if(data.event==='music')music.event(data);
    else if(data.event==='sky')renderer.setSky(data);
    else if(data.event==='sky-dome')renderer.setSkyDome(data);
    else if(data.event==='worldmap'||data.event==='worldmap-tiles')mapPanel.event(data);
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
function syncSettings() {
  for(const key of ['horizon','scenery','distant','sound','night','clouds'])$(key).checked=settings[key];
  $('particles').value=settings.particles;$('animate-npcs').checked=settings.animateNpcs;
  music.setNight(settings.night);music.setEnabled(settings.music);$('music-on').checked=settings.music;
  $('control-profile').value=settings.controls;$('camera-distance').value=settings.cameraDistance;
  $('keyboard-guide').textContent=settings.controls==='legacy'
    ?'W/S thrust/reverse · A/D steer · X/Space brake · J hop · Shift boost · C drift · U unstuck · F9 reset.'
    :'W/S thrust/reverse · A/D steer · X brake · J hop · Shift boost · Space/C drift · U unstuck · F9 reset.';
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
  const canonical={version:1,defaults:3,values:Array.from(values),cameraSeconds:Math.fround(record.cameraSeconds)};
  await worldTuning(client.info.id,canonical);
  await client.request('tuning',{values:canonical.values});
  tuningValues=canonical.values;settings.cameraSeconds=canonical.cameraSeconds;
  running=true;$('error').hidden=true;
  fillTuning(tuningValues,settings.cameraSeconds);$('tuning-status').textContent='Saved.';
}
async function restore(save) {
  validateWorldSave(save,client.info.id);
  if(!save)return false;
  client.state=await client.request('restore',{pose:save.vehicle});race?.jump();
  Object.assign(settings,{distant:true,controls:'legacy',cameraDistance:15,sound:true,cockpit:false,clouds:true},save.settings);syncSettings();
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
    renderer.configure(result.info.manifest);client.sky();client.animate(settings.animateNpcs);mapPanel.configure(result.info.manifest);
    void loadTracks().then(async found=>{shipped=found;tracks=await withOverrides(found);gateKey=undefined;});
    cameraCollision.configure(result.info.manifest);
    tuningValues=Array.isArray(result.info.tuning)?result.info.tuning.slice():TUNING_FIELDS.map(f=>f[1]);
    opened=true;
    if(remember)await rememberDataFolder(selection);
    evidence.info=result.info;evidence.source='local Data archives';
    $('welcome').hidden=true;enabled(true);running=true;
    loadingProgress({text:'Restoring local settings and saved position'});
    const save=await worldSave(result.info.id);
    const tune=migrateTuning(await worldTuning(result.info.id));
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
    evidence.ready=true;report(restored?'Loaded.':'',restored);canvas.focus();applySkin();
  } catch(error) {
    fail(error);report('');
    if(opened){enabled(true);running=true;evidence.ready=true;}
    else {client.stop();$('welcome').hidden=false;
      if(selection===folder&&selection?.kind==='directory'){folder=undefined;await forgetDataFolder().catch(()=>{});}}
  } finally {if(loading.open)loading.close();busy=false;$('select').disabled=false;}
}
// A remembered handle whose permission needs a click offers one continue button plus a way to pick another folder.
function showReconnect(on) {
  $('select').textContent=on?`Continue with ${folder.name}`:'Choose Data';$('different').hidden=!on;
}
$('different').addEventListener('click',async()=>{permissionNeeded=false;showReconnect(false);folder=undefined;await select();});
async function select() {
  if(!renderer)return;
  try {
    if(permissionNeeded && folder) {
      if(!await authorizeDataFolder(folder,{request:true}))throw new Error('Read permission was not granted. Choose another Data folder or try again.');
      permissionNeeded=false;showReconnect(false);await open(folder,true);return;
    }
    if(!window.showDirectoryPicker){$('files').click();return;}
    const handle=await showDirectoryPicker({id:'vanilla-world-data',mode:'read'});
    folder=handle;await open(handle,true);
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
  try {await forgetDataFolder();folder=undefined;permissionNeeded=false;showReconnect(false);
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
$('unstuck').addEventListener('click',()=>operation(async()=>{
  const p=client.state?.telemetry;if(!p)return;
  for(const pose of unstuckPoses(p)){
    try{client.state=await client.request('restore',{pose});flight=undefined;race?.jump();renderer.camera=undefined;running=true;report('Unstuck: moved 10 m up.',true);return;}catch{}
  }
  report('Unstuck failed: no free space above.',true);
}));
$('reset').addEventListener('click',()=>operation(async()=>{
  flight=undefined;client.state=await client.request('reset');race?.jump();renderer.camera=undefined;running=true;
  $('error').hidden=true;report('Reset. Save unchanged.',true);
}));
$('retry').addEventListener('click',()=>operation(async()=>{
  client.state=await client.request('retry');running=true;report('Retrying loading...',true);$('error').hidden=true;
}));
$('fly').addEventListener('click',()=>{
  const p=client.state?.telemetry;if(!p||race)return;
  flight=[p[0],p[1]+20,p[2]+20,p[3],-.25];canvas.focus();
});
$('overview').addEventListener('click',()=>{if(client.info&&!race){flight=overview(client.info.manifest);canvas.focus();}});
$('drive').addEventListener('click',()=>{flight=undefined;renderer.camera=undefined;canvas.focus();});
$('horizon').addEventListener('change',()=>{settings.horizon=$('horizon').checked;});
$('scenery').addEventListener('change',()=>{settings.scenery=$('scenery').checked;});
$('clouds').addEventListener('change',()=>{settings.clouds=$('clouds').checked;});
$('animate-npcs').addEventListener('change',()=>{settings.animateNpcs=$('animate-npcs').checked;client.animate(settings.animateNpcs);try{localStorage.setItem('racer.animateNpcs',settings.animateNpcs?'1':'0');}catch{}});
$('particles').addEventListener('change',()=>{settings.particles=$('particles').value;});
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
function syncHud(){hudOn=$('swe1r-hud-on').checked;document.querySelector('.speed-instrument').style.visibility=hudOn?'hidden':'';}
$('swe1r-hud-on').addEventListener('change',syncHud);
$('swe1r-sfx').addEventListener('change',()=>{audio.sampleOn=$('swe1r-sfx').checked;});
$('music-on').addEventListener('change',()=>{settings.music=$('music-on').checked;music.setEnabled(settings.music);try{localStorage.setItem('racer.music',settings.music?'1':'0');}catch{}});
$('music-volume').addEventListener('input',()=>music.setVolume(Number($('music-volume').value)/100));
$('gib').addEventListener('change',()=>{gib.on=$('gib').checked;try{localStorage.setItem('racer.gib',gib.on?'1':'0');}catch{}});
$('gib-speed').addEventListener('input',()=>{gib.speed=Number($('gib-speed').value);$('gib-speed-label').textContent=gib.speed;try{localStorage.setItem('racer.gibSpeed',String(gib.speed));}catch{}});
$('overheat').addEventListener('change',()=>{gib.overheat=$('overheat').checked;try{localStorage.setItem('racer.overheat',gib.overheat?'1':'0');}catch{}});
$('gib').checked=gib.on;$('overheat').checked=gib.overheat;$('gib-speed').value=gib.speed;$('gib-speed-label').textContent=gib.speed;
$('sound').addEventListener('change',()=>{settings.sound=$('sound').checked;if(settings.sound)resumeAudio(true);else pauseAudio();canvas.focus();});
$('resume-sound').addEventListener('click',()=>{canvas.focus();resumeAudio(true);});
$('cockpit').addEventListener('click',cockpit);
for(const [i,field] of [...TUNING_FIELDS,['Chase damping (s)',.5]].entries()) {
  const label=document.createElement('label'),box=document.createElement('input');
  box.id=`tune-${i}`;box.type='number';box.step='any';box.value=field[1];
  label.append(document.createTextNode(field[0]),box);$('tuning-fields').append(label);
}
$('tuning-panel').addEventListener('toggle',()=>{if($('tuning-panel').open)operation(async()=>{
  tuningValues=Array.from(await client.request('tuning'));fillTuning(tuningValues,settings.cameraSeconds);
  $('tuning-status').textContent='';
});});
$('tuning-fields').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('tuning-apply').click();}});
$('tuning-apply').addEventListener('click',()=>{
  if(busy)return;
  busy=true;client.discardFrame();
  applyTuning({version:1,values:TUNING_FIELDS.map((_,i)=>Number($(`tune-${i}`).value)),cameraSeconds:Number($('tune-17').value)})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{busy=false;});
});
$('tuning-defaults').addEventListener('click',()=>{
  if(busy)return;busy=true;client.discardFrame();
  applyTuning({version:1,values:TUNING_FIELDS.map(f=>f[1]),cameraSeconds:.5})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{busy=false;});
});
canvas.addEventListener('keydown',event=>{
  if(!event.repeat && event.code==='KeyK' && event.ctrlKey && event.altKey && running){event.preventDefault();testCrash();return;}
  if(!event.repeat && event.code==='KeyN' && !event.ctrlKey && !event.altKey && !event.metaKey)setNight(!settings.night);
  if(!event.repeat && event.code==='KeyM' && !event.ctrlKey && !event.altKey && !event.metaKey && running){event.preventDefault();mapPanel.toggle();}
  if(!event.repeat && event.code==='KeyU' && !event.ctrlKey && !event.altKey && !event.metaKey && running && !flight){event.preventDefault();$('unstuck').click();return;}
  if(!event.repeat && event.code==='KeyG' && !event.ctrlKey && !event.altKey && !event.metaKey && running){event.preventDefault();openGarage();return;}
  if(!event.repeat && event.code==='KeyT' && !event.ctrlKey && !event.altKey && !event.metaKey && running){event.preventDefault();toggleEditor();return;}
  if(!event.repeat && event.code==='Escape' && mapPanel.open){event.preventDefault();mapPanel.dialog.close();return;}
  if(!event.repeat && event.code==='Escape' && running && !raceMenu.open){event.preventDefault();openRaceMenu();return;}
  if(DRIVE_KEYS.has(event.code)) {
    event.preventDefault();keys.add(event.code);if(!event.repeat)input.keyboard();
    if(!event.repeat && event.code==='F9')$('reset').click();
    if(!event.repeat && event.code==='KeyF' && !event.ctrlKey && !event.altKey){const again=raceAgain();if(again&&!race)startRace(again);else if(promptTrack&&!race)startRace(promptTrack);else cockpit();}
    if(!event.repeat && event.code==='KeyV' && event.ctrlKey && event.altKey && !event.shiftKey)cockpit();
    resumeAudio(true);
  }
});
canvas.addEventListener('pointerdown',event=>{
  canvas.focus();resumeAudio(true);
  mouseButtons=event.buttons;if(event.button===0||event.button===2){dragging=true;canvas.setPointerCapture(event.pointerId);}
});
canvas.addEventListener('pointermove',event=>{if(dragging){mouseButtons=event.buttons;orbit[0]+=event.movementX;orbit[1]+=event.movementY;}});
canvas.addEventListener('pointerup',event=>{mouseButtons=event.buttons;dragging=!!(mouseButtons&3);});
canvas.addEventListener('lostpointercapture',()=>{dragging=false;mouseButtons=0;});
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('wheel',event=>{if(running){event.preventDefault();zoom(-Math.sign(event.deltaY));}},{passive:false});
window.addEventListener('keyup',event=>keys.delete(event.code));
canvas.addEventListener('blur',()=>{if(mapPanel.open)return;keys.clear();orbit=[0,0];dragging=false;mouseButtons=0;});
window.addEventListener('blur',()=>{keys.clear();pauseAudio();});
window.addEventListener('focus',()=>resumeAudio());
document.addEventListener('visibilitychange',()=>{keys.clear();last=0;if(document.hidden)pauseAudio();else resumeAudio();});
const raceMenu=$('race-menu');
function openRaceMenu() {
  keys.clear();dragging=false;mouseButtons=0;menuTab('game');
  $('race-restart').hidden=$('race-abandon').hidden=!race;$('menu-garage').hidden=!!race;$('race-editor').hidden=!!race;
  race?.pause(performance.now()/1000);raceMenu.showModal();
}
raceMenu.addEventListener('close',()=>{race?.resume(performance.now()/1000);canvas.focus();});
$('race-restart').addEventListener('click',()=>{const track=race?.track;raceMenu.close();race=undefined;if(track)startRace(track);});
$('race-abandon').addEventListener('click',()=>{race?.cancel('abandoned');raceMenu.close();});
$('race-editor').addEventListener('click',()=>{raceMenu.close();toggleEditor();});
function menuTab(name) {
  for(const tab of raceMenu.querySelectorAll('[data-tab]'))tab.setAttribute('aria-selected',String(tab.dataset.tab===name));
  for(const page of raceMenu.querySelectorAll('[data-page]'))page.hidden=page.dataset.page!==name;
}
$('menu-tabs').addEventListener('click',event=>{const tab=event.target.closest('[data-tab]');if(tab)menuTab(tab.dataset.tab);});
raceMenu.addEventListener('click',event=>{if(event.target.closest('[data-close]'))raceMenu.close();});
$('menu-map').addEventListener('click',()=>{raceMenu.close();if(running)mapPanel.toggle();});
const garage=$('garage'),glbPresent=new Map();
let garagePick;
let skinToken=0,skinNote='';
// Shipped GLB skins replace the Data rocket; any load failure keeps the Data rocket and says so in Diagnostics.
async function applySkin() {
  const token=++skinToken,skin=skinOf(choice);
  if(!renderer)return;
  if(skin.source!=='glb'&&skin.source!=='swe1r'){skinNote='';renderer.setCraftOverride(undefined);return;}
  try{const model=skin.source==='swe1r'?await loadPodModel(getSwe1r(),skin):await loadVehicleModel(skin);if(token===skinToken){renderer.setCraftOverride(model);skinNote='';}}
  catch(error){if(token===skinToken){renderer.setCraftOverride(undefined);skinNote=`Skin ${skin.name} unavailable (${error.message}); using the default craft`;report(skinNote,true);}}
}
const MiB=v=>((v||0)/1048576).toFixed(0);
function memoryLine(s,stats) {
  const heap=performance.memory?.usedJSHeapSize;
  return ` · ${heap?`JS heap ${MiB(heap)} MiB · `:''}wasm ${MiB(s.horizon?.wasmPeakBytes)} MiB · GPU terrain ${MiB(stats.terrainGpuBytes)} / scene ${MiB(stats.sceneGpuMeshBytes)} / coast water ${MiB(stats.coastalWaterGpuBytes)} MiB`;
}
function selectVehicle(next) {
  if(!canSwitch({race,editing:editor.isOpen}))return false;
  const wasFree=choice.vehicle==='free-flight';choice=normalizeChoice(next);writeChoice(choice);
  if(choice.vehicle==='free-flight'){if(!flight&&client.state){const p=client.state.telemetry;flight=[p[0],p[1]+20,p[2]+20,p[3],-.25];}}
  else if(wasFree||flight){flight=undefined;renderer.camera=undefined;}
  syncGates(true);applySkin();return true;
}
function glbAvailable(skin) {
  if(skin.source!=='glb')return true;
  if(!glbPresent.has(skin.id))glbPresent.set(skin.id,fetch(skin.model,{headers:{Range:'bytes=0-3'}}).then(async r=>r.ok&&new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()).slice(0,4))==='glTF').catch(()=>false).then(ok=>{glbPresent.set(skin.id,ok);if(garage.open)renderGarage();return ok;}));
  const known=glbPresent.get(skin.id);return known===true;
}
function renderGarage() {
  const v=VEHICLES[garagePick.vehicle];
  $('garage-tabs').replaceChildren(...Object.values(VEHICLES).map(x=>{
    const b=document.createElement('button');b.type='button';b.role='tab';b.textContent=x.name;b.dataset.vehicle=x.id;b.setAttribute('aria-selected',String(x.id===v.id));return b;}));
  const at=Math.max(0,v.skins.findIndex(s=>s.id===garagePick.skin)),cur=v.skins[at],arrow=(dir,text)=>{
    const b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.step=dir;b.setAttribute('aria-label',dir<0?'Previous skin':'Next skin');b.disabled=v.skins.length<2;return b;},
    label=document.createElement('span');label.id='garage-skin-name';label.setAttribute('aria-live','polite');label.textContent=`${cur.name} · ${at+1} / ${v.skins.length}`;
  $('garage-skins').replaceChildren(arrow(-1,'◀'),label,arrow(1,'▶'));
  $('garage-note').textContent=v.note;
  $('garage-stats').replaceChildren(...Object.entries(v.stats).map(([k,n])=>{
    const row=document.createElement('div'),bar=document.createElement('i');row.append(k,bar);bar.style.width=`${Math.round(n*100)}%`;return row;}));
  const list=tracksFor(tracks,v.id);
  $('garage-races').replaceChildren(...(v.races?list.map(t=>{const li=document.createElement('li');li.textContent=t.name||t.id;return li;}):[]));
  if(!list.length||!v.races){const li=document.createElement('li');li.textContent=v.races?'None yet':'No races';$('garage-races').append(li);}
  $('garage-use').disabled=!skinOf(garagePick)||!glbAvailable(skinOf(garagePick));
  $('garage-attach').hidden=garagePick.vehicle!=='podracer'||!!getSwe1r();
}
function openGarage() {
  if(!running||!canSwitch({race,editing:editor.isOpen}))return;
  keys.clear();dragging=false;mouseButtons=0;garagePick={...choice};renderGarage();garage.showModal();
}
$('garage-tabs').addEventListener('click',event=>{const b=event.target.closest('[data-vehicle]');if(b){garagePick=normalizeChoice({vehicle:b.dataset.vehicle,skin:b.dataset.vehicle===choice.vehicle?choice.skin:undefined});renderGarage();}});
function stepGarage(dir){const skins=VEHICLES[garagePick.vehicle].skins;garagePick={...garagePick,skin:stepSkin(skins,garagePick.skin,dir,glbAvailable)};renderGarage();}
$('garage-skins').addEventListener('click',event=>{const b=event.target.closest('[data-step]');if(b&&!b.disabled)stepGarage(+b.dataset.step);});
garage.addEventListener('keydown',event=>{const dir={ArrowLeft:-1,KeyA:-1,ArrowRight:1,KeyD:1}[event.code];if(dir&&!event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();stepGarage(dir);}});
$('garage-use').addEventListener('click',()=>{if(selectVehicle(garagePick))garage.close();});
$('garage-attach').addEventListener('click',attachSwe1r);
garage.addEventListener('close',()=>canvas.focus());
$('menu-garage').addEventListener('click',()=>{raceMenu.close();openGarage();});
let gateKey,editorFlight,shipped=[];
const mergeTrack=(list,t)=>list.some(x=>x.id===t.id)?list.map(x=>x.id===t.id?t:x):[...list,t];
const probeSurface=points=>client.request('probe',{points});
// Pull stale saved heights back above the current ground/water; unloaded tiles leave a point as saved.
async function groundTrack(track) {
  try {
    const pts=[track.start.pos,...track.gates.map(g=>g.pos)].map(p=>[p[0],p[2]]);
    return clampTrack(track,(await probeSurface(pts)).map(s=>({ground:s[1],water:s[2]})));
  } catch { return track; }
}
async function withOverrides(found) {
  let list=found;
  try {
    for(const id of (await trackOverride('~index'))||[]) {
      try{list=mergeTrack(list,validateTrack(await trackOverride(id)));}catch{}
    }
  } catch {}
  return list;
}
const editor=createTrackEditor({
  view:()=>renderer?.view,tracks:()=>tracks,shipped:()=>shipped.map(t=>t.id),probe:probeSurface,
  save:async track=>{
    await trackOverride(track.id,track);
    const ids=new Set((await trackOverride('~index'))||[]);ids.add(track.id);await trackOverride('~index',[...ids]);
    tracks=mergeTrack(tracks,track);
  },
  remove:async id=>{
    const ids=new Set((await trackOverride('~index'))||[]);ids.delete(id);await trackOverride('~index',[...ids]);await trackOverride(id,null);
    const base=shipped.find(t=>t.id===id);
    tracks=base?mergeTrack(tracks,base):tracks.filter(t=>t.id!==id);
  },
  test:track=>startRace(track),
  closed:()=>{flight=editorFlight;editorFlight=undefined;gateKey=undefined;keys.clear();canvas.focus();},
});
function toggleEditor() {
  if(race||!running||!client.state)return;
  if(editor.isOpen){editor.close();return;}
  keys.clear();dragging=false;mouseButtons=0;editorFlight=flight;
  editor.open(client.state.telemetry.slice(0,3));
}
let flagKey;
function syncGates(force) {
  const live=editor.isOpen?tracks:tracksFor(tracks,choice.vehicle);
  const key=live.map(t=>t.id).join()+'|'+(race?race.track.id+':'+race.next:'')+(editor.isOpen?'|'+editor.draft.id+':'+editor.draft.revision+':'+editor.selected:'');
  if(!force&&key===gateKey)return;
  gateKey=key;
  const racing=!editor.isOpen&&race;
  // The editor draws only the draft being edited; every other track shows as its flag.
  const items=editor.isOpen?editor.draft.gates.map((gate,i)=>({gate,next:i===editor.selected})):
    racing?[{gate:race.track.gates[race.gateIndex],next:true,finish:race.finishing}]:[];
  renderer.setGates(items);
  const own=editor.isOpen?editor.draft.id:racing?race.track.id:undefined;
  const spots=live.filter(t=>t.id!==own).map(flagPosition),fk=JSON.stringify(spots);
  if(fk!==flagKey){flagKey=fk;renderer.setFlags(spots);}
}
function startRace(track) {
  if(race||busy||!running||!client.info)return;
  if(vehicleOf(track)!==choice.vehicle)selectVehicle({vehicle:vehicleOf(track)});
  operation(async()=>{
    flight=undefined;
    track=await groundTrack(track);
    const [x,y,z]=track.start.pos;
    client.state=await client.request('restore',{pose:[x,y+2,z,track.start.yaw]});
    renderer.camera=undefined;running=true;$('error').hidden=true;
    const board=validScores(await raceScores(track.id).catch(()=>undefined));raceBest=board.runs[0];
    $('race-board').hidden=true;race=new Race(track);lastCount=0;lastLap=1;music.setBattle(true,false);music.loadCue('click');music.loadCue('quest');const t=performance.now()/1000;race.start(t);race.lined(t);promptTrack=undefined;
  });
}
let lastCount=0,voiceMap,voiceReader,lastVoice,lastLap=1;
let raceTune=null;
// Debug crash (Ctrl+Alt+K): the Rust wreck sim runs in the worker in 0.5 s chunks; the renderer replays the recorded poses.
let wreckBusy=false;
async function testCrash(auto=false,speed){
  if(wreckBusy||!client.state)return;
  const input=renderer.startWreck(client.state.telemetry,Math.floor(Math.random()*1e9),speed);
  if(!input)return;
  wreckBusy=true;
  if(auto&&audio.sampleOn){(audio.was??={}).crashAt=audio.context.currentTime;}
  if(auto&&audio.sampleOn)for(const n of wipeoutBlast(Object.keys(audio.samples?.buffers||{})))audio.cue(n,.9);
  try{
    await client.request('wreck-start',input);
    for(let i=0;i<WRECK_CHUNKS&&renderer.wreck;i++)renderer.wreckChunk(await client.request('wreck-run',{steps:WRECK_CHUNK}));
  }catch(error){renderer.endWreck();report(`Test crash failed: ${error.message}`,true);}
  wreckBusy=false;
}
async function stinger(name){if(!voiceReader)return;music.setBattle(false);audio.stopLoop();const b=await voiceReader.wav(Array.isArray(name)?name[Math.floor(Math.random()*name.length)]:name).catch(()=>null);if(b)audio.stinger(b);}
async function say(...events){const event=events.find(e=>voiceMap?.[e]?.length),id=event&&pickVoice(voiceMap,event,lastVoice);if(!id||!voiceReader)return;lastVoice=id;const b=await voiceReader.wav('Voice/'+id).catch(()=>null);if(b)audio.say(b);}
function raceFrame(controls,t) {
  if(race.state==='lineup'||race.state==='countdown'){controls.throttle=0;controls.steer=0;}
  const count=Math.ceil(race.countdown(t)),event=race.update(client.state.telemetry,t);
  if(race.lap>lastLap){lastLap=race.lap;banner(lapBanner(race.lap,race.track.laps,lapTimes(race.splits,race.track.gates.length)));say(race.lap===race.track.laps?'final-lap':'lap-new');}
  if(event==='go'){say('countdown-go');goUntil=t+.8;raceTune=voiceReader&&audio.sampleOn?pickRaceMusic():null;music.setBattle(true,!raceTune);if(raceTune)voiceReader.wav(raceTune).then(b=>b?audio.loopMusic(b):music.setBattle(true,true)).catch(()=>music.setBattle(true,true));music.playCue('quest');audio.cue(SFX.go);}
  else if(event==='gate')audio.cue(SFX.gate,.5);
  else if(race.state==='countdown'&&count!==lastCount){lastCount=count;say('countdown-'+count);music.playCue('click');audio.cue(SFX.beep);}
  const text=race.state==='countdown'?String(count):t<goUntil?'GO!':'';
  const box=$('race-countdown');
  const sprite=hudOn&&race.state==='countdown'&&countdownSprites?.[count];
  if(box.dataset.key!==text+(sprite?'s':'')){box.dataset.key=text+(sprite?'s':'');box.textContent=sprite?'':text;if(sprite){const c=sprite.cloneNode();c.getContext('2d').drawImage(sprite,0,0);box.append(c);}box.hidden=!text;}
  if(race.state==='finished'||race.state==='cancelled'){
    const finished=race.state==='finished',run=finished&&{time:race.time,splits:race.splits.slice(),date:new Date().toISOString()};
    const track=race.track;race=undefined;$('race-hud').hidden=true;
    if(finished){stinger(STINGER.win);audio.cue(SFX.finish,.8);say(...raceEndEvents(true,!raceBest||run.time<raceBest.time));recordRun(track,run);banner(finishBanner(!raceBest||run.time<raceBest.time));againTrack=track;againUntil=performance.now()+10000;}else{stinger(STINGER.wipeout);say(...raceEndEvents(false));report(`Race ${track.name||track.id} cancelled.`,true);}
  } else raceHud(t);
}
let bannerTimer;
function banner(text,ms=2500){if(!hudOn||!dial)return;const b=$('race-banner');b.textContent=text;b.hidden=false;clearTimeout(bannerTimer);bannerTimer=setTimeout(()=>{b.hidden=true;},ms);}
const setText=(id,value)=>{const e=$(id);if(e.textContent!==value)e.textContent=value;};
function raceHud(t) {
  $('race-hud').hidden=false;
  setText('race-time',formatTime(race.elapsed(t)));
  setText('race-best',raceBest?`Best ${formatTime(raceBest.time)}`:'No best yet');
  const done=race.splits.length,reference=raceBest?.splits[done-1];
  if(done&&reference!==undefined){const d=race.splits[done-1]-reference;setText('race-delta',`${d<0?'-':'+'}${Math.abs(d).toFixed(2)}`);$('race-delta').dataset.ahead=String(d<0);}
  else setText('race-delta','');
  setText('race-lap',hudOn&&dial?lapText(race.lap,race.track.laps):'');
  setText('race-laps',hudOn&&dial&&race.track.laps>1?lapTimesText(lapTimes(race.splits,race.track.gates.length),formatTime):'');
  setText('race-gate',`Gate ${Math.min(done+1,race.totalGates)}/${race.totalGates}`);
  const gate=race.nextGate,arrow=$('race-arrow');
  arrow.hidden=!gate;
  if(gate){const p=client.state.telemetry;arrow.style.transform=`rotate(${bearing(p,p[3],gate.pos)}rad)`;}
}
async function recordRun(track,run) {
  let record,rank;
  try {
    ({record,rank}=addScore(await raceScores(track.id).catch(()=>undefined),run));
    await raceScores(track.id,record);
  } catch(error) {
    report(`Time ${formatTime(run.time)} could not be saved: ${error.message}`,true);
    if(!record)({record,rank}=addScore(undefined,run));
  }
  const rows=record.runs.map((r,i)=>{const row=document.createElement('div');
    row.textContent=`${i+1}. ${formatTime(r.time)}${i===rank?'  <- this run':''}`;if(i===rank)row.className='this';return row;});
  const title=document.createElement('strong');title.textContent=`${track.name||track.id}: ${formatTime(run.time)}${rank===0?' (new best!)':''}`;
  $('race-board').replaceChildren(title,...rows);$('race-board').hidden=false;
  clearTimeout(boardTimer);boardTimer=setTimeout(()=>{$('race-board').hidden=true;},15000);
}
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
    const focused=document.hasFocus(),editing=raceMenu.open||editor.isOpen;
    const accepts=document.activeElement===canvas && focused && !editing;
    const controls={...input.sample(keys,testPads || Array.from(navigator.getGamepads?.() || []),accepts,settings.controls,!focused||!editing)};
    if(controls.reset)$('reset').click();
    if(controls.flight&&!race)$(flight?'drive':'fly').click();
    if(controls.help&&!editing)openRaceMenu();
    if(controls.cockpit)cockpit();
    if(controls.zoom)zoom(controls.zoom);
    const cameraOrbit=orbit;orbit=[0,0];const keyDrive=!!(controls.throttle||controls.steer),right=!flight&&!!(mouseButtons&2);
    if(renderer.wreck)Object.assign(controls,{throttle:0,steer:0,flags:0});
    if(right){controls.steer=Math.max(-1,Math.min(1,(renderer.chase?.[0]||0)*4));if(mouseButtons&1)controls.throttle=1;}
    if(flight) {
      flight=moveFlight(flight,keys,dt);flight[3]-=cameraOrbit[0]*.004;
      flight[4]=Math.max(-1.55,Math.min(1.55,flight[4]-cameraOrbit[1]*.004));
    }
    if(race){flight=undefined;if(!raceMenu.open)raceFrame(controls,now/1000);}
    if(editor.isOpen)flight=editor.pose();
    syncGates();
    if(!frozenPresentation)client.frame(dt,controls.throttle,controls.steer,controls.flags,flight?.slice(0,3),settings.distant,renderer.view);
    cameraCollision.frame(client.state,renderer.sceneRegion ?? client.state.telemetry[10]);
    renderer.fxInput={throttle:Math.max(0,controls.throttle),boosting:(controls.flags&2)!==0&&client.state.telemetry[6]>0,heat:dial?1-client.state.telemetry[6]:0,drifting:(controls.flags&4)!==0};
    const stats=renderer.draw(frozenPresentation || flight?client.state.telemetry:client.presentation(),flight,dt,frozenPresentation?0:now/1000,
      {...settings,cameraLook:controls.look,cameraOrbit,cameraSteer:right,cameraRecentre:keyDrive&&!dragging},keys.has('KeyV')&&!keys.has('AltLeft')&&!keys.has('AltRight'));
    editor.frame();
    const cameraWarning=stats.cameraBlocked==='pending'?'Cockpit view waiting for nearby camera geometry.'
      :stats.cameraBlocked?'Cockpit view blocked by nearby geometry.':'';
    $('camera-blocked').hidden=!cameraWarning;
    if($('camera-blocked').textContent!==cameraWarning)$('camera-blocked').textContent=cameraWarning;
    const audible=document.hasFocus()&&!flight&&!frozenPresentation;
    if(gibTrigger(gibMem,client.state.telemetry,gib.on,gib.speed,now,!!flight||!!frozenPresentation||editor.isOpen||wreckBusy)){flashMem.at=now/1000;flashMem.strength=1;void testCrash(true,gibMem.speed);}
    else if(dial&&overheatTrigger(gibMem,client.state.telemetry,(controls.flags&2)!==0,gib.overheat,now,!!flight||!!frozenPresentation||editor.isOpen||wreckBusy)){flashMem.at=now/1000;flashMem.strength=1;void testCrash(true,client.state.telemetry[5]);}
    const flash=dial&&hudOn&&!flight?hitFlash(flashMem,client.state.telemetry[8],client.state.telemetry[5],now/1000):0;$('boost-fx').hidden=!(dial&&hudOn&&!flight&&(boostFx(boostMem,(controls.flags&2)!==0,client.state.telemetry[6],dt)>0));if(!$('boost-fx').hidden)$('boost-fx').style.opacity=(boostMem.v*.8).toFixed(2);$('hit-flash').hidden=flash<=0;if(flash>0)$('hit-flash').style.opacity=flash.toFixed(2);
    audio.update(client.state,controls,dt,audible);if(dial){const on=hudOn&&!flight;$('swe1r-hud').hidden=!on;if(on)dial(Math.min(1,client.state.telemetry[5]/tuningValues[1]),client.state.telemetry[6]);$('swe1r-heat').hidden=!(on&&heatGauge);if(on&&heatGauge)heatGauge(1-client.state.telemetry[6],now/1000);}audio.setHeat(dial?1-client.state.telemetry[6]:0,(controls.flags&2)!==0);if(!race)music.setBattle(false);music.update(client.state.area,audible);evidence.music=music.snapshot();
    frames++;Object.assign(evidence,{frames,state:client.state,mode:flight?'fly':'drive',camera:flight?.slice(),render:stats,adapter:renderer.adapter});
    evidence.input={...controls,device:input.device};evidence.view=renderer.camera?.slice();
    evidence.cockpit={requested:settings.cockpit,active:renderer.cameraMode==='cockpit',available:stats.cockpitAvailable};
    evidence.cameraCollision={ready:cameraCollision.ready,terrainTiles:cameraCollision.tiles.size,triangles:(cameraCollision.tree?.vertices.length||0)/9};
    if(now-hudTime>250) {
      const s=client.state,p=s.telemetry,scene=s.scene;
      const held=!!scene?.waitingCollision || !!p[8];
      promptTrack=race||flight?undefined:nearestFlag(tracksFor(tracks,choice.vehicle),p);
      const again=race||flight?undefined:raceAgain();
      $('race-prompt').hidden=!promptTrack&&!again;if(again)$('race-prompt').textContent='Press F to race again';else if(promptTrack)$('race-prompt').textContent=`Press F to start race: ${promptTrack.name||promptTrack.id}`;
      $('speed').textContent=flight?'FLY':p[5]<10000?p[5].toFixed(0).padStart(3,'0'):p[5].toExponential(1);
      $('direction').textContent=flight?'FREE':p[14]<-.1?'REV':p[14]>.1?'FWD':p[5]<.1?'IDLE':'--';
      $('drive-state').textContent=flight?'FLIGHT':scene?.waitingCollision||p[8]===1?'WAIT':p[8]===3?'CONTACT':p[8]===2?'NO GROUND':p[7]?'HOVER':'AIR';
      document.querySelector('.meters').dataset.held=String(held);
      $('boost').textContent=`${Math.round(p[6]*100)}%`;$('boost-meter').value=p[6];
      $('speed-meter').value=Math.min(1,p[5]/tuningValues[1]);
      $('drive').hidden=!flight;$('fly').hidden=!!flight||!!race;
      $('cockpit').setAttribute('aria-pressed',String(settings.cockpit&&!flight));
      $('motion').textContent=flight?'':scene?.waitingCollision||p[8]===1?'Loading nearby ground'
        :p[8]===2?'Unsupported surface':p[8]===3?'Obstacle or steep ground':'';
      if(raceMenu.open&&!raceMenu.querySelector('[data-page=diagnostics]').hidden) {
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
      $('details').textContent+=memoryLine(s,stats);
      $('craft-status').textContent=skinNote||(stats.craftSource==='model'?`Vehicle model `+skinOf(choice).name:stats.craftReady?`Authored racer display 10318 / ${stats.craftPose}`
        :stats.craftStatus==='failed'?'Player craft failed to load; temporary body remains':'Loading authored player craft; temporary body shown');
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
    initSwe1rRow();
    onSwe1r(async r=>{
      if(!r){setRuntimeSkins('swe1r',[]);if(choice.skin.startsWith('swe1r-')){choice=normalizeChoice({...choice,skin:'rocket'});writeChoice(choice);applySkin();}garagePick=normalizeChoice(garagePick);dial=undefined;heatGauge=undefined;$('swe1r-heat').hidden=true;countdownSprites=undefined;voiceReader=undefined;$('swe1r-hud').hidden=true;syncHud();$('swe1r-hud-row').hidden=true;$('overheat-row').hidden=true;$('swe1r-sfx-row').hidden=true;audio.sampleOn=false;if(garage.open)renderGarage();return;}
      setRuntimeSkins('swe1r',podSkinList());if(garage.open)renderGarage();
      voiceReader=r;fetch('./swe1r/voice-map.json').then(x=>x.ok?x.json():{}).then(m=>{voiceMap=m;}).catch(()=>{});
      const raw=await loadSfx(r,[...Object.values(SFX),...WIPEOUT_NAMES,...HEAT.klaxon,HEAT.coolOn,HEAT.cool]).catch(()=>new Map());
      loadCountdownSprites(r).then(s=>{countdownSprites=s||undefined;}).catch(e=>console.error('SWE1R countdown',e));
  loadHudSprites(r).then(s=>{if(!s)return;dial=createDial(s,$('swe1r-hud'));heatGauge=s.heat&&createHeatGauge(s.heat,$('swe1r-heat'));$('swe1r-hud-row').hidden=false;$('overheat-row').hidden=false;syncHud();}).catch(e=>console.error('SWE1R HUD',e));
      if(raw.size){audio.sampleOn=$('swe1r-sfx').checked;$('swe1r-sfx-row').hidden=false;await audio.useSamples(raw);}});
    folder=await restoreDataFolder().catch(()=>undefined);
    if(folder) {
      if(await authorizeDataFolder(folder))await open(folder);
      else {permissionNeeded=true;showReconnect(true);
        $('permission').textContent='Click to allow reading your remembered folder.';}
    }
    if(new URLSearchParams(location.search).has('test'))window.worldTest={restore:pose=>client.request('restore',{pose}).then(s=>{client.state=s;flight=undefined;renderer.camera=undefined;running=true;return s.telemetry;}),particles:()=>renderer.particles,testCrash,wreck:()=>renderer.wreck&&{frames:renderer.wreck.frames.length,connected:renderer.wreck.connected,parts:renderer.wreck.parts.length},startRace,selectVehicle,tracks:()=>tracks,raceObj:()=>race,heldLoops:()=>Object.values(audio.held||{}).map(h=>h?.name).filter(Boolean),raceInfo:()=>race&&{state:race.state,next:race.next,finishing:race.finishing,gates:race.track.gates.length},choice:()=>choice,
      focus:pose=>{flight=pose.slice();},settings:o=>Object.assign(settings,o),showCraft:v=>{renderer.showCraftInFlight=v;},
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
