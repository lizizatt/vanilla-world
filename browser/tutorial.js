// First-login tutorial: a keyboard and a gamepad diagram generated from the keymap registry, so rebinds stay accurate.
import {ACTIONS,keyLabel} from './keymap.js';

export const TUTORIAL_KEY='racer.tutorialSeen';
export const TUTORIAL_CONTEXTS=Object.freeze(['drive','race','ui']);
export const KEY_ROWS=Object.freeze([
  ['Escape','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'],
  ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0'],
  ['KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP'],
  ['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL'],
  ['ShiftLeft','KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM','ShiftRight'],
  ['Space'],
  ['ArrowLeft','ArrowUp','ArrowDown','ArrowRight']
]);
/** Gamepad controls in drawing order; `test` picks the pad labels from keymap.js that belong to each. */
export const PAD_SLOTS=Object.freeze([
  {id:'lt',name:'LT',test:/^Left trigger/},{id:'rt',name:'RT',test:/^Right trigger/},
  {id:'lb',name:'LB',test:/^LB\b/},{id:'rb',name:'RB',test:/^RB\b/},
  {id:'ls',name:'Left stick',test:/^Left stick/},{id:'rs',name:'Right stick',test:/^Right stick$/},
  {id:'r3',name:'Right stick click',test:/^Right stick click/},
  {id:'y',name:'Y / △',test:/^Y \/ △/},{id:'a',name:'✕ / A',test:/^✕ \/ A|^A$/},{id:'x',name:'□ / X',test:/^□ \/ X/},
  {id:'back',name:'Back',test:/^Back$/},{id:'start',name:'Start',test:/^Start$/}
]);

const tutorialActions=()=>ACTIONS.filter(a=>!a.debug&&TUTORIAL_CONTEXTS.includes(a.context));

/** Key caps for each row, each with the actions currently bound to it (Shift/Ctrl chords are marked in the text). */
export function keyboardModel(keymap) {
  const by=new Map();
  for(const a of tutorialActions())for(const chord of keymap.keys(a.id)) {
    const m=/^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(.+)$/.exec(chord),code=m?.[1];
    if(!code)continue;
    const mods=chord.slice(0,chord.length-code.length);
    if(!by.has(code))by.set(code,[]);
    const list=by.get(code),text=mods?`${mods.slice(0,-1)}: ${a.label}`:a.label;
    if(!list.some(x=>x.id===a.id&&x.text===text))list.push({id:a.id,text,category:a.category});
  }
  return KEY_ROWS.map(row=>row.map(code=>({code,label:keyLabel(code),actions:by.get(code)??[]})));
}

/** One entry per gamepad control with the actions on it, taken from the registry's pad labels. */
export function padModel() {
  const slots=PAD_SLOTS.map(s=>({...s,actions:[]}));
  for(const a of tutorialActions()) {
    if(!a.pad)continue;
    for(const part of a.pad.split(' · ')) {
      const slot=slots.find(s=>s.test.test(part));
      const note=/\(pod\)/.test(part)?' (pod)':'';
      if(slot&&!slot.actions.some(x=>x.id===a.id))slot.actions.push({id:a.id,text:a.label+note,category:a.category});
    }
  }
  return slots.map(({id,name,actions})=>({id,name,actions}));
}

export const tutorialSeen=(storage=globalThis.localStorage)=>{try{return storage.getItem(TUTORIAL_KEY)==='1';}catch{return true;}};
export const markTutorialSeen=(storage=globalThis.localStorage)=>{try{storage.setItem(TUTORIAL_KEY,'1');}catch{/* storage unavailable: it will show again next time */}};
/** Plain R dismisses; Shift+R is the radio and must not. */
export const isDismissKey=event=>event.code==='KeyR'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey;

const el=(doc,tag,cls,text)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};

export function renderTutorial(host,keymap,doc=host.ownerDocument) {
  host.replaceChildren();
  const kb=el(doc,'div','tut-keyboard');kb.setAttribute('role','img');kb.setAttribute('aria-label','Keyboard bindings');
  for(const row of keyboardModel(keymap)) {
    const r=el(doc,'div','tut-row');
    for(const key of row) {
      const k=el(doc,'div',`tut-key${key.actions.length?' bound':''}${key.code==='Space'?' space':''}`);
      k.dataset.code=key.code;
      k.append(el(doc,'b','',key.label));
      if(key.actions.length){
        k.append(el(doc,'span','',key.actions.map(a=>a.text).join(' / ')));
        k.title=key.actions.map(a=>a.text).join('\n');
        k.dataset.cat=key.actions[0].category;
      }
      r.append(k);
    }
    kb.append(r);
  }
  const pad=el(doc,'div','tut-pad');pad.setAttribute('role','img');pad.setAttribute('aria-label','Gamepad bindings');
  for(const slot of padModel()) {
    const c=el(doc,'div',`tut-btn tut-${slot.id}${slot.actions.length?' bound':''}`);
    c.dataset.pad=slot.id;
    c.append(el(doc,'b','',slot.name));
    if(slot.actions.length)c.append(el(doc,'span','',slot.actions.map(a=>a.text).join(' / ')));
    pad.append(c);
  }
  host.append(el(doc,'h3','','Keyboard'),kb,el(doc,'h3','','Gamepad'),pad);
}

/** Shows the tutorial once (flag persisted); R or Esc dismisses it without reaching the game. Returns open/close for the menu. */
export function installTutorial(app) {
  const doc=document,overlay=doc.getElementById('tutorial'),body=overlay.querySelector('.tut-body');
  overlay.querySelector('.tut-foot').textContent='Press R to dismiss, find again in the menu.';
  const open=()=>{renderTutorial(body,app.keymap);overlay.hidden=false;};
  const close=()=>{if(overlay.hidden)return;overlay.hidden=true;markTutorialSeen();};
  window.addEventListener('keydown',event=>{
    if(overlay.hidden||!(isDismissKey(event)||event.code==='Escape'))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(!event.repeat)close();
  },true);
  overlay.addEventListener('click',close);
  if(!tutorialSeen()) {
    const timer=setInterval(()=>{if(app.running&&!app.raceMenu?.open){clearInterval(timer);if(!tutorialSeen())open();}},500);
  }
  return {open,close};
}
