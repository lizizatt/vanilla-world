import {WorldClient} from './world-client.js';
import {WorldRenderer} from './world-renderer.js';
import {rememberDataFolder,restoreDataFolder,forgetDataFolder,authorizeDataFolder} from './asset-folder.js';
import {worldSave,validateWorldSave,LAYOUT_VERSION} from './world-store.js';
import {overview,moveFlight} from './flight.js';

const $=id=>document.getElementById(id),canvas=$('world'),keys=new Set();
const controls=new Set(['KeyW','KeyS','KeyA','KeyD','KeyQ','KeyE','KeyC','KeyJ','KeyV','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight']);
const evidence={ready:false,frames:0,errors:[],mode:'drive'};
window.worldEvidence=evidence;
let renderer,folder,flight,running=false,busy=false,last=0,frames=0,hudTime=0,permissionNeeded=false;
const settings={horizon:true,scenery:true};
const report=text=>{$('status').textContent=text;};
function fail(error) {
  if(error.name==='AbortError')return;
  const message=error.message || String(error);
  console.error(error);evidence.errors.push(message);$('error').textContent=message;$('error').hidden=false;
}
const client=new WorldClient(data=>{
  if(data.event==='progress')report(data.text);else renderer.event(data);
},error=>{running=false;fail(error);});
function enabled(value) {
  for(const id of ['save','load','reset','retry','overview','fly','drive'])$(id).disabled=!value;
}
async function restore(save) {
  validateWorldSave(save,client.info.id);
  if(!save)return false;
  client.state=await client.request('restore',{pose:save.vehicle});
  Object.assign(settings,save.settings);$('horizon').checked=settings.horizon;$('scenery').checked=settings.scenery;
  flight=save.mode==='fly'?save.camera.slice():undefined;
  return true;
}
async function open(selection,remember=false) {
  if(busy)return;
  busy=true;running=false;enabled(false);$('error').hidden=true;$('welcome').hidden=false;
  $('select').disabled=true;evidence.ready=false;
  let opened=false;
  try {
    renderer.reset();flight=undefined;
    const result=await client.open(selection);
    renderer.configure(result.info.manifest);
    opened=true;
    if(remember)await rememberDataFolder(selection);
    evidence.info=result.info;evidence.source='local Data archives';
    $('welcome').hidden=true;enabled(true);running=true;
    const save=await worldSave(result.info.id);
    if(await restore(save))report('Restored your local world save.');
    else report('Thousand Needles raceway. Your world is read directly from local Data.');
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
  await worldSave(client.info.id,{version:1,layout:LAYOUT_VERSION,sourceId:client.info.id,
    mode:flight?'fly':'drive',vehicle:[p[0],p[1],p[2],p[3]],camera:flight?.slice(),settings:{...settings}});
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
  client.state=await client.request('retry');running=true;report('Retrying unavailable terrain.');$('error').hidden=true;
}));
$('fly').addEventListener('click',()=>{
  const p=client.state?.telemetry;if(!p)return;
  flight=[p[0],p[1]+20,p[2]+20,p[3],-.25];canvas.focus();
});
$('overview').addEventListener('click',()=>{if(client.info){flight=overview(client.info.manifest);canvas.focus();}});
$('drive').addEventListener('click',()=>{flight=undefined;renderer.camera=undefined;canvas.focus();});
$('horizon').addEventListener('change',()=>{settings.horizon=$('horizon').checked;});
$('scenery').addEventListener('change',()=>{settings.scenery=$('scenery').checked;});
canvas.addEventListener('keydown',event=>{if(controls.has(event.code)){event.preventDefault();keys.add(event.code);}});
window.addEventListener('keyup',event=>keys.delete(event.code));
canvas.addEventListener('blur',()=>keys.clear());
document.addEventListener('visibilitychange',()=>{keys.clear();last=0;});
function frame(now) {
  requestAnimationFrame(frame);
  const dt=last?Math.min((now-last)/1000,.1):0;last=now;
  if(!running || !client.state || busy || document.hidden)return;
  try {
    const down=code=>Number(keys.has(code));
    if(flight)flight=moveFlight(flight,keys,dt);
    const flags=down('Space') | ((down('ShiftLeft')||down('ShiftRight'))<<1) | (down('KeyC')<<2) | (down('KeyJ')<<3);
    client.frame(dt,down('KeyW')-down('KeyS'),down('KeyA')-down('KeyD'),flags,flight?.slice(0,3));
    const stats=renderer.draw(client.state.telemetry,flight,dt,now/1000,settings,keys.has('KeyV'));
    frames++;Object.assign(evidence,{frames,state:client.state,mode:flight?'fly':'drive',camera:flight?.slice(),render:stats,adapter:renderer.adapter});
    if(now-hudTime>250) {
      const s=client.state,p=s.telemetry,scene=s.scene;
      $('speed').textContent=flight?'FLY':scene?.waitingCollision||p[8]?'HOLD':p[5].toFixed(0);
      $('motion').textContent=flight?'Free flight / vehicle remains parked':scene?.waitingCollision
        ?'Waiting for nearby collision geometry (not textures)'
        :['Drive / collision ready','Waiting for detailed terrain','Unsupported surface or terrain hole','Solid bounds or steep ground'][p[8]];
      $('place').textContent=flight?'FREE FLIGHT':p[10]===-1?'THE GREAT SEA':p[10]===1?'EASTERN KINGDOMS':'KALIMDOR';
      $('coordinates').textContent=`${(flight?.[0]??p[0]).toFixed(0)} E / ${(flight?.[2]??p[2]).toFixed(0)} S`;
      $('resident').textContent=`${s.resident.length}/4 terrain tiles · ${stats.horizonTiles} distant patches · ${scene?.instances||0} nearby instances`;
      $('population').textContent=scene?.population || 'Reading static population…';
      $('details').textContent=`${client.info.archiveCount} local archives · ${((scene?.bytes||0)/1048576).toFixed(1)} MiB scene cache · ${scene?.pending||0} pending assets${scene?.capacityBlocked?' · scene capacity reached':''}${!flight&&scene?.waitingCollision?` · waiting for ${scene.waitingCollision} nearby collision assets`:''}${stats.gpuOmittedInstances?` · ${stats.gpuOmittedInstances} meshes beyond GPU budget`:''}`;
      $('problems').textContent=[...s.failures,...(scene?.errors||[])].map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n');
      $('problems').hidden=!$('problems').textContent;
      evidence.fps=frames*1000/(now-(evidence.started||now));hudTime=now;
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
    };
    requestAnimationFrame(frame);
  } catch(error){fail(error);}
}
start();
