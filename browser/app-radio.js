import {RadioPlayer,clampVolume} from './radio.js';

// Hidden-YouTube radio wiring: persisted 'racer.radio' (on/off) and 'racer.radioVolume', controls in Options > Radio.
// While the radio plays, the game's zone music is muted (app.syncMusic) so the two never stack; sound effects are untouched.
export function installRadio(app) {
const {settings,music}=app;
const $=id=>document.getElementById(id);
const store=(k,v)=>{try{localStorage.setItem(k,v);}catch{/* storage unavailable (private mode): setting is not persisted */}};
let enabled=false,volume=50;
try{enabled=localStorage.getItem('racer.radio')==='1';const v=localStorage.getItem('racer.radioVolume');if(v!==null&&v!=='')volume=clampVolume(v);}catch{/* storage unavailable (private mode): setting is not persisted */}
function mount(){const host=document.createElement('div');host.id='radio-host';host.setAttribute('aria-hidden','true');document.body.append(host);const slot=document.createElement('div');host.append(slot);return slot;}
const radio=new RadioPlayer({mount,enabled,volume,onChange:render});
Object.assign(app,{radio,syncMusic});
function syncMusic(){music.setEnabled(settings.music&&!radio.playing);}
function render(){
  const s=radio.snapshot();
  $('radio-on').checked=s.enabled;
  for(const id of ['radio-prev','radio-play','radio-next'])$(id).disabled=!s.enabled||s.status==='unavailable';
  $('radio-play').textContent=s.playing?'Pause':'Play';
  $('radio-volume').value=String(s.volume);
  $('radio-title').textContent=s.status==='unavailable'?'Radio unavailable (offline or YouTube blocked)':s.enabled?(s.status==='loading'?'Loading...':s.title):'';
  syncMusic();
}
$('radio-on').addEventListener('change',()=>{const on=$('radio-on').checked;radio.setEnabled(on);store('racer.radio',on?'1':'0');if(on)radio.play();});
$('radio-play').addEventListener('click',()=>radio.toggle());
$('radio-prev').addEventListener('click',()=>radio.prev());
$('radio-next').addEventListener('click',()=>radio.next());
$('radio-volume').addEventListener('input',()=>{radio.setVolume($('radio-volume').value);store('racer.radioVolume',String(radio.volume));});
// Browsers block audio until a gesture: a persisted-on radio starts on the first click or key.
if(enabled){
  const start=()=>{removeEventListener('pointerdown',start,true);removeEventListener('keydown',start,true);radio.play();};
  addEventListener('pointerdown',start,true);addEventListener('keydown',start,true);
}
render();
}
