// Gameplay race scenery: decides which gate props exist (pure state), builds them with the race-gate-preview.js builders, and loads
// the optional local-asset kit. Gates stay non-colliding scenery; trigger planes live in race.js and are unchanged.
import {gantry,checkpoint,beacon} from './race-gate-preview.js';
import {flagPosition} from './race-flags.js';

export const START_AHEAD=14; // yd the gantry stands ahead of the lined-up craft
export const GANTRY_WIDTH=30;
const forward=yaw=>[-Math.sin(yaw),-Math.cos(yaw)];
const ACTIVE={lineup:1,countdown:1,running:1};

// Lamp lit on the gantry: 0 off, 1 red, 2 amber, 3 green (GO and the whole run). Countdown 3 = red, 2 and 1 = amber.
export function lightPhase(race,now) {
  if(race.state==='running')return 3;
  if(race.state!=='countdown')return 0;
  return Math.ceil(race.countdown(now))>=3?1:2;
}

// Descriptors for every gate prop. Labels show at each track start in free-roam and are hidden for the track being raced (the gantry marks it).
// While running: the next gate is amber (or the chequered finish gantry on the last one) and the one just passed is dim; later gates stay hidden.
export function gateScene(tracks,race,now=0) {
  const out=[],active=race&&ACTIVE[race.state]?race:undefined;
  for(const t of tracks)if(t.id!==active?.track.id)out.push({kind:'L',id:'L:'+t.id,at:flagPosition(t),yaw:t.start.yaw});
  if(!active)return out;
  const {track}=active,[fx,fz]=forward(track.start.yaw),s=track.start.pos,n=track.gates.length;
  const startAt=[s[0]+fx*START_AHEAD,s[1],s[2]+fz*START_AHEAD];
  const fin=active.finishing,last=track.gates[active.gateIndex];
  const dup=fin&&Math.hypot(last.pos[0]-startAt[0],last.pos[2]-startAt[2])<GANTRY_WIDTH;
  if(!dup)out.push({kind:'A',id:'A:start',at:startAt,yaw:track.start.yaw,phase:lightPhase(active,now)});
  if(active.state==='running'){
    if(fin)out.push({kind:'A',id:'A:finish',at:last.pos,yaw:last.yaw,width:Math.min(last.width,60),phase:3});
    else out.push({kind:'C',id:'C:next',at:last.pos,yaw:last.yaw,width:last.width,state:'next'});
    if(active.next>0){const g=track.gates[(active.gateIndex+n-1)%n];out.push({kind:'C',id:'C:passed',at:g.pos,yaw:g.yaw,width:g.width,state:'passed'});}
  }
  return out;
}

export const sceneKey=list=>list.map(d=>[d.id,d.at.map(Math.round).join(),d.phase??'',d.state??'',d.width??''].join('|')).join(';');

export function sceneProps(list,real) {
  return list.flatMap(d=>({A:gantry,C:checkpoint,L:beacon}[d.kind])({...d,real}));
}

// WoW M2s/textures the same way the preview tool does; SWE1R lens 309 only when a Racer folder is attached. Returns undefined when the
// local data is missing (hosted), which keeps the flat procedural fallback.
const WOW={
  pole:'World\\Generic\\Human\\Passive Doodads\\FlagPole\\Flagpole01.m2',
  bannerBig:'World\\Generic\\Orc\\Passive Doodads\\HordeBanners\\HordeBanner01.m2',
  brazier:'World\\Generic\\Orc\\Passive Doodads\\Braziers\\TallBrazier01.m2',
};
export const TEX={
  wood:'World\\Generic\\Orc\\Passive Doodads\\HordeBanners\\ns_wood01.blp',iron:'Dungeons\\Textures\\Decoration\\mm_wroughtiron_01.blp',
  stone:'Dungeons\\Textures\\Trim\\mm_duskwood_stonebase_01.blp',metal:'Dungeons\\Textures\\Carlo\\MedBrazier01.blp',
  zap:'Spells\\zap1.blp',flag:'World\\Generic\\PVP\\BattlefieldBanners\\PvPNeutralBannerFlag.blp',
};
export async function loadGateKit(request,lens) {
  try{
    const real={tex:{}};
    for(const [k,p] of Object.entries(WOW))real[k]=await request('prop-model',{path:p});
    for(const [k,p] of Object.entries(TEX))real.tex[k]=await request('prop-texture',{path:p});
    if(Object.values(real).some(v=>!v)||Object.values(real.tex).some(v=>!v))return undefined;
    const l=await lens?.();
    if(l)real.lens={asset:l.asset,textures:l.textures,k:2.4/57.2};
    return real;
  }catch{return undefined;}
}
