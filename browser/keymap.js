// Single source of truth for every keyboard binding (design/ui-pass.md section 2.2). Pure: no DOM, so tests and the cheatsheet share it.
// Chords look like 'KeyG', 'F1' or 'Ctrl+Alt+KeyV' (event.code, optional modifiers). Held actions (kind 'hold') bind a bare code and are read with
// `down`/`canonical`; press actions fire once through `actionsFor`. Nothing else in the app reads event.code for gameplay or UI shortcuts.
export const BINDINGS_KEY='racer.bindings.v1';
export const CATEGORIES=Object.freeze(['Movement','Camera','Race','Interface','Editor','Debug']);
const MOD_CODES=new Set(['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight']);
export const RESERVED=Object.freeze(['Escape']);

const hold=(id,label,category,context,keys,canon,pad,legacy)=>({id,label,category,context,kind:'hold',keys,canon:canon??keys[0],pad,legacy});
const press=(id,label,category,context,keys,pad,extra)=>({id,label,category,context,kind:'press',keys,pad,...extra});

/** Native profile defaults; `legacy` overrides the keys for the Space-brakes preset. `canon` is the code the movement code reads for a held action. */
export const ACTIONS=Object.freeze([
  hold('drive.throttle','Throttle','Movement','drive',['KeyW'],undefined,'Right trigger'),
  hold('drive.reverse','Reverse / brake','Movement','drive',['KeyS'],undefined,'Left trigger'),
  hold('drive.left','Steer left','Movement','drive',['KeyA'],undefined,'Left stick'),
  hold('drive.right','Steer right','Movement','drive',['KeyD'],undefined,'Left stick'),
  hold('drive.boost','Boost','Movement','drive',['ShiftLeft','ShiftRight'],'ShiftLeft','✕ / A (pod) · RB'),
  hold('drive.drift','Drift','Movement','drive',['Space','KeyC'],'KeyC','□ / X (pod) · LB',['KeyC']),
  hold('drive.brake','Hard brake','Movement','drive',['KeyX'],undefined,'',['KeyX','Space']),
  hold('drive.hop','Hop','Movement','drive',['KeyJ'],undefined,'RB (pod) · A'),
  hold('drive.up','Pod pitch down / look up','Movement','drive',['ArrowUp'],undefined,'Left stick (pod)'),
  hold('drive.down','Pod pitch up / look down','Movement','drive',['ArrowDown'],undefined,'Left stick (pod)'),
  hold('cam.lookLeft','Look left','Camera','drive',['ArrowLeft'],undefined,'Right stick'),
  hold('cam.lookRight','Look right','Camera','drive',['ArrowRight'],undefined,'Right stick'),
  hold('cam.lookBack','Look back','Camera','drive',['KeyV']),
  press('cam.cockpit','Cockpit view','Camera','drive',['KeyH','Ctrl+Alt+KeyV'],'Right stick click'),
  press('drive.reset','Reset to raceway','Movement','drive',['F9'],'Y / △'),
  press('ui.flyDrive','Fly / Drive','Movement','ui',['Tab'],'Start'),
  hold('fly.forward','Forward','Movement','fly',['KeyW']),
  hold('fly.back','Back','Movement','fly',['KeyS']),
  hold('fly.left','Strafe left','Movement','fly',['KeyA']),
  hold('fly.right','Strafe right','Movement','fly',['KeyD']),
  hold('fly.up','Up','Movement','fly',['KeyE']),
  hold('fly.down','Down','Movement','fly',['KeyQ']),
  hold('fly.fast','Fast','Movement','fly',['ShiftLeft','ShiftRight'],'ShiftLeft'),
  hold('fly.nadir','Look straight down','Camera','fly',['KeyX']),
  hold('fly.lookLeft','Look left','Camera','fly',['ArrowLeft']),
  hold('fly.lookRight','Look right','Camera','fly',['ArrowRight']),
  hold('fly.lookUp','Look up','Camera','fly',['ArrowUp']),
  hold('fly.lookDown','Look down','Camera','fly',['ArrowDown']),
  press('race.start','Start race / race again','Race','race',['KeyR'],'',{when:'Near a race flag, or right after a race'}),
  press('ui.menu','Menu / back one layer','Interface','ui',['Escape'],'Back',{fixed:true}),
  press('ui.options','Options','Interface','ui',['KeyO']),
  press('ui.keybinds','Key bindings','Interface','ui',['KeyK']),
  press('ui.cheatsheet','Controls (hold)','Interface','ui',['F1'],'',{pressAndHold:true}),
  press('ui.map','World map','Interface','ui',['KeyM']),
  press('ui.garage','Garage','Interface','ui',['KeyG']),
  press('ui.editor','Track editor','Interface','ui',['KeyT']),
  press('ui.unstuck','Unstuck','Interface','ui',['KeyU'],'',{when:'Driving'}),
  press('ui.elune','Elune arrival','Interface','ui',['KeyL'],'',{when:'Shared space only'}),
  press('editor.add','Add gate','Editor','editor',['Digit1']),
  press('editor.select','Select / move','Editor','editor',['Digit2']),
  press('editor.start','Set start','Editor','editor',['Digit3']),
  press('editor.delete','Delete','Editor','editor',['Delete','Backspace']),
  press('editor.undo','Undo','Editor','editor',['Ctrl+KeyZ']),
  press('debug.pose','Export pose link','Debug','ui',['F8','Ctrl+Alt+KeyY'],'',{debug:true}),
  press('debug.wind','Wind tuning panel','Debug','ui',['Ctrl+Alt+KeyW'],'',{debug:true}),
  press('debug.crash','Test crash','Debug','ui',['Ctrl+Alt+KeyK'],'',{debug:true}),
]);
const BY_ID=new Map(ACTIONS.map(a=>[a.id,a]));
export const PROFILES=Object.freeze({native:'Drift on Space',legacy:'Brake on Space'});
export const FILTERS=Object.freeze([
  {id:'all',label:'All'},{id:'drive',label:'Driving',contexts:['drive']},{id:'fly',label:'Flight',contexts:['fly']},
  {id:'race',label:'Race',contexts:['race']},{id:'ui',label:'Interface',contexts:['ui','editor']},{id:'pad',label:'Gamepad'},
]);

