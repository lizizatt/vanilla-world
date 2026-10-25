import {sanitiseScale,TIME_SCALES} from './sim-clock.js';
import {worldTuning} from './world-store.js';
import {deriveBudget,BUDGET_SETTINGS} from './memory-budget.js';
import {TUNING_FIELDS,validateTuningRecord} from './world-tuning.js';
export function installSettings(app) {
const {canvas,keys,input,audio,evidence,settings,gib,music,client}=app;
const $=id=>document.getElementById(id);
Object.assign(app,{applyMemoryBudget,syncSettings,syncSound,pauseAudio,resumeAudio,zoom,cockpit,});
try{gib.on=localStorage.getItem('racer.gib')!=='0';gib.overheat=localStorage.getItem('racer.overheat')!=='0';gib.durable=localStorage.getItem('racer.durability')!=='0';gib.speed=Math.max(20,Math.min(400,Number(localStorage.getItem('racer.gibSpeed'))||100));}catch{/* storage unavailable (private mode): setting is not persisted */}
try{settings.timeScale=sanitiseScale(localStorage.getItem('racer.timeScale')??1);settings.music=localStorage.getItem('racer.music')!=='0';settings.animateNpcs=localStorage.getItem('racer.animateNpcs')!=='0';settings.planet=localStorage.getItem('racer.planet')!=='0';settings.globeMesh=localStorage.getItem('racer.globeMesh')!=='0';settings.globeRegistry=localStorage.getItem('racer.globeRegistry')!=='0';{const cq=localStorage.getItem('racer.cloudQuality');if(cq==='high'||cq==='standard')settings.cloudQuality=cq;}const mv=localStorage.getItem('racer.masterVolume');if(mv!==null&&mv!==''&&Number.isFinite(Number(mv)))audio.setVolume(Number(mv)/100);}catch{/* storage unavailable (private mode): setting is not persisted */}
// Persisted outside settings so loading a world does not reset it.
function applyMemoryBudget() {
  let setting='auto';try{const v=localStorage.getItem('racer.memoryBudget');if(BUDGET_SETTINGS.includes(v))setting=v;}catch{/* storage unavailable (private mode): setting is not persisted */}
  $('memory-budget').value=setting;
  app.memoryBytes=deriveBudget({setting,deviceMemory:navigator.deviceMemory,heapLimit:performance.memory?.jsHeapSizeLimit});
  client.budget(app.memoryBytes);
}
$('memory-budget').addEventListener('change',()=>{try{localStorage.setItem('racer.memoryBudget',$('memory-budget').value);}catch{/* storage unavailable (private mode): setting is not persisted */}applyMemoryBudget();});
function syncSettings() {
  for(const key of ['horizon','scenery','distant','sound','clouds','planet'])$(key).checked=settings[key];
  $('particles').value=settings.particles;$('time-scale').value=String(TIME_SCALES.indexOf(sanitiseScale(settings.timeScale)));$('time-scale-label').textContent=sanitiseScale(settings.timeScale)?sanitiseScale(settings.timeScale)+'x':'Paused';$('cloud-quality').value=settings.cloudQuality;$('animate-npcs').checked=settings.animateNpcs;
  music.setEnabled(settings.music);$('music-on').checked=settings.music;
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
    active:audio.active&&!paused,masterGain:audio.master?.gain.value || 0,outGain:audio.out?.gain.value ?? -1,masterVolume:audio.volume,error:app.soundError};
  $('sound').checked=settings.sound;
  $('resume-sound').hidden=!settings.sound || !paused;
  $('sound-status').textContent=!settings.sound?'':app.soundError || (paused?'':app.flight?'Paused in flight':!audio.active?'Paused':'');
}
function pauseAudio() {
  app.soundAttempt++;audio.mute();app.soundError='';syncSound();
}
async function resumeAudio(gesture=false) {
  if(!settings.sound || (!gesture&&!audio.context) || (audio.enabled&&audio.context?.state==='running'))return;
  const attempt=++app.soundAttempt;app.soundError='';
  try {await audio.enable();}
  catch(error){
    if(attempt===app.soundAttempt){app.soundError=error.message || String(error);console.error('Sound could not start',error);}
  } finally {if(attempt===app.soundAttempt)syncSound();}
}
function zoom(steps) {
  if(settings.cockpit){settings.cockpit=false;app.renderer.camera=undefined;}
  settings.cameraDistance=Math.max(0,Math.min(50,settings.cameraDistance-steps));
  $('camera-distance').value=settings.cameraDistance;
}
function cockpit() {
  if(!app.running || app.busy)return;
  settings.cockpit=!!app.flight || !settings.cockpit;app.flight=undefined;
  app.renderer.camera=undefined;app.orbit=[0,0];canvas.focus();
  if(settings.cockpit&&!app.renderer.craft?.anchor)
    app.report(app.renderer.craft?'Cockpit unavailable: craft has no posed seat.':'Cockpit waiting for craft.',true);
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
  app.tuningValues=canonical.values;settings.cameraSeconds=canonical.cameraSeconds;
  app.running=true;$('error').hidden=true;
  fillTuning(app.tuningValues,settings.cameraSeconds);$('tuning-status').textContent='Saved.';
}
$('horizon').addEventListener('change',()=>{settings.horizon=$('horizon').checked;});
$('scenery').addEventListener('change',()=>{settings.scenery=$('scenery').checked;});
$('clouds').addEventListener('change',()=>{settings.clouds=$('clouds').checked;});
$('planet').addEventListener('change',()=>{settings.planet=$('planet').checked;try{localStorage.setItem('racer.planet',settings.planet?'1':'0');}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('animate-npcs').addEventListener('change',()=>{settings.animateNpcs=$('animate-npcs').checked;client.animate(settings.animateNpcs);try{localStorage.setItem('racer.animateNpcs',settings.animateNpcs?'1':'0');}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('time-scale').addEventListener('change',()=>{settings.timeScale=TIME_SCALES[Number($('time-scale').value)]??1;syncSettings();try{localStorage.setItem('racer.timeScale',String(settings.timeScale));}catch{/* storage unavailable (private mode): setting is not persisted */}canvas.focus();});
$('particles').addEventListener('change',()=>{settings.particles=$('particles').value;});
$('cloud-quality').addEventListener('change',()=>{settings.cloudQuality=$('cloud-quality').value;try{localStorage.setItem('racer.cloudQuality',settings.cloudQuality);}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('distant').addEventListener('change',()=>{settings.distant=$('distant').checked;});
$('control-profile').addEventListener('change',()=>{settings.controls=$('control-profile').value;keys.clear();input.keyboard();syncSettings();});
$('camera-distance').addEventListener('input',()=>{
  settings.cameraDistance=Number($('camera-distance').value);
  if(settings.cockpit){settings.cockpit=false;app.renderer.camera=undefined;}
});
$('music-on').addEventListener('change',()=>{settings.music=$('music-on').checked;music.setEnabled(settings.music);try{localStorage.setItem('racer.music',settings.music?'1':'0');}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('master-volume').value=String(Math.round(audio.volume*100));
$('master-volume').addEventListener('input',()=>{audio.setVolume(Number($('master-volume').value)/100);try{localStorage.setItem('racer.masterVolume',$('master-volume').value);}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('music-volume').addEventListener('input',()=>music.setVolume(Number($('music-volume').value)/100));
$('gib').addEventListener('change',()=>{gib.on=$('gib').checked;app.syncDurability();try{localStorage.setItem('racer.gib',gib.on?'1':'0');}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('gib-speed').addEventListener('input',()=>{gib.speed=Number($('gib-speed').value);app.syncDurability();$('gib-speed-label').textContent=gib.speed;try{localStorage.setItem('racer.gibSpeed',String(gib.speed));}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('durability').addEventListener('change',()=>{gib.durable=$('durability').checked;try{localStorage.setItem('racer.durability',gib.durable?'1':'0');}catch{/* storage unavailable (private mode): setting is not persisted */}app.syncDurability();});
$('overheat').addEventListener('change',()=>{gib.overheat=$('overheat').checked;try{localStorage.setItem('racer.overheat',gib.overheat?'1':'0');}catch{/* storage unavailable (private mode): setting is not persisted */}});
$('gib').checked=gib.on;
$('durability').checked=gib.durable;
$('overheat').checked=gib.overheat;
$('gib-speed').value=gib.speed;
$('gib-speed-label').textContent=gib.speed;
$('sound').addEventListener('change',()=>{settings.sound=$('sound').checked;if(settings.sound)resumeAudio(true);else pauseAudio();canvas.focus();});
$('resume-sound').addEventListener('click',()=>{canvas.focus();resumeAudio(true);});
$('cockpit').addEventListener('click',cockpit);
for(const [i,field] of [...TUNING_FIELDS,['Chase damping (s)',.5]].entries()) {
  const label=document.createElement('label'),box=document.createElement('input');
  box.id=`tune-${i}`;box.type='number';box.step='any';box.value=field[1];
  label.append(document.createTextNode(field[0]),box);$('tuning-fields').append(label);
}
$('tuning-panel').addEventListener('toggle',()=>{if($('tuning-panel').open)app.operation(async()=>{
  app.syncDurability();app.tuningValues=Array.from(await client.request('tuning'));fillTuning(app.tuningValues,settings.cameraSeconds);
  $('tuning-status').textContent='';
});});
$('tuning-fields').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('tuning-apply').click();}});
$('tuning-apply').addEventListener('click',()=>{
  if(app.busy)return;
  app.busy=true;client.discardFrame();
  applyTuning({version:1,values:TUNING_FIELDS.map((_,i)=>Number($(`tune-${i}`).value)),cameraSeconds:Number($('tune-17').value)})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{app.busy=false;});
});
$('tuning-defaults').addEventListener('click',()=>{
  if(app.busy)return;app.busy=true;client.discardFrame();
  applyTuning({version:1,values:TUNING_FIELDS.map(f=>f[1]),cameraSeconds:.5})
    .catch(error=>{$('tuning-status').textContent=error.message;}).finally(()=>{app.busy=false;});
});
}
