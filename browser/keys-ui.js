// Cheatsheet (F1), Controls page and Key Bindings page, all generated from keymap.js so the on-screen help cannot drift from the real bindings.
import {tablist} from './tablist.js';
import {sharedKeymap,cheatsheet,FILTERS,PROFILES,chordOf,actionById,keyLabel} from './keymap.js';

const el=(tag,props={},...kids)=>{const e=Object.assign(document.createElement(tag),props);for(const k of kids)e.append(k);return e;};
const keycap=text=>el('kbd',{textContent:text});

function sheetTable(keymap,filter,debug) {
  const root=el('div',{className:'sheet-groups'});
  for(const {category,rows} of cheatsheet(keymap,filter,{debug})) {
    const t=el('table',{className:'sheet'},el('caption',{textContent:category}));
    for(const r of rows) {
      const keys=el('td',{className:'sheet-keys'});
      if(filter==='pad')keys.textContent=r.pad;else if(r.keys.length)r.keys.forEach(k=>keys.append(keycap(k)));else keys.append(el('span',{className:'unbound',textContent:'unbound'}));
      t.append(el('tr',{},el('th',{scope:'row',textContent:r.label}),keys,el('td',{className:'sheet-pad',textContent:filter==='pad'?'':r.pad})));
    }
    root.append(t);
  }
  return root;
}

/** Filter tabs plus the grouped table. Re-renders itself when the filter changes. */
export function renderCheatsheet(host,keymap=sharedKeymap(),{debug=false,filter='all'}={}) {
  host.replaceChildren();
  const strip=tablist(document,{label:'Controls'});
  for(const f of FILTERS)strip.add(f.label,f.id,()=>{renderCheatsheet(host,keymap,{debug,filter:f.id});host.querySelector('[aria-selected=true]')?.focus();});
  strip.mark(strip.tabs[FILTERS.findIndex(f=>f.id===filter)]);
  host.append(strip.bar,sheetTable(keymap,filter,debug));
}

/** The editable list. Click a key slot, press the new key; Esc cancels, Backspace clears. A taken key is swapped, and the swap is said out loud. */
export function renderBindings(host,keymap,{onChange=()=>{},debug=false}={}) {
  let capture,note='';
  const draw=()=>{
    host.replaceChildren();
    const bar=el('div',{className:'bind-bar'});
    const profile=el('select',{id:'control-profile','aria-label':'Preset'});
    for(const [id,label] of Object.entries(PROFILES))profile.append(el('option',{value:id,textContent:label,selected:id===keymap.profile&&!keymap.custom}));
    if(keymap.custom)profile.append(el('option',{value:'custom',textContent:'Custom',selected:true,disabled:true}));
    profile.onchange=()=>{keymap.setProfile(profile.value);change();};
    bar.append(el('label',{textContent:'Preset '},profile),el('button',{type:'button',textContent:'Reset all',disabled:!keymap.custom,onclick:()=>{keymap.reset();note='All bindings reset.';change();}}));
    host.append(bar,el('p',{className:'bind-note',role:'status',textContent:capture?'Press a key… (Esc cancels, Backspace clears)':note}));
    for(const {category,rows} of cheatsheet(keymap,'all',{debug})) {
      const t=el('table',{className:'sheet bindings'},el('caption',{textContent:category}));
      for(const r of rows) {
        const a=actionById(r.id),slots=keymap.slots(r.id),cells=[el('th',{scope:'row',textContent:r.label})];
        for(const slot of [0,1]) {
          const active=capture?.id===r.id&&capture.slot===slot;
          cells.push(el('td',{},el('button',{type:'button',className:'slot'+(active?' capturing':''),textContent:active?'…':slots[slot]?keyLabel(slots[slot]):'—',disabled:!!a.fixed,
            title:a.fixed?'Fixed':'Click, then press a key',onclick:e=>{capture={id:r.id,slot};note='';draw();host.querySelector('.capturing')?.focus();}})));
        }
        cells.push(el('td',{},el('button',{type:'button',className:'reset-row',textContent:'Reset',hidden:!keymap.modified(r.id),'aria-label':`Reset ${r.label}`,onclick:()=>{keymap.reset(r.id);note=`${r.label} reset.`;change();}})));
        t.append(el('tr',{},...cells));
      }
      host.append(t);
    }
  };
  const change=()=>{capture=undefined;keymap.save();onChange();draw();};
  host.addEventListener('keydown',event=>{
    if(!capture)return;
    event.preventDefault();event.stopPropagation();
    if(event.code==='Escape'){capture=undefined;note='';draw();return;}
    if(['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight'].includes(event.code)&&!(actionById(capture.id).kind==='hold'))return;
    const {id,slot}=capture;
    if(event.code==='Backspace'){keymap.clear(id,slot);note=`${actionById(id).label} slot cleared.`;change();return;}
    const chord=chordOf(event),res=keymap.bind(id,slot,chord);
    note=!res.ok?`${keyLabel(chord)} can't be used.`:res.swapped.length?`${keyLabel(chord)} was ${res.swapped.map(s=>actionById(s).label).join(', ')}; swapped.`:`${actionById(id).label}: ${keyLabel(chord)}.`;
    change();
  },true);
  draw();
  return {redraw:draw,cancel:()=>{capture=undefined;draw();},get capturing(){return !!capture;}};
}

/** F1: hold to peek at the cheatsheet; with the menu open it jumps to the Controls page instead. Returns helpers for the menu. */
export function installCheatsheet(app) {
  const keymap=app.keymap??=sharedKeymap(),overlay=document.getElementById('cheatsheet'),body=overlay.querySelector('.sheet-body');
  const hide=()=>{overlay.hidden=true;};
  let noticed=false;
  const show=()=>{renderCheatsheet(body,keymap,{debug:app.debug});overlay.hidden=false;};
  window.addEventListener('keydown',event=>{
    if(app.running&&!noticed){
      noticed=true;
      try{if(!localStorage.getItem('racer.controlsNotice')){localStorage.setItem('racer.controlsNotice','1');app.report?.(`Controls changed: ${keymap.label('race.start')} starts a race, ${keymap.label('cam.cockpit')} cockpit, ${keymap.label('ui.flyDrive')} fly/drive. ${keymap.label('ui.cheatsheet')} shows all controls.`,true);}}catch{/* storage unavailable: the notice is skipped */}
    }
    if(!keymap.matches('ui.cheatsheet',event))return;
    event.preventDefault();if(event.repeat||!app.running)return;
    if(app.raceMenu?.open){app.openRaceMenu('controls');return;}
    show();
  },true);
  window.addEventListener('keyup',event=>{if(keymap.matches('ui.cheatsheet',event))hide();});
  window.addEventListener('blur',hide);
  return {show,hide};
}