// Two actions may share a key only when they can never be active together. Drive and fly never overlap; race starts while driving; ui is global.
export const contextsOverlap=(a,b)=>a===b||a==='ui'||b==='ui'||(a==='race'&&b==='drive')||(a==='drive'&&b==='race');

export function parseChord(chord) {
  const parts=String(chord).split('+'),code=parts.pop(),has=m=>parts.includes(m);
  return {ctrl:has('Ctrl'),alt:has('Alt'),shift:has('Shift'),meta:has('Meta'),code};
}
export const chordOf=e=>{
  if(MOD_CODES.has(e.code))return e.code;
  return (e.ctrlKey?'Ctrl+':'')+(e.altKey?'Alt+':'')+(e.shiftKey?'Shift+':'')+(e.metaKey?'Meta+':'')+e.code;
};
/** Ctrl/Alt/Meta must match exactly; Shift only matters when the chord names it (so a held boost key never blocks a shortcut). */
export function chordMatches(chord,e) {
  const c=parseChord(chord);
  return c.code===e.code&&c.ctrl===!!e.ctrlKey&&c.alt===!!e.altKey&&c.meta===!!e.metaKey&&(!c.shift||!!e.shiftKey);
}
const NAMES={Space:'Space',Escape:'Esc',Delete:'Del',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',ShiftLeft:'Left Shift',ShiftRight:'Right Shift',
  ControlLeft:'Left Ctrl',ControlRight:'Right Ctrl',AltLeft:'Left Alt',AltRight:'Right Alt',Backquote:'`',Minus:'-',Equal:'=',BracketLeft:'[',BracketRight:']',
  Semicolon:';',Quote:"'",Comma:',',Period:'.',Slash:'/',Backslash:'\\'};
