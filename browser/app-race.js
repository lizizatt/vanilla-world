import {raceScores,trackOverride} from './world-store.js';
import {Race,unstuckPoses,formatTime,lapTimes,bearing,addScore,validScores,validateTrack} from './race.js';
import {createTrackEditor} from './track-editor.js';
import {clampTrack} from './track-edit.js';
import {flagPosition} from './race-flags.js';
import {gateScene,sceneKey,sceneProps,startLine} from './race-gates.js';
import {tracksFor,vehicleOf} from './vehicles.js';
import {SFX,STINGER,wipeoutBlast,pickRaceMusic} from './swe1r/sfx.js';
import {pickVoice,raceEndEvents} from './swe1r/voice-map.js';
import {WRECK_CHUNK,WRECK_CHUNKS} from './wreck.js';
import {lapCount,lapTimesText,lapBanner,finishBanner} from './swe1r/hud.js';
export function installRace(app) {
const {canvas,keys,audio,music,client}=app;
const $=id=>document.getElementById(id);
Object.assign(app,{withOverrides,toggleEditor,syncGates,startRace,respawn,testCrash,raceFrame});
app.raceAgain=()=>app.againTrack&&performance.now()<app.againUntil?app.againTrack:undefined;
app.gateKey=undefined;app.gateKit=undefined;let editorFlight;app.shipped=[];
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
      try{list=mergeTrack(list,validateTrack(await trackOverride(id)));}catch{/* a bad override is skipped */}
    }
  } catch {/* no override index: keep the built-in tracks */}
  return list;
}
app.editor=createTrackEditor({
  view:()=>app.renderer?.view,tracks:()=>app.tracks,shipped:()=>app.shipped.map(t=>t.id),probe:probeSurface,
  save:async track=>{
    await trackOverride(track.id,track);
    const ids=new Set((await trackOverride('~index'))||[]);ids.add(track.id);await trackOverride('~index',[...ids]);
    app.tracks=mergeTrack(app.tracks,track);
  },
  remove:async id=>{
    const ids=new Set((await trackOverride('~index'))||[]);ids.delete(id);await trackOverride('~index',[...ids]);await trackOverride(id,null);
    const base=app.shipped.find(t=>t.id===id);
    app.tracks=base?mergeTrack(app.tracks,base):app.tracks.filter(t=>t.id!==id);
  },
  test:track=>startRace(track),
  closed:()=>{app.flight=editorFlight;editorFlight=undefined;app.gateKey=undefined;keys.clear();canvas.focus();},
});
function toggleEditor() {
  if(app.race||!app.running||!client.state)return;
  if(app.editor.isOpen){app.editor.close();return;}
  keys.clear();app.dragging=false;app.mouseButtons=0;editorFlight=app.flight;
  app.editor.open(client.state.telemetry.slice(0,3));
}
let flagKey;
// Rest each prop on the terrain: lowest ground under its centre and both ends of its span (ground-fade hides the sunk part).
// Samples across the span (incl. just past the posts); the terrain mesh is coarser than the probe, so sink 1 yd (the ground fade hides it).
const SETTLE_SPAN=[-1.15,-1,-.85,0,.85,1,1.15];const SETTLE_SINK=1;
async function settleGates(list,key) {
  try {
    const pts=list.flatMap(d=>{const [x,,z]=d.at,h=(d.width||0)/2,c=Math.cos(d.yaw),s=Math.sin(d.yaw);return SETTLE_SPAN.map(k=>[x+c*h*k,z-s*h*k]);});
    const g=await probeSurface(pts);
    if(key!==app.gateKey)return;
    const fixed=list.map((d,i)=>{const y=Math.min(...g.slice(i*SETTLE_SPAN.length,(i+1)*SETTLE_SPAN.length).map(s=>s[1]))-SETTLE_SINK;return {...d,at:[d.at[0],Number.isFinite(y)?y:d.at[1],d.at[2]]};});
    app.renderer.setProps(sceneProps(fixed,app.gateKit));
  } catch {/* surface probe failed: gates keep their authored height */}
}
function syncGates(force) {
  const live=app.editor.isOpen?app.tracks:tracksFor(app.tracks,app.choice.vehicle);
  if(!app.editor.isOpen){
    const list=gateScene(live,app.race,performance.now()/1000),key='w|'+sceneKey(list)+'|'+!!app.gateKit;
    if(!force&&key===app.gateKey)return;
    app.gateKey=key;flagKey=undefined;
    app.renderer.setGates([]);app.renderer.setFlags([]);app.renderer.setProps(sceneProps(list,app.gateKit));
    void settleGates(list,key);
    return;
  }
  const key=live.map(t=>t.id).join()+'|'+(app.race?app.race.track.id+':'+app.race.next:'')+'|'+app.editor.draft.id+':'+app.editor.draft.revision+':'+app.editor.selected;
  if(!force&&key===app.gateKey)return;
  if(app.gateKey?.startsWith('w|'))app.renderer.setProps([]);
  app.gateKey=key;
  const racing=!app.editor.isOpen&&app.race;
  // The editor draws only the draft being edited; every other track shows as its flag.
  const items=app.editor.isOpen?app.editor.draft.gates.map((gate,i)=>({gate,next:i===app.editor.selected})):
    racing?[{gate:app.race.track.gates[app.race.gateIndex],next:true,finish:app.race.finishing}]:[];
  app.renderer.setGates(items);
  const own=app.editor.isOpen?app.editor.draft.id:racing?app.race.track.id:undefined;
  const spots=live.filter(t=>t.id!==own).map(flagPosition),fk=JSON.stringify(spots);
  if(fk!==flagKey){flagKey=fk;app.renderer.setFlags(spots);}
}
function startRace(track) {
  if(app.race||app.busy||!app.running||!client.info)return;
  if(vehicleOf(track)!==app.choice.vehicle)app.selectVehicle({vehicle:vehicleOf(track)});
  app.operation(async()=>{
    app.flight=undefined;
    track=await groundTrack(track);
    const [x,y,z]=startLine(track).grid;
    client.state=await client.request('restore',{pose:[x,y+2,z,track.start.yaw]});
    app.renderer.camera=undefined;app.running=true;$('error').hidden=true;
    const board=validScores(await raceScores(track.id).catch(()=>undefined));app.raceBest=board.runs[0];
    $('race-board').hidden=true;app.race=new Race(track);lastCount=0;lastLap=1;music.setBattle(true,false);music.loadCue('click');music.loadCue('quest');const t=performance.now()/1000;app.race.start(t);app.race.lined(t);app.promptTrack=undefined;
  });
}
let lastCount=0;app.voiceMap=undefined;app.voiceReader=undefined;let lastVoice;let lastLap=1;
let raceTune=null;
// Debug crash (Ctrl+Alt+K): the Rust wreck sim runs in the worker in 0.5 s chunks; the renderer replays the recorded poses.
app.wreckBusy=false;app.wasLocked=false;
app.wreckLocked=()=>app.wreckBusy||!!app.renderer.wreck;
// After a wreck the dead pod is replaced: same spot but 10 m up (Unstuck poses), repaired and cooled, at rest.
async function respawn(){const p=client.state?.telemetry;if(!p)return;for(const pose of unstuckPoses(p)){try{client.state=await client.request('restore',{pose,repair:true});app.race?.jump();app.renderer.camera=undefined;return;}catch{/* try the next candidate pose */}}}
async function testCrash(auto=false,speed){
  if(app.wreckBusy||!client.state)return;
  const input=app.renderer.startWreck(client.state.telemetry,Math.floor(Math.random()*1e9),speed);
  if(!input){void respawn();return;}
  app.wreckBusy=true;
  if(auto&&audio.sampleOn){(audio.was??={}).crashAt=audio.context.currentTime;}
  if(auto&&audio.sampleOn)for(const n of wipeoutBlast(Object.keys(audio.samples?.buffers||{})))audio.cue(n,.9);
  try{
    await client.request('wreck-start',input);
    for(let i=0;i<WRECK_CHUNKS&&app.renderer.wreck;i++)app.renderer.wreckChunk(await client.request('wreck-run',{steps:WRECK_CHUNK}));
  }catch(error){app.renderer.endWreck();app.report(`Test crash failed: ${error.message}`,true);}
  app.wreckBusy=false;
}
async function stinger(name){if(!app.voiceReader)return;music.setBattle(false);audio.stopLoop();const b=await app.voiceReader.wav(Array.isArray(name)?name[Math.floor(Math.random()*name.length)]:name).catch(()=>null);if(b)audio.stinger(b);}
async function say(...events){const event=events.find(e=>app.voiceMap?.[e]?.length),id=event&&pickVoice(app.voiceMap,event,lastVoice);if(!id||!app.voiceReader)return;lastVoice=id;const b=await app.voiceReader.wav('Voice/'+id).catch(()=>null);if(b)audio.say(b);}
function raceFrame(controls,t) {
  if(app.race.state==='lineup'||app.race.state==='countdown'){controls.throttle=0;controls.steer=0;}
  const count=Math.ceil(app.race.countdown(t)),event=app.race.update(client.state.telemetry,t);
  if(app.race.lap>lastLap){lastLap=app.race.lap;banner(lapBanner(app.race.lap,app.race.track.laps,lapTimes(app.race.splits,app.race.track.gates.length)));say(app.race.lap===app.race.track.laps?'final-lap':'lap-new');}
  if(event==='go'){say('countdown-go');app.goUntil=t+.8;raceTune=app.voiceReader&&audio.sampleOn?pickRaceMusic():null;music.setBattle(true,!raceTune);if(raceTune)app.voiceReader.wav(raceTune).then(b=>b?audio.loopMusic(b):music.setBattle(true,true)).catch(()=>music.setBattle(true,true));music.playCue('quest');audio.cue(SFX.go);}
  else if(event==='gate')audio.cue(SFX.gate,.5);
  else if(app.race.state==='countdown'&&count!==lastCount){lastCount=count;say('countdown-'+count);music.playCue('click');audio.cue(SFX.beep);}
  const text=app.race.state==='countdown'?String(count):t<app.goUntil?'GO!':'';
  const box=$('race-countdown');
  const sprite=app.hudOn&&app.race.state==='countdown'&&app.countdownSprites?.[count];
  if(box.dataset.key!==text+(sprite?'s':'')){box.dataset.key=text+(sprite?'s':'');box.textContent=sprite?'':text;if(sprite){const c=sprite.cloneNode();c.getContext('2d').drawImage(sprite,0,0);box.append(c);}box.hidden=!text;}
  if(app.race.state==='finished'||app.race.state==='cancelled'){
    const finished=app.race.state==='finished',run=finished&&{time:app.race.time,splits:app.race.splits.slice(),date:new Date().toISOString()};
    const track=app.race.track;app.race=undefined;$('race-hud').hidden=true;
    if(finished){stinger(STINGER.win);audio.cue(SFX.finish,.8);say(...raceEndEvents(true,!app.raceBest||run.time<app.raceBest.time));recordRun(track,run);banner(finishBanner(!app.raceBest||run.time<app.raceBest.time));app.againTrack=track;app.againUntil=performance.now()+10000;}else{stinger(STINGER.wipeout);say(...raceEndEvents(false));app.report(`Race ${track.name||track.id} cancelled.`,true);}
  } else raceHud(t);
}
let bannerTimer;
function banner(text,ms=2500){const b=$('race-banner');b.textContent=text;b.hidden=false;clearTimeout(bannerTimer);bannerTimer=setTimeout(()=>{b.hidden=true;},ms);}
const setText=(id,value)=>{const e=$(id);if(e.textContent!==value)e.textContent=value;};
function raceHud(t) {
  $('race-hud').hidden=false;
  setText('race-time',formatTime(app.race.elapsed(t)));
  setText('race-best',app.raceBest?`Best ${formatTime(app.raceBest.time)}`:'No best yet');
  const done=app.race.splits.length,reference=app.raceBest?.splits[done-1];
  if(done&&reference!==undefined){const d=app.race.splits[done-1]-reference;setText('race-delta',`${d<0?'-':'+'}${Math.abs(d).toFixed(2)}`);$('race-delta').dataset.ahead=String(d<0);}
  else setText('race-delta','');
  setText('race-lap',lapCount(app.race.lap,app.race.track.laps));
  setText('race-laps',app.race.track.laps>1?lapTimesText(lapTimes(app.race.splits,app.race.track.gates.length),formatTime):'');
  setText('race-gate',`Gate ${Math.min(done+1,app.race.totalGates)}/${app.race.totalGates}`);
  const gate=app.race.nextGate,arrow=$('race-arrow');
  arrow.hidden=!gate;
  if(gate){const p=client.state.telemetry;arrow.style.transform=`rotate(${bearing(p,p[3],gate.pos)}rad)`;}
}
async function recordRun(track,run) {
  let record,rank;
  try {
    ({record,rank}=addScore(await raceScores(track.id).catch(()=>undefined),run));
    await raceScores(track.id,record);
  } catch(error) {
    app.report(`Time ${formatTime(run.time)} could not be saved: ${error.message}`,true);
    if(!record)({record,rank}=addScore(undefined,run));
  }
  const rows=record.runs.map((r,i)=>{const row=document.createElement('div');
    row.textContent=`${i+1}. ${formatTime(r.time)}${i===rank?'  <- this run':''}`;if(i===rank)row.className='this';return row;});
  const title=document.createElement('strong');title.textContent=`${track.name||track.id}: ${formatTime(run.time)}${rank===0?' (new best!)':''}`;
  $('race-board').replaceChildren(title,...rows);$('race-board').hidden=false;
  clearTimeout(app.boardTimer);app.boardTimer=setTimeout(()=>{$('race-board').hidden=true;},15000);
}
}
