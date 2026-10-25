import {WorldClient} from './world-client.js';
import {WorldRenderer} from './world-renderer.js';
import {restoreDataFolder,authorizeDataFolder} from './asset-folder.js';
import {WorldInput} from './world-input.js';
import {WorldAudio} from './world-audio.js';
import {TUNING_FIELDS} from './world-tuning.js';
import {CameraCollision} from './camera-collision.js';
import {LoadingArt} from './loading-art.js';
import {MusicPlayer} from './world-music.js';
import {MapPanel} from './map-panel.js';
import {bootChoice,writeChoice,tracksFor,normalizeChoice,setRuntimeSkins} from './vehicles.js';
import {initSwe1rRow,onSwe1r} from './swe1r/ui.js';
import {podSkinList} from './swe1r/skin.js';
import {SFX,HEAT,WIPEOUT_NAMES,POD_ENGINES,loadSfx} from './swe1r/sfx.js';
import {loadHudSprites,loadCountdownSprites,createDial,createHeatGauge} from './swe1r/hud.js';
import {installHud} from './app-hud.js';
import {installSettings} from './app-settings.js';
import {installLoading} from './app-loading.js';
import {installPose} from './app-pose.js';
import {installInput} from './app-input.js';
import {installGarage} from './app-garage.js';
import {installRace} from './app-race.js';
import {installFrame} from './app-frame.js';
import {createWorldTest} from './app-hooks.js';
const app={};
const $=id=>document.getElementById(id);const canvas=$('world');const keys=new Set();
const input=new WorldInput();const audio=new WorldAudio();
const cameraCollision=new CameraCollision();
const evidence={ready:false,frames:0,errors:[],mode:'drive'};
window.worldEvidence=evidence;
app.choice=bootChoice();app.tracks=[];app.race=undefined;app.raceBest=undefined;app.promptTrack=undefined;app.goUntil=0;app.boardTimer=0;app.againTrack=undefined;app.againUntil=0;
app.landmarkCache=undefined;app.flightSpeed=0;app.renderer=undefined;app.folder=undefined;app.flight=undefined;app.running=false;app.busy=false;app.last=0;app.frames=0;app.hudTime=0;app.hudFrames=0;app.permissionNeeded=false;
app.orbit=[0,0];app.dragging=false;app.mouseButtons=0;app.soundAttempt=0;app.soundError='';app.soundTime=0;app.reportTimer=undefined;app.testPads=undefined;app.frozenPresentation=false;app.tuningValues=TUNING_FIELDS.map(f=>f[1]);
const defaults={horizon:true,scenery:true,distant:true,controls:'native',cameraDistance:15,cameraSeconds:.5,sound:true,cockpit:false,clouds:true,planet:true,globeMesh:true,globeRegistry:true,cloudQuality:'auto',music:true,particles:'medium',animateNpcs:true,timeScale:1};
const settings={...defaults};
const gib={on:true,speed:100,overheat:true};const gibMem={};
const loading=$('loading-screen');
const loadingArt=new LoadingArt($('loading-art'),$('loading-bar-art'),loading);
const mapPanel=new MapPanel({dialog:$('map-panel'),canvas:$('map-canvas'),stage:$('map-stage'),status:$('map-status'),close:$('map-close')},{
  requestArt:names=>client.worldmap(names),pose:()=>app.flight??client.state?.telemetry,tracks:()=>tracksFor(app.tracks,app.choice.vehicle),
  teleport:icon=>app.operation(async()=>{
    app.flight=undefined;client.state=await client.request(icon.reset?'reset':'restore',icon.reset?undefined:{pose:icon.pose});app.race?.jump();
    app.renderer.camera=undefined;app.running=true;$('error').hidden=true;app.report(`Teleported to ${icon.label}.`,true);
  }),
});
mapPanel.dialog.addEventListener('close',()=>canvas.focus());
mapPanel.dialog.addEventListener('keydown',event=>{if(event.code==='KeyM'&&!event.repeat){event.preventDefault();mapPanel.toggle();}});
const music=new MusicPlayer({request:fields=>client.music(fields),context:()=>audio.context});
const client=new WorldClient(data=>{
  try {
    evidence.eventRevision=(evidence.eventRevision||0)+1;
    if(data.event==='progress'){if(!evidence.ready){app.report(data.text);app.loadingProgress(data);}}
    else if(data.event==='music')music.event(data);
    else if(data.event==='sky')app.renderer.setSky(data);
    else if(data.event==='sky-dome')app.renderer.setSkyDome(data);
    else if(data.event==='worldmap'||data.event==='worldmap-tiles')mapPanel.event(data);
    else if(data.event==='loading-art')loadingArt.event(data);
    else if(data.event==='loading-art-warning'){
      console.warn(data.message);
      if(loading.open)$('loading-warning').textContent=data.message;
    }
    else {
      cameraCollision.event(data);
      if(data.event==='collision')app.renderer.clipCamera=(pivot,point,origin)=>{
        const pointWithClearance=cameraCollision.clip(pivot,point,origin);
        app.renderer.cameraCollisionReady=cameraCollision.ready;
        return pointWithClearance;
      };
      else app.renderer.event(data);
    }
    return true;
  } catch(error){
    if(data.event==='far-scene')app.renderer.clearFar();else app.running=false;
    app.fail(error);return false;
  }
},error=>{app.running=false;app.fail(error);},()=>app.running&&!app.busy&&!document.hidden&&!app.frozenPresentation);
Object.assign(app,{canvas,keys,input,audio,cameraCollision,evidence,defaults,settings,gib,gibMem,loading,loadingArt,mapPanel,music,client});
installHud(app);
installSettings(app);
installLoading(app);
installPose(app);
installInput(app);
installGarage(app);
installRace(app);
installFrame(app);
async function start() {
  try {
    app.renderer=await WorldRenderer.create(canvas,error=>{app.running=false;app.fail(error);});
    $('select').disabled=false;$('fallback').disabled=false;evidence.started=performance.now();
    app.report('');
    if('serviceWorker' in navigator) {
      await navigator.serviceWorker.register('./sw.js');
      $('offline').textContent='Offline ready.';
    }
    initSwe1rRow();
    onSwe1r(async r=>{
      if(!r){setRuntimeSkins('swe1r',[]);if(app.choice.skin.startsWith('swe1r-')){app.choice=normalizeChoice({...app.choice,skin:'rocket'});writeChoice(app.choice);app.applySkin();}app.garagePick=normalizeChoice(app.garagePick);app.dial=undefined;app.heatGauge=undefined;app.realHud=undefined;$('swe1r-heat').hidden=true;app.countdownSprites=undefined;app.voiceReader=undefined;$('swe1r-hud').hidden=true;app.syncHud();$('swe1r-hud-row').hidden=true;$('overheat-row').hidden=true;$('swe1r-sfx-row').hidden=true;audio.sampleOn=false;if(app.garage.open)app.renderGarage();return;}
      setRuntimeSkins('swe1r',podSkinList());if(app.garage.open)app.renderGarage();
      app.voiceReader=r;fetch('./swe1r/voice-map.json').then(x=>x.ok?x.json():{}).then(m=>{app.voiceMap=m;}).catch(()=>{});
      const raw=await loadSfx(r,[...Object.values(SFX),...Object.values(POD_ENGINES),...WIPEOUT_NAMES,...HEAT.klaxon,HEAT.coolOn,HEAT.cool]).catch(()=>new Map());
      loadCountdownSprites(r).then(s=>{app.countdownSprites=s||undefined;}).catch(e=>console.error('SWE1R countdown',e));
  loadHudSprites(r).then(s=>{if(!s)return;if(s.real){app.realHud=s.real;app.layoutHud();}else{app.realHud=undefined;app.dial=createDial(s,$('swe1r-hud'));app.heatGauge=s.heat&&createHeatGauge(s.heat,$('swe1r-heat'));}$('swe1r-hud-row').hidden=false;$('overheat-row').hidden=false;app.syncHud();}).catch(e=>console.error('SWE1R HUD',e));
      if(raw.size){audio.sampleOn=$('swe1r-sfx').checked;$('swe1r-sfx-row').hidden=false;await audio.useSamples(raw);}});
    app.folder=await restoreDataFolder().catch(()=>undefined);
    if(app.folder) {
      if(await authorizeDataFolder(app.folder))await app.open(app.folder);
      else {app.permissionNeeded=true;app.showReconnect(true);
        $('permission').textContent='Click to allow reading your remembered folder.';}
    }
    if(new URLSearchParams(location.search).has('test'))window.worldTest=createWorldTest(app);
    requestAnimationFrame(app.frame);
  } catch(error){app.fail(error);}
}
start();