export function keyLabel(chord) {
  if(!chord)return '';
  const c=parseChord(chord),base=NAMES[c.code]??c.code.replace(/^Key/,'').replace(/^Digit/,'').replace(/^Numpad/,'Num ');
  return (c.ctrl?'Ctrl+':'')+(c.alt?'Alt+':'')+(c.shift?'Shift+':'')+(c.meta?'Meta+':'')+base;
}

export class Keymap {
  constructor({profile='native',overrides={}}={}) {
    this.profile=profile in PROFILES?profile:'native';this.overrides={};
    for(const [id,slots] of Object.entries(overrides))if(this.#valid(id,slots))this.overrides[id]=[slots[0]||'',slots[1]||''];
    this.#prune();
  }
  #valid(id,slots) {
    const a=BY_ID.get(id);
    return !!a&&!a.fixed&&Array.isArray(slots)&&slots.length<=2&&slots.every(s=>typeof s==='string'&&(s===''||/^((Ctrl|Alt|Shift|Meta)\+)*[A-Za-z0-9]+$/.test(s)))&&!slots.some(s=>s&&RESERVED.includes(parseChord(s).code));
  }
  /** Default chords for an action under the current profile, as two slots. */
  preset(id) {
    const a=BY_ID.get(id),k=this.profile==='legacy'&&a.legacy?a.legacy:a.keys;
    return [k[0]||'',k[1]||''];
  }
  slots(id) {return this.overrides[id]?[...this.overrides[id]]:this.preset(id);}
  keys(id) {return this.slots(id).filter(Boolean);}
  #prune() {for(const id of Object.keys(this.overrides)){const p=this.preset(id);if(this.overrides[id][0]===p[0]&&this.overrides[id][1]===p[1])delete this.overrides[id];}}
  get custom() {return Object.keys(this.overrides).length>0;}
  get profileLabel() {return this.custom?'Custom':PROFILES[this.profile];}
  /** Applies a preset; the user's custom edits are kept only when `keep` (used when a saved world restores its own profile). */
  setProfile(profile,{keep=false}={}) {
    if(!(profile in PROFILES))return;
    this.profile=profile;if(!keep)this.overrides={};else this.#prune();
  }

  actionsFor(event,predicate=()=>true) {
    return ACTIONS.filter(a=>predicate(a)&&this.keys(a.id).some(c=>chordMatches(c,event)));
  }
  matches(id,event) {return this.keys(id).some(c=>chordMatches(c,event));}
  /** Held action: any of its keys is in the `held` set of event.code values. */
  down(id,held) {return this.keys(id).some(c=>held.has(parseChord(c).code));}
  /** The default code of every held action of `context` that is currently down, so movement code keeps reading fixed codes whatever the bindings. */
  canonical(held,context) {
    const out=new Set();
    for(const a of ACTIONS)if(a.kind==='hold'&&a.context===context&&this.down(a.id,held))out.add(a.canon);
    return out;
  }
  /** Every code the game wants to receive as keydown/keyup state (held actions and the Alt/modifier keys they depend on). */
  heldCodes() {
    const out=new Set(['AltLeft','AltRight']);
    for(const a of ACTIONS)if(a.kind==='hold')for(const c of this.keys(a.id))out.add(parseChord(c).code);
    return out;
  }
  label(id) {return keyLabel(this.keys(id)[0])||'unbound';}

