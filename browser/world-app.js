import {WorldClient} from './world-client.js';
import {WorldRenderer} from './world-renderer.js';
import {rememberDataFolder,restoreDataFolder,forgetDataFolder,authorizeDataFolder} from './asset-folder.js';
import {worldSave,worldTuning,validateWorldSave,LAYOUT_VERSION} from './world-store.js';
import {overview,moveFlight} from './flight.js';
import {WorldInput,DRIVE_KEYS} from './world-input.js';
import {WorldAudio} from './world-audio.js';
import {TUNING_FIELDS,validateTuningRecord} from './world-tuning.js';
import {CameraCollision} from './camera-collision.js';

const $=id=>document.getElementById(id),canvas=$('world'),keys=new Set();
const input=new WorldInput(),audio=new WorldAudio();
const cameraCollision=new CameraCollision();
const evidence={ready:false,frames:0,errors:[],mode:'drive'};
window.worldEvidence=evidence;
let renderer,folder,flight,running=false,busy=false,last=0,frames=0,hudTime=0,hudFrames=0,permissionNeeded=false;
let orbit=[0,0],dragging=false,soundStarting=false,testPads,frozenPresentation=false,tuningValues=TUNING_FIELDS.map(f=>f[1]);
const defaults={horizon:true,scenery:true,distant:true,controls:'native',cameraDistance:15,cameraSeconds:.5,sound:false};
const settings={...defaults};
const report=text=>{$('status').textContent=text;};
function fail(error) {
  if(error.name==='AbortError')return;
  const message=error.message || String(error);
  console.error(error);evidence.errors.push(message);$('error').textContent=message;$('error').hidden=false;
}
const client=new WorldClient(data=>{
  try {
    evidence.eventRevision=(evidence.eventRevision||0)+1;
    if(data.event==='progress')report(data.text);
    else {
      cameraCollision.event(data);
      if(data.event==='collision')renderer.clipCamera=(pivot,point,origin)=>cameraCollision.clip(pivot,point,origin);
      else renderer.event(data);
    }
  } catch(error){running=false;fail(error);}
},error=>{running=false;fail(error);});
function enabled(value) {
  for(const id of ['save','load','reset','retry','overview','fly','drive'])$(id).disabled=!value;
  $('tuning').disabled=!value || !Array.isArray(client.info?.tuning);
  $('cockpit').disabled=!value;
}
function syncSettings() {
  for(const key of ['horizon','scenery','distant','sound'])$(key).checked=settings[key];
  $('control-profile').value=settings.controls;$('camera-distance').value=settings.cameraDistance;
  $('keyboard-guide').textContent=settings.controls==='legacy'
    ?'Browser MVP keys retained: W/S thrust/reverse · A/D steer · Space brake · Shift boost · C/Ctrl drift · J hop.'
    :'Native keys: W thrust · S brake · A/D steer · Shift boost · Ctrl drift · Space hop. C/J remain drift/hop aliases. F9 resets without overwriting your save.';
}
async function resumeAudio() {
  if(!settings.sound || audio.enabled || soundStarting)return;
  soundStarting=true;
  try {await audio.enable();}catch(error){settings.sound=false;$('sound').checked=false;fail(error);}
  finally {soundStarting=false;}
}
function zoom(steps) {
  settings.cameraDistance=Math.max(0,Math.min(50,settings.cameraDistance-steps));
  $('camera-distance').value=settings.cameraDistance;
}
function cockpit() {
  report('Cockpit unavailable: no rider model is selected, so its head height and animated seat frame are unavailable.');
  evidence.cockpit={available:false,reason:'Selected rider head height and animated seat frame unavailable'};
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
  fillTuning(tuningValues,settings.cameraSeconds);$('tuning-status').textContent='Applied and saved for this Data installation.';
}
async function restore(save) {
  validateWorldSave(save,client.info.id);
  if(!save)return false;
  client.state=await client.request('restore',{pose:save.vehicle});
  Object.assign(settings,{distant:true,controls:'legacy',cameraDistance:15,sound:false},save.settings);syncSettings();
  flight=save.mode==='fly'?save.camera.slice():undefined;
  renderer.camera=undefined;
  return true;
}
async function open(selection,remember=false) {
  if(busy)return;
  busy=true;running=false;enabled(false);$('error').hidden=true;$('welcome').hidden=false;
  $('select').disabled=true;evidence.ready=false;
  let opened=false;
  try {
    renderer.reset();renderer.clipCamera=undefined;cameraCollision.reset();flight=undefined;audio.mute();Object.assign(settings,defaults);syncSettings();
    const result=await client.open(selection);
    renderer.configure(result.info.manifest);
    cameraCollision.configure(result.info.manifest);
    tuningValues=Array.isArray(result.info.tuning)?result.info.tuning.slice():TUNING_FIELDS.map(f=>f[1]);
    opened=true;
    if(remember)await rememberDataFolder(selection);
    evidence.info=result.info;evidence.source='local Data archives';
    $('welcome').hidden=true;enabled(true);running=true;
    const save=await worldSave(result.info.id);
    if(await restore(save))report('Restored your local world save.');
    else report('Thousand Needles raceway. Your world is read directly from local Data.');
    const tune=await worldTuning(result.info.id);
    if(tune) {
      validateTuningRecord(tune);
      await client.request('tuning',{values:tune.values});
      tuningValues=tune.values.slice();settings.cameraSeconds=tune.cameraSeconds;
    }
    evidence.ready=true;canvas.focus();
  } catch(error) {
    fail(error);
    if(opened){enabled(true);running=true;evidence.ready=true;}
    else client.stop();
  } finally {busy=false;$('select').disabled=false;}
}
async function select() {
  if(!renderer)return;
  try {
    if(permissionNeeded && folder) {
      if(!await authorizeDataFolder(folder,{request:true}))throw new Error('Read permission was not granted. Choose another Data folder or try again.');
      permissionNeeded=false;$('select').textContent='Change Data folder';await open(folder,true);return;
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
    $('permission').textContent='Directory-file mode: reselect Data after reload. Saves remain local.';
    open(files.map(file=>({path:file.webkitRelativePath || file.name,file})));
  }
});
$('forget').addEventListener('click',async()=>{
  try {await forgetDataFolder();folder=undefined;permissionNeeded=false;$('select').textContent='Select Data folder';
    $('permission').textContent='Folder no longer remembered. The current world stays open; saves are retained.';}
  catch(error){fail(error);}
});
async function operation(action) {
  if(busy || !client.info)return;
  busy=true;
  try {await action();canvas.focus();}catch(error){fail(error);}finally{busy=false;}
}
$('save').addEventListener('click',()=>operation(async()=>{
  const state=await client.request('snapshot'),p=state.telemetry;
  const {cameraSeconds,...displaySettings}=settings;
  await worldSave(client.info.id,{version:1,layout:LAYOUT_VERSION,sourceId:client.info.id,
    mode:flight?'fly':'drive',vehicle:[p[0],p[1],p[2],p[3]],camera:flight?.slice(),settings:displaySettings});
  report('Saved locally: vehicle, flight camera and display settings.');
}));
$('load').addEventListener('click',()=>operation(async()=>{
  if(!await restore(await worldSave(client.info.id)))throw new Error('No save for this Data installation yet.');
  report('Local save restored.');running=true;
}));
$('reset').addEventListener('click',()=>operation(async()=>{
  flight=undefined;client.state=await client.request('reset');renderer.camera=undefined;running=true;
  $('error').hidden=true;report('Returned to the Thousand Needles raceway. Existing save retained until you save.');
}));
$('retry').addEventListener('click',()=>operation(async()=>{
  client.state=await client.request('retry');running=true;report('Retrying unavailable terrain, scene assets and player craft.');$('error').hidden=true;
}));
$('fly').addEventListener('click',()=>{
  const p=client.state?.telemetry;if(!p)return;
  flight=[p[0],p[1]+20,p[2]+20,p[3],-.25];canvas.focus();
});
$('overview').addEventListener('click',()=>{if(client.info){flight=overview(client.info.manifest);canvas.focus();}});
$('drive').addEventListener('click',()=>{flight=undefined;renderer.camera=undefined;canvas.focus();});
$('horizon').addEventListener('change',()=>{settings.horizon=$('horizon').checked;});
$('scenery').addEventListener('change',()=>{settings.scenery=$('scenery').checked;});
$('distant').addEventListener('change',()=>{settings.distant=$('distant').checked;});
$('control-profile').addEventListener('change',()=>{settings.controls=$('control-profile').value;keys.clear();input.keyboard();syncSettings();});
$('camera-distance').addEventListener('input',()=>{settings.cameraDistance=Number($('camera-distance').value);});
$('sound').addEventListener('change',async()=>{settings.sound=$('sound').checked;if(settings.sound)await resumeAudio();else audio.mute();canvas.focus();});
$('cockpit').addEventListener('click',cockpit);
for(const [i,field] of [...TUNING_FIELDS,['Camera smoothing (s)',.5]].entries()) {
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
  busy=true;
  applyTuning({version:1,values:TUNING_FIELDS.map((_,i)=>Number($(`tune-${i}`).value)),cameraSeconds:Number($('tune-17').value)})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{busy=false;});
});
$('tuning-defaults').addEventListener('click',()=>{
  if(busy)return;busy=true;
  applyTuning({version:1,values:TUNING_FIELDS.map(f=>f[1]),cameraSeconds:.5})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{busy=false;});
});
$('tuning-close').addEventListener('click',()=>$('tuning-panel').close());
$('tuning-panel').addEventListener('close',()=>{keys.clear();canvas.focus();});
canvas.addEventListener('keydown',event=>{
  if(DRIVE_KEYS.has(event.code)) {
    event.preventDefault();keys.add(event.code);if(!event.repeat)input.keyboard();
    if(!event.repeat && event.code==='F9')$('reset').click();
    if(!event.repeat && event.code==='KeyV' && event.ctrlKey && event.altKey && !event.shiftKey)cockpit();
    resumeAudio();
  }
});
canvas.addEventListener('pointerdown',event=>{
  canvas.focus();resumeAudio();
  if(event.button===2){dragging=true;canvas.setPointerCapture(event.pointerId);}
});
canvas.addEventListener('pointermove',event=>{if(dragging){orbit[0]+=event.movementX;orbit[1]+=event.movementY;}});
canvas.addEventListener('pointerup',()=>{dragging=false;});
canvas.addEventListener('lostpointercapture',()=>{dragging=false;});
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('wheel',event=>{if(running && !$('tuning-panel').open){event.preventDefault();zoom(-Math.sign(event.deltaY));}},{passive:false});
window.addEventListener('keyup',event=>keys.delete(event.code));
canvas.addEventListener('blur',()=>{keys.clear();orbit=[0,0];dragging=false;});
window.addEventListener('blur',()=>{keys.clear();audio.mute();});
document.addEventListener('visibilitychange',()=>{keys.clear();last=0;if(document.hidden)audio.mute();});
function frame(now) {
  requestAnimationFrame(frame);
  const dt=last?Math.min((now-last)/1000,.1):0;last=now;
  if(!running || !client.state || busy || document.hidden) {
    if(client.state)audio.update(client.state,{throttle:0,flags:1},0,false);
    return;
  }
  try {
    const accepts=document.activeElement===canvas && document.hasFocus() && !$('tuning-panel').open;
    const controls=input.sample(keys,testPads || Array.from(navigator.getGamepads?.() || []),accepts,settings.controls);
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
    if(!frozenPresentation)client.frame(dt,controls.throttle,controls.steer,controls.flags,flight?.slice(0,3),settings.distant);
    cameraCollision.frame(client.state,renderer.sceneRegion ?? client.state.telemetry[10]);
    const stats=renderer.draw(client.state.telemetry,flight,dt,frozenPresentation?0:now/1000,
      {...settings,cameraLook:controls.look,cameraOrbit},keys.has('KeyV')&&!keys.has('AltLeft')&&!keys.has('AltRight'));
    audio.update(client.state,controls,dt,accepts&&!flight);
    frames++;Object.assign(evidence,{frames,state:client.state,mode:flight?'fly':'drive',camera:flight?.slice(),render:stats,adapter:renderer.adapter});
    evidence.input={...controls,device:input.device};evidence.view=renderer.camera?.slice();
    evidence.audio={enabled:audio.enabled,state:audio.context?.state || 'off',voices:audio.voices.length};
    evidence.cameraCollision={ready:cameraCollision.ready,terrainTiles:cameraCollision.tiles.size,triangles:(cameraCollision.tree?.vertices.length||0)/9};
    if(now-hudTime>250) {
      const s=client.state,p=s.telemetry,scene=s.scene;
      const held=!!scene?.waitingCollision || !!p[8];
      $('speed').textContent=flight?'FLY':p[5]<10000?p[5].toFixed(0).padStart(3,'0'):p[5].toExponential(1);
      $('direction').textContent=flight?'FREE':p[14]<-.1?'REV':p[14]>.1?'FWD':p[5]<.1?'IDLE':'--';
      $('drive-state').textContent=flight?'FREE FLIGHT':scene?.waitingCollision||p[8]===1?'COLLISION HOLD':p[8]===3?'SOLID CONTACT':p[8]===2?'NO SUPPORT':p[7]?'HOVER':'AIRBORNE';
      document.querySelector('.meters').dataset.held=String(held);
      $('boost').textContent=`${Math.round(p[6]*100)}%`;$('boost-meter').value=p[6];
      $('speed-meter').value=Math.min(1,p[5]/tuningValues[1]);
      $('input-device').textContent=input.device==='controller'?'STANDARD CONTROLLER':settings.controls==='native'?'NATIVE KEYBOARD':'BROWSER MVP KEYS';
      $('sound-status').textContent=!settings.sound?'Sound off':audio.enabled?`Engine audio ${audio.context.state}`:'Click the view to resume saved sound';
      $('camera-status').textContent=flight?'Flight camera is collision-free':!cameraCollision.ready?'Chase clearance waiting for geometry'
        :cameraCollision.coverageLimited?'Camera lag limited to its collision window':'Chase collision ready';
      $('motion').textContent=flight?'Free flight / vehicle remains parked':scene?.waitingCollision
        ?'Waiting for nearby collision geometry (not textures)'
        :['Drive / collision ready','Waiting for detailed terrain','Unsupported surface or terrain hole','Solid geometry or steep ground'][p[8]];
      $('place').textContent=flight?'FREE FLIGHT':p[10]===-1?'THE GREAT SEA':p[10]===1?'EASTERN KINGDOMS':'KALIMDOR';
      $('coordinates').textContent=`${(flight?.[0]??p[0]).toFixed(0)} E / ${(flight?.[2]??p[2]).toFixed(0)} S`;
      $('resident').textContent=`${s.resident.length}/4 terrain tiles · ${stats.horizonTiles} distant patches · ${scene?.instances||0} scene instances`;
      $('population').textContent=scene?.population || 'Reading static population…';
      $('material-status').textContent=s.terrain
        ?`Terrain textures ${stats.texturedTerrainTiles}/${s.resident.length} · terrain cache ${(s.terrain.bytes/1048576).toFixed(1)} MiB · far minimaps ${s.terrain.minimaps}/${s.horizon.patches} (${s.terrain.farPending} pending, ${s.terrain.errors.length} resource errors)`
        :'Terrain material progress unavailable';
      $('details').textContent=`${client.info.archiveCount} local archives · ${((scene?.bytes||0)/1048576).toFixed(1)} MiB scene cache · ${scene?.pending||0} pending assets${scene?.capacityBlocked?' · scene capacity reached':''}${!flight&&scene?.waitingCollision?` · waiting for ${scene.waitingCollision} nearby collision assets`:''}${stats.gpuOmittedInstances?` · ${stats.gpuOmittedInstances} meshes beyond GPU budget`:''}`;
      $('craft-status').textContent=stats.craftReady?`Authored racer display 10318 / ${stats.craftPose}`
        :stats.craftStatus==='failed'?'Player craft failed to load; temporary body remains':'Loading authored player craft; temporary body shown';
      $('problems').textContent=[...s.failures,...(s.distant?.failures||[]),...(s.terrain?.errors||[]),...(scene?.errors||[]),
        ...(stats.craftError?[`Player craft: ${stats.craftError}`]:[])].map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n');
      $('problems').hidden=!$('problems').textContent;
      evidence.fps=(frames-hudFrames)*1000/(now-hudTime);hudFrames=frames;hudTime=now;
    }
  } catch(error){running=false;fail(error);}
}
async function start() {
  try {
    renderer=await WorldRenderer.create(canvas,error=>{running=false;fail(error);});
    $('select').disabled=false;$('fallback').disabled=false;evidence.started=performance.now();
    report('Select your Classic 1.12 Data folder. Archives stay on your computer.');
    if('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('./sw.js');
      $('offline').textContent='Offline app shell enabled; local Data access still required.';
    }
    folder=await restoreDataFolder();
    if(folder) {
      if(await authorizeDataFolder(folder))await open(folder);
      else {permissionNeeded=true;$('select').textContent='Reconnect Data folder';
        $('permission').textContent='Your folder is remembered. Reconnect grants read permission for this session.';}
    }
    if(new URLSearchParams(location.search).has('test'))window.worldTest={
      focus:pose=>{flight=pose.slice();},
      instances:()=>renderer.instances.filter(i=>i.kind==='group').slice(0,8),
      npcs:()=>renderer.instances.filter(i=>i.id.includes(':npc:')).slice(0,5),
      request:async(action,fields)=>{const s=await client.request(action,fields);if(s.telemetry)client.state=s;return s;},
      gamepads:pads=>{testPads=pads;},
      freezePresentation:value=>{frozenPresentation=value;},
      audioRms:()=>{if(!audio.analyser)return 0;const samples=new Float32Array(audio.analyser.fftSize);audio.analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((n,s)=>n+s*s,0)/samples.length);},
    };
    requestAnimationFrame(frame);
  } catch(error){fail(error);}
}
start();
