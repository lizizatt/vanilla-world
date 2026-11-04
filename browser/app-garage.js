import {renderCheatsheet,installCheatsheet} from './keys-ui.js';
import {installTutorial} from './tutorial.js';
import {loadVehicleModel} from './vehicle-model.js';
import {writeChoice,tracksFor,VEHICLES,canSwitch,normalizeChoice,skinOf,stepSkin,garageIconVisible,ridePlan,TUNING_HOVER,ROCKET_DISPLAY} from './vehicles.js';
import {getSwe1r,attachSwe1r} from './swe1r/ui.js';
import {loadPodModel} from './swe1r/skin.js';
import {loadWowModel} from './wow-skin.js';
import {GaragePreview} from './garage-preview.js';
export function installGarage(app) {
const {canvas,keys,mapPanel,client}=app;
const $=id=>document.getElementById(id);
Object.assign(app,{openRaceMenu,applySkin,selectVehicle,renderGarage,openGarage,sendTuning,userTuning});
app.raceMenu=$('race-menu');installCheatsheet(app);app.tutorial=installTutorial(app);
function openRaceMenu(page='game') {
  if(app.raceMenu.open){menuTab(typeof page==='string'?page:'game');return;}
  keys.clear();app.dragging=false;app.mouseButtons=0;menuTab(typeof page==='string'?page:'game');
  $('race-restart').hidden=$('race-abandon').hidden=!app.race;$('menu-garage').hidden=!!app.race;$('race-editor').hidden=!!app.race;
  app.race?.pause(performance.now()/1000);app.raceMenu.showModal();
}
app.raceMenu.addEventListener('close',()=>{app.race?.resume(performance.now()/1000);canvas.focus();});
$('race-restart').addEventListener('click',()=>{const track=app.race?.track;app.raceMenu.close();app.race=undefined;if(track)app.startRace(track);});
$('race-abandon').addEventListener('click',()=>{app.race?.cancel('abandoned');app.raceMenu.close();});
$('race-editor').addEventListener('click',()=>{app.raceMenu.close();app.toggleEditor();});
const PAGE_TITLES={game:'Game Menu',options:'Options',keys:'Key Bindings',controls:'Controls',diagnostics:'Diagnostics',data:'Data & Saves'};
function menuTab(name) {
  if(!(name in PAGE_TITLES))name='game';
  if(name==='controls')renderCheatsheet($('controls-sheet'),app.keymap);
  for(const k of app.raceMenu.querySelectorAll('kbd[data-key]'))k.textContent=app.keymap.label(k.dataset.key);
  for(const page of app.raceMenu.querySelectorAll('[data-page]'))page.hidden=page.dataset.page!==name;
  $('race-menu-title').textContent=PAGE_TITLES[name];$('menu-back').hidden=name==='game';app.menuPage=name;
  (app.raceMenu.querySelector(`[data-page=${name}] :is(input,select,button)`)??app.raceMenu.querySelector('[autofocus]'))?.focus();
}
// Esc steps back one layer: a sub-page returns to the menu, the menu closes.
const escBack=event=>{if(app.menuPage&&app.menuPage!=='game'){event.preventDefault();menuTab('game');return true;}return false;};
app.raceMenu.addEventListener('cancel',escBack);
app.raceMenu.addEventListener('keydown',event=>{if(event.code==='Escape'&&!event.repeat&&escBack(event))event.stopPropagation();});
app.raceMenu.addEventListener('click',event=>{const tab=event.target.closest('[data-tab]');if(tab){event.preventDefault();menuTab(tab.dataset.tab);}});
app.raceMenu.addEventListener('click',event=>{if(event.target.closest('[data-close]'))app.raceMenu.close();});
$('menu-map').addEventListener('click',()=>{app.raceMenu.close();if(app.running)mapPanel.toggle();});
app.garage=$('garage');const glbPresent=new Map();
app.garagePick=undefined;
let skinToken=0;app.skinNote='';app.rideHover=undefined;
// Every tuning write goes through here: the loaded skin's ride height (if any) replaces the hover value sent to the sim and the craft is lowered to match. app.tuningValues always holds the user's own values.
async function sendTuning(values) {
  const plan=ridePlan(app.rideHover,values);
  const sent=await client.request('tuning',{values:plan.values});
  if(app.renderer)app.renderer.craftDrop=plan.drop;
  return sent;
}
// Tuning as the user set it: a read back from the sim carries the skin's hover, which is not the user's value.
function userTuning(read) {
  const values=Array.from(read);if(Number.isFinite(app.rideHover)&&app.tuningValues)values[TUNING_HOVER]=app.tuningValues[TUNING_HOVER];return values;
}
async function syncRide(hover) {
  if(app.rideHover===hover)return;
  app.rideHover=hover;
  if(client.info&&app.tuningValues)await sendTuning(app.tuningValues);
}
// Shipped GLB skins replace the Data rocket; any load failure keeps the Data rocket and says so in Diagnostics.
async function applySkin() {
  const token=++skinToken,skin=skinOf(app.choice);
  app.audio?.setPod(skin);
  if(!app.renderer)return;
  if(skin.source!=='glb'&&skin.source!=='swe1r'&&skin.source!=='wow'){app.skinNote='';app.renderer.setCraftOverride(undefined);await syncRide(skin.hover);return;}
  try{const model=skin.source==='swe1r'?await loadPodModel(getSwe1r(),skin):skin.source==='wow'?await loadWowModel(client,skin):await loadVehicleModel(skin);if(token===skinToken){app.renderer.setCraftOverride(model);app.skinNote='';await syncRide(skin.hover);}}
  catch(error){if(token===skinToken){app.renderer.setCraftOverride(undefined);await syncRide(undefined);app.skinNote=`Skin ${skin.name} unavailable (${error.message}); using the default craft`;app.report(app.skinNote,true);}}
}
function selectVehicle(next) {
  if(!canSwitch({race:app.race,editing:app.editor.isOpen}))return false;
  app.choice=normalizeChoice(next);writeChoice(app.choice);
  if(app.flight){app.flight=undefined;app.renderer.camera=undefined;}
  app.syncGates(true);applySkin();return true;
}
function glbAvailable(skin) {
  if(skin.source!=='glb')return true;
  if(!glbPresent.has(skin.id))glbPresent.set(skin.id,fetch(skin.model,{headers:{Range:'bytes=0-3'}}).then(async r=>r.ok&&new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()).slice(0,4))==='glTF').catch(()=>false).then(ok=>{glbPresent.set(skin.id,ok);if(app.garage.open)renderGarage();return ok;}));
  const known=glbPresent.get(skin.id);return known===true;
}
function renderGarage() {
  const v=VEHICLES[app.garagePick.vehicle];
  $('garage-tabs').replaceChildren(...Object.values(VEHICLES).map(x=>{
    const b=document.createElement('button');b.type='button';b.role='tab';b.textContent=x.name;b.dataset.vehicle=x.id;b.setAttribute('aria-selected',String(x.id===v.id));return b;}));
  const at=Math.max(0,v.skins.findIndex(s=>s.id===app.garagePick.skin)),cur=v.skins[at],arrow=(dir,text)=>{
    const b=document.createElement('button');b.type='button';b.textContent=text;b.dataset.step=dir;b.setAttribute('aria-label',dir<0?'Previous skin':'Next skin');b.disabled=v.skins.length<2;return b;},
    label=document.createElement('span');label.id='garage-skin-name';label.setAttribute('aria-live','polite');label.textContent=`${cur.name} \u00b7 ${at+1} / ${v.skins.length}`;
$('garage-skins').replaceChildren(arrow(-1,'\u2039'),label,arrow(1,'\u203a'));
  $('garage-stats').replaceChildren(...Object.entries(v.stats).map(([k,n])=>{
    const row=document.createElement('div'),bar=document.createElement('i');row.append(k,bar);bar.style.width=`${Math.round(n*100)}%`;return row;}));
  const list=tracksFor(app.tracks,v.id);
  $('garage-races').replaceChildren(...(v.races?list.map(t=>{const li=document.createElement('li');li.textContent=t.name||t.id;return li;}):[]));
  if(!list.length||!v.races){const li=document.createElement('li');li.textContent=v.races?'None yet':'No races';$('garage-races').append(li);}
  $('garage-use').disabled=!skinOf(app.garagePick)||!glbAvailable(skinOf(app.garagePick));
  updatePreview();
  $('garage-attach').hidden=app.garagePick.vehicle!=='podracer'||!!getSwe1r();
}
// Turntable of the highlighted skin. One preview at a time (own canvas + GL context), built only while the Garage is open and freed on close or skin change.
let preview,previewKey,previewToken=0;const payloads=new Map();
function previewPayload(skin) {
  if(!payloads.has(skin.id)){
    const load=skin.source==='data'?client.request('craft-model',{display:ROCKET_DISPLAY}):skin.source==='wow'?client.request('craft-model',{display:skin.display})
      :skin.source==='swe1r'?loadPodModel(getSwe1r(),skin):loadVehicleModel(skin);
    payloads.set(skin.id,load.catch(error=>{payloads.delete(skin.id);throw error;}));
  }
  return payloads.get(skin.id);
}
function closePreview() {
  previewToken++;previewKey=undefined;preview?.dispose();preview=undefined;payloads.clear();$('garage-preview-note').textContent='';
}
async function updatePreview() {
  const pick=app.garagePick,skin=skinOf(pick),key=`${pick.vehicle}/${pick.skin}`,note=$('garage-preview-note');
  if(!app.garage.open||key===previewKey)return;
  const token=++previewToken;previewKey=key;preview?.dispose();preview=undefined;
  if(!skin||skin.source==='none'||skin.source==='procedural'){note.textContent=skin?.source==='none'?'No vehicle body':'No preview';return;}
  if(!glbAvailable(skin)){note.textContent='Not available';return;}
  note.textContent='Loading preview...';
  try{
    const payload=await previewPayload(skin);
    if(token!==previewToken||!app.garage.open)return;
    preview=new GaragePreview($('garage-preview'),payload);$('garage-preview').append(note);note.textContent='';
  }catch(error){if(token===previewToken){$('garage-preview').append(note);note.textContent=`Preview unavailable (${error.message})`;}}
}
function openGarage() {
  if(!app.running||!canSwitch({race:app.race,editing:app.editor.isOpen}))return;
  keys.clear();app.dragging=false;app.mouseButtons=0;app.garagePick={...app.choice};renderGarage();app.garage.showModal();updatePreview();
}
$('garage-tabs').addEventListener('click',event=>{const b=event.target.closest('[data-vehicle]');if(b){app.garagePick=normalizeChoice({vehicle:b.dataset.vehicle,skin:b.dataset.vehicle===app.choice.vehicle?app.choice.skin:undefined});renderGarage();}});
function stepGarage(dir){const skins=VEHICLES[app.garagePick.vehicle].skins;app.garagePick={...app.garagePick,skin:stepSkin(skins,app.garagePick.skin,dir,glbAvailable)};renderGarage();}
$('garage-skins').addEventListener('click',event=>{const b=event.target.closest('[data-step]');if(b&&!b.disabled)stepGarage(+b.dataset.step);});
app.garage.addEventListener('keydown',event=>{const dir={ArrowLeft:-1,KeyA:-1,ArrowRight:1,KeyD:1}[event.code];if(dir&&!event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();stepGarage(dir);}});
$('garage-use').addEventListener('click',()=>{if(selectVehicle(app.garagePick))app.garage.close();});
$('garage-attach').addEventListener('click',attachSwe1r);
app.garage.addEventListener('close',()=>{closePreview();canvas.focus();});
$('hud-garage').addEventListener('click',openGarage);
$('menu-garage').addEventListener('click',()=>{app.raceMenu.close();openGarage();});
}