  conflicts(id,chord) {
    const a=BY_ID.get(id),code=parseChord(chord);
    return ACTIONS.filter(o=>o.id!==id&&!o.fixed&&contextsOverlap(a.context,o.context)&&this.keys(o.id).some(c=>{const p=parseChord(c);return p.code===code.code&&p.ctrl===code.ctrl&&p.alt===code.alt&&p.meta===code.meta&&p.shift===code.shift;}));
  }
  /** Binds `chord` to a slot. A holder of the same key in an overlapping context gets the slot's previous key (swap). Returns {ok,swapped:[ids]}. */
  bind(id,slot,chord) {
    const a=BY_ID.get(id);
    if(!a||a.fixed||slot<0||slot>1)return {ok:false,swapped:[]};
    if(a.kind==='hold'){const c=parseChord(chord);chord=c.code;}
    if(chord&&RESERVED.includes(parseChord(chord).code))return {ok:false,swapped:[]};
    const mine=this.slots(id),old=mine[slot],swapped=[];
    if(chord)for(const o of this.conflicts(id,chord)) {
      const theirs=this.slots(o.id),at=theirs.findIndex(c=>c===chord);
      if(at<0)continue;
      theirs[at]=old&&o.kind==='hold'?parseChord(old).code:old||'';this.#store(o.id,theirs);swapped.push(o.id);
    }
    const other=mine[1-slot];
    if(chord&&other===chord)mine[1-slot]='';
    mine[slot]=chord||'';this.#store(id,mine);
    return {ok:true,swapped};
  }
  clear(id,slot) {return this.bind(id,slot,'');}
  #store(id,slots) {
    const p=this.preset(id);
    if(slots[0]===p[0]&&slots[1]===p[1])delete this.overrides[id];else this.overrides[id]=slots;
  }
  reset(id) {if(id)delete this.overrides[id];else this.overrides={};}
  resetCategory(category) {for(const a of ACTIONS)if(a.category===category)delete this.overrides[a.id];}
  modified(id) {return id in this.overrides;}

  toJSON() {return {v:1,profile:this.profile,overrides:this.overrides};}
  static parse(text) {
    try{const j=JSON.parse(text);return j&&j.v===1?new Keymap({profile:j.profile,overrides:j.overrides||{}}):new Keymap();}
    catch{return new Keymap();}
  }
  static load(storage=globalThis.localStorage) {
    try{const text=storage?.getItem(BINDINGS_KEY);return text?Keymap.parse(text):new Keymap();}catch{return new Keymap();}
  }
  save(storage=globalThis.localStorage) {
    try{if(this.custom||this.profile!=='native')storage?.setItem(BINDINGS_KEY,JSON.stringify(this));else storage?.removeItem(BINDINGS_KEY);}catch{/* storage unavailable (private mode): bindings are not persisted */}
  }
}

const presets={};
/** Shared preset instances for callers that only know a profile name (tests, headless sampling). */
export const presetKeymap=profile=>presets[profile]??=new Keymap({profile});
let shared;
/** The page's keymap, loaded once from storage. Every module that reacts to a shortcut asks this. */
export const sharedKeymap=()=>shared??=Keymap.load();

/** Rows for the cheatsheet and rebinding list, grouped by category. `filter` is one of FILTERS' ids. */
export function cheatsheet(keymap,filter='all',{debug=false}={}) {
  const f=FILTERS.find(x=>x.id===filter)??FILTERS[0],groups=new Map();
  for(const a of ACTIONS) {
    if(a.debug&&!debug)continue;
    if(f.id==='pad'?!a.pad:f.contexts&&!f.contexts.includes(a.context))continue;
    const row={id:a.id,label:a.label,context:a.context,keys:keymap.keys(a.id).map(keyLabel),pad:a.pad||'',when:a.when||'',modified:keymap.modified(a.id)};
    if(!groups.has(a.category))groups.set(a.category,[]);
    groups.get(a.category).push(row);
  }
  return CATEGORIES.filter(c=>groups.has(c)).map(category=>({category,rows:groups.get(category)}));
}
export const actionById=id=>BY_ID.get(id);
