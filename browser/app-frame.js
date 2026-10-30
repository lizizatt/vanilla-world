import {moveFlight,FLIGHT_PITCH} from './flight.js';
import {basis,fromEuler,fromBasis,toEuler,stepOrient,turnAround} from './orient.js';
import {stepShared} from './shared-flight.js';
import {boostView,renderBoost} from './boost-hud.js';
import {nearestAltitude} from './space-flight.js';
import {warpClamp} from './sky-coupling.js';
import {activeBody,activeFramedBody,setActiveFrame} from './body-shaders.js';
import {domeLevel} from './dome-shell.js';
import {istText,daylightAt,sanitiseScale,simEpoch,DAY_PERIOD} from './sim-clock.js';
import {gpuBytesOf} from './memory-budget.js';
import {flightMusicArea} from './world-music.js';
import {ClimateTracker} from './weather-climate.js';
import {nearestFlag} from './race-flags.js';
import {tracksFor,skinOf} from './vehicles.js';
import {hitFlash,boostFx} from './swe1r/hud.js';
import {gibTrigger,healthTrigger,overheatTrigger} from './wreck.js';
import {podInSpace,movePodAim,aimQuaternion} from './pod-attitude.js';
export function installFrame(app) {
const {canvas,keys,input,audio,cameraCollision,evidence,settings,gib,gibMem,music,client}=app;
const $=id=>document.getElementById(id);
Object.assign(app,{frame});
function frame(now) {
  requestAnimationFrame(frame);
  if(now-app.soundTime>250){app.syncSound();app.soundTime=now;}
  const dt=app.last?Math.min((now-app.last)/1000,.1):0;
  if(app.last&&evidence.frameLog){const log=evidence.frameLog;log.push([+now.toFixed(1),+(now-app.last).toFixed(1)]);if(log.length>2400)log.splice(0,600);}
  app.last=now;
  if(!app.running || !client.state || app.busy || app.arriving || document.hidden) {
    client.discardFrame();
    if(client.state){audio.update(client.state,{throttle:0,flags:1},0,false);music.update(client.state.area,false);}
    return;
  }
  try {
    const focused=document.hasFocus(),editing=app.raceMenu.open||app.editor.isOpen;
    const accepts=document.activeElement===canvas && focused && !editing;
    const controls={...input.sample(keys,app.testPads || Array.from(navigator.getGamepads?.() || []),accepts,settings.controls,!focused||!editing,
      !app.flight&&app.choice.vehicle==='podracer')};
    if(app.launchFrame())return;
    if(controls.reset)$('reset').click();
    if(controls.flight&&!app.race)$(app.flight?'drive':'fly').click();
    if(controls.help&&!editing)app.openRaceMenu();
    if(controls.cockpit)app.cockpit();
    if(controls.zoom)app.zoom(controls.zoom);
    const cameraOrbit=app.orbit;app.orbit=[0,0];const keyDrive=!!(controls.throttle||controls.steer),right=!app.flight&&!!(app.mouseButtons&2);
    const journey=client.state.pod?.journey,space=accepts&&!app.flight&&app.choice.vehicle==='podracer'&&podInSpace(journey);
    const aiming=space&&(right||controls.orient);
    app.podAim=aiming?movePodAim(app.podAim,app.renderer.podCameraAim??aimQuaternion(journey.direction,journey.up),
      app.podOrbit||[0,0],controls.orient?controls.look:[0,0],dt):undefined;
    const orbital=space?{active:!!aiming,...(aiming?{aim:app.podAim.q,slew:app.podAim.moved}:{})}:undefined;
    app.podOrbit=[0,0];
    if(orbital?.active)controls.look=[0,0];
    if(right&&!orbital){controls.steer=Math.max(-1,Math.min(1,(app.renderer.chase?.[0]||0)*4));if(app.mouseButtons&1)controls.throttle=1;}
    const locked=app.wreckLocked();if(locked){Object.assign(controls,{throttle:0,steer:0,pitch:0,flags:0});client.pendingHop=0;}else if(app.wasLocked&&!app.flight)void app.respawn();app.wasLocked=locked;
    if(app.flight) {
      let swap;const before=app.flight,[yaw,pitch]=app.flight.length>=9?toEuler(app.flight.slice(5,9),app.flight[3]):[0,0];
      // The attitude quaternion is authoritative while this frame loop owns the pose (no Euler round trip, so no gimbal reset near +-90 degrees pitch).
      // A pose set from outside (fresh, loaded, or moved by a test hook) is rebuilt from its quaternion if consistent, else from its yaw/pitch.
      let q=app.attitude?.ref===app.flight?app.attitude.q:app.flight.length>=9&&Math.abs(Math.sin(yaw-app.flight[3]))<1e-6&&Math.abs(pitch-app.flight[4])<1e-6?app.flight.slice(5,9):fromEuler(app.flight[3],app.flight[4]);
      const dk=k=>Number(keys.has(k));
      q=keys.has('KeyX')?fromEuler(toEuler(q,app.flight[3])[0],-FLIGHT_PITCH):stepOrient(q,{yaw:(dk('ArrowLeft')-dk('ArrowRight'))*dt-cameraOrbit[0]*.004,pitch:(dk('ArrowUp')-dk('ArrowDown'))*dt-cameraOrbit[1]*.004},app.flight[1],dt);
      const aim=basis(q);
      if(app.renderer.sharedSpace){
        const down=k=>Number(keys.has(k));
        if(app.flight!==app.spacePose){app.space=undefined;app.flightFrame=app.pendingFrame??'E';app.pendingFrame=undefined;}// pose set from outside (teleport, overview, test focus): restart inertial state there
        const r=stepShared(app.space,app.flight,aim,{forward:down('KeyW')-down('KeyS'),strafe:down('KeyD')-down('KeyA'),lift:down('KeyE')-down('KeyQ'),fast:keys.has('ShiftLeft')||keys.has('ShiftRight')        },dt,app.renderer.timeOfDay??0,(app.renderer.timeLock!==undefined?0:2*Math.min(sanitiseScale(settings.timeScale),app.renderer.warpCap??Infinity)),        activeBody().id,app.flightFrame??'E');
                app.flightFrame=r.frame;app.space=r.space;app.flight=r.pose;app.spacePose=r.pose;
                if(r.swapped&&r.parent!==activeBody().id)swap=r.parent;
        if(r.aim)q=fromBasis(r.aim.right,r.aim.up,r.aim.look);// same physical attitude in the new parent's chart (no orientation reset at the swap)
      } else app.flight=moveFlight(app.flight,keys,dt,aim);if(app.flight.poleFlip)q=turnAround(q);const [ny,np]=toEuler(q,app.flight[3]);app.flightSpeed=dt>0?Math.hypot(app.flight[0]-before[0],app.flight[1]-before[1],app.flight[2]-before[2])/dt:0;
      app.flight[3]=ny;app.flight[4]=np;app.flight.length=5;app.flight.push(...q);app.attitude={ref:app.flight,q};
      if(swap){app.swapHold=true;const release=()=>{app.swapHold=false;};app.soiSwap(swap,{seamless:true}).then(ok=>{if(!ok)app.soiHandoff(swap,app.flight);}).catch(error=>{console.error('SOI swap failed',error);app.soiHandoff(swap,app.flight);}).finally(release);}
    }
    if(!app.flight)app.space=undefined;
    if(app.race){app.flight=undefined;if(!app.raceMenu.open)app.raceFrame(controls,now/1000);}
    if(app.editor.isOpen)app.flight=app.editor.pose();
    app.syncGates();
    app.renderer.warpCap=app.flight&&app.space&&app.renderer.sharedSpace?warpClamp(nearestAltitude(app.space,app.renderer.timeOfDay??0)):undefined;
    if(!app.frozenPresentation&&!locked&&!app.swapHold)client.frame(dt,controls.throttle,controls.steer,controls.flags,app.flight?.slice(0,3),settings.distant,app.renderer.view,controls.pitch,(app.renderer.timeOfDay??720)+simEpoch.days*DAY_PERIOD,app.choice.vehicle==='podracer',orbital);
    cameraCollision.frame(client.state,app.renderer.sceneRegion ?? client.state.telemetry[10]);
    app.renderer.fxInput={throttle:Math.max(0,controls.throttle),boosting:(controls.flags&2)!==0,heat:app.dial?client.state.telemetry[6]:0,health:[client.state.telemetry[15]??1,client.state.telemetry[16]??1],drifting:(controls.flags&4)!==0};
        app.climate??=new ClimateTracker(fields=>client.music(fields));app.climate.update(client.state.area);app.renderer.weatherArea=app.weatherOverride??app.climate.info;    // During a gravity-well swap the renderer still holds the old body's chart; keep presenting the last frame instead of drawing the new pose on it.
    setActiveFrame(app.flight?(app.flightFrame??'E'):['E','N','S'][client.state.frame?.[0]??0]);const stats=app.swapHold&&app.lastStats?app.lastStats:app.renderer.draw(app.frozenPresentation || app.flight?client.state.telemetry:client.presentation(),app.flight,dt,app.frozenPresentation?0:now/1000,
      {...settings,podAim:app.podAim?.q,podTime:journey?.time,cameraLook:controls.look,cameraOrbit,cameraSteer:right&&!orbital,cameraRecentre:keyDrive&&!app.dragging&&!orbital?.active},keys.has('KeyV')&&!keys.has('AltLeft')&&!keys.has('AltRight'));
    app.lastStats=stats;
    app.editor.frame();
    updateTimeHud(app);
    if(app.memoryBytes&&now-(app.gpuSent||0)>=1000){app.gpuSent=now;evidence.gpuBytes=gpuBytesOf(stats);evidence.npcs=stats.npcInstances;app.budgetEngines(evidence.gpuBytes);}
    const cameraWarning=stats.cameraBlocked==='pending'?'Cockpit view waiting for nearby camera geometry.'
      :stats.cameraBlocked?'Cockpit view blocked by nearby geometry.':'';
    $('camera-blocked').hidden=!cameraWarning;
    if($('camera-blocked').textContent!==cameraWarning)$('camera-blocked').textContent=cameraWarning;
    const audible=document.hasFocus()&&!app.flight&&!app.frozenPresentation;
    if(gibTrigger(gibMem,client.state.telemetry,gib.on,gib.speed,now,!!app.flight||!!app.frozenPresentation||app.editor.isOpen||app.wreckBusy)){app.flashMem.at=now/1000;app.flashMem.strength=1;void app.testCrash(true,gibMem.speed);}
    else if(gib.durable?healthTrigger(gibMem,client.state.telemetry,true,now,!!app.flight||!!app.frozenPresentation||app.editor.isOpen||app.wreckBusy):app.dial&&overheatTrigger(gibMem,client.state.telemetry,(controls.flags&2)!==0,gib.overheat,now,!!app.flight||!!app.frozenPresentation||app.editor.isOpen||app.wreckBusy)){app.flashMem.at=now/1000;app.flashMem.strength=1;void app.testCrash(true,client.state.telemetry[5]);}
    const flash=app.dial&&app.hudOn&&!app.flight?hitFlash(app.flashMem,client.state.telemetry[8],client.state.telemetry[5],now/1000):0;$('boost-fx').hidden=!(app.dial&&app.hudOn&&!app.flight&&(boostFx(app.boostMem,(controls.flags&2)!==0,dt)>0));if(!$('boost-fx').hidden)$('boost-fx').style.opacity=(app.boostMem.v*.8).toFixed(2);$('hit-flash').hidden=flash<=0;if(flash>0)$('hit-flash').style.opacity=flash.toFixed(2);
    audio.update(client.state,controls,dt,audible);audio.setWind(app.flightSpeed,app.flight?.[1],!!app.flight&&document.hasFocus()&&!app.frozenPresentation);audio.setWeather(app.renderer.weather?.state.level??0,app.renderer.weather?.state.snowMix??0,app.renderer.weatherFade??1,!!app.renderer.weather?.on&&app.renderer.weatherTier!=='off'&&document.hasFocus()&&!app.frozenPresentation);audio.setNature(document.hasFocus()&&!app.frozenPresentation?domeLevel(activeBody().id,app.flight||client.state):0);app.ownHud(client.state.telemetry[6],client.state.telemetry[15],client.state.telemetry[16]);if(app.dial){const on=app.hudOn&&!app.flight;$('swe1r-hud').hidden=!on;if(on)app.dial(Math.min(1,client.state.telemetry[5]/app.tuningValues[1]),client.state.telemetry[6],$('speed').textContent,now/1000);$('swe1r-heat').hidden=!(on&&app.heatGauge);if(on&&app.heatGauge)app.heatGauge(client.state.telemetry[6],now/1000,client.state.telemetry[15],client.state.telemetry[16]);}if(!app.flightHud.root.hidden&&app.renderer.view)app.flightHud.update(activeFramedBody(),app.renderer.view,app.renderer.timeOfDay??0,now/1000);audio.setHeat(app.dial?client.state.telemetry[6]:0,(controls.flags&2)!==0);if(!app.race)music.setBattle(false);app.musicArea=flightMusicArea(client.state.area,app.flight?.[1],app.musicArea);music.update(app.flight?app.musicArea:client.state.area,document.hasFocus()&&!app.frozenPresentation);evidence.music=music.snapshot();
    app.frames++;Object.assign(evidence,{frames:app.frames,state:client.state,mode:app.flight?'fly':'drive',camera:app.flight?.slice(),render:stats,adapter:app.renderer.adapter});
    evidence.input={...controls,device:input.device};evidence.view=app.renderer.camera?.slice();
    evidence.cockpit={requested:settings.cockpit,active:app.renderer.cameraMode==='cockpit',available:stats.cockpitAvailable};
    evidence.cameraCollision={ready:cameraCollision.ready,terrainTiles:cameraCollision.tiles.size,triangles:(cameraCollision.tree?.vertices.length||0)/9};
    if(now-app.hudTime>250) {
      const s=client.state,p=s.telemetry,scene=s.scene;
      const held=!!scene?.waitingCollision || !!p[8];
      app.promptTrack=app.race||app.flight?undefined:nearestFlag(tracksFor(app.tracks,app.choice.vehicle,activeBody().id),p);
      const again=app.race||app.flight?undefined:app.raceAgain();
      $('race-prompt').hidden=!app.promptTrack&&!again;if(again)$('race-prompt').textContent='Press F to race again';else if(app.promptTrack)$('race-prompt').textContent=`Press F to start race: ${app.promptTrack.name||app.promptTrack.id}`;
      $('speed').textContent=app.flight?'FLY':p[5]<10000?p[5].toFixed(0).padStart(3,'0'):p[5].toExponential(1);
      $('direction').textContent=app.flight?'FREE':p[14]<-.1?'REV':p[14]>.1?'FWD':p[5]<.1?'IDLE':'--';
      $('drive-state').textContent=app.flight?'':scene?.waitingCollision||p[8]===1?'WAIT':p[8]===3?'CONTACT':p[8]===2?'NO GROUND':'';
      Object.assign(app.meters.dataset,{held:String(held),flight:String(!!app.flight),sprites:String(!!(app.dial&&app.hudOn))});
      
      
      $('drive').hidden=!app.flight;$('fly').hidden=!!app.flight||!!app.race;
      $('cockpit').setAttribute('aria-pressed',String(settings.cockpit&&!app.flight));
      $('motion').textContent=app.flight?'':scene?.waitingCollision||p[8]===1?'Loading nearby ground'
        :p[8]===2?'Unsupported surface':p[8]===3?'Obstacle or steep ground':'';
      renderBoost($('boost-bar'),boostView(s.pod));
      if(app.raceMenu.open&&!app.raceMenu.querySelector('[data-page=diagnostics]').hidden) {
      $('input-device').textContent=input.device==='controller'?'Controller':'Keyboard';
      $('camera-status').textContent=app.flight?'Flight camera is collision-free':settings.cockpit
        ?cameraWarning||(app.renderer.cameraMode==='cockpit'?'Cockpit / exact posed seat':'Cockpit waiting for craft'):!cameraCollision.ready?'Chase clearance waiting for geometry'
        :cameraCollision.coverageLimited?'Chase distance limited to its collision window':'Vehicle-relative chase collision ready';
      $('place').textContent=app.flight?'FREE FLIGHT':p[10]===-1?'THE GREAT SEA':p[10]===1?'EASTERN KINGDOMS':'KALIMDOR';
      $('coordinates').textContent=`${(app.flight?.[0]??p[0]).toFixed(0)} E / ${(app.flight?.[2]??p[2]).toFixed(0)} S`;
      $('resident').textContent=`${s.resident.length}/${s.limit} terrain tiles · ${stats.horizonTiles} distant patches · ${stats.sceneInstances||0} scene instances`;
      $('population').textContent=scene?.population || 'Reading static population…';
      $('material-status').textContent=s.terrain
        ?`Terrain textures ${stats.texturedTerrainTiles}/${s.resident.length} · terrain cache ${(s.terrain.bytes/1048576).toFixed(1)} MiB · far minimaps ${s.terrain.minimaps}/${s.horizon.patches} (${s.terrain.farPending} pending, ${s.terrain.missingMinimaps?.length||0} unavailable previews, ${s.terrain.errors.length} resource errors)`
        :'Terrain material progress unavailable';
      if(s.water)$('material-status').textContent+=` · authored water ${s.water.resident} tiles / ${(s.water.bytes/1048576).toFixed(1)} MiB (${s.water.pending} pending${s.water.deferred?`, ${s.water.deferred} background deferrals`:''}${s.water.limited?', nearest-water cache full':''})`;
      $('details').textContent=`${client.info.archiveCount} local archives · ${((scene?.bytes||0)/1048576).toFixed(1)} MiB scene cache · ${scene?.pending||0} pending assets${scene?.capacityBlocked?' · scene capacity reached':''}${!app.flight&&scene?.waitingCollision?` · waiting for ${scene.waitingCollision} nearby collision assets`:''}${stats.gpuOmittedInstances?` · ${stats.gpuOmittedInstances} meshes beyond GPU budget`:''}`;
      if(s.distant?.scene)$('details').textContent+=` · distant worker ${(s.distant.scene.bytes/1048576).toFixed(1)} MiB / ${s.distant.scene.pending} pending${s.distant.scene.capacityBlocked?' / visual cache full':''}`;
      $('details').textContent+=app.memoryLine(s,stats);
      $('craft-status').textContent=app.skinNote||(stats.craftSource==='model'?`Vehicle model `+skinOf(app.choice).name:stats.craftReady?`Authored racer display 10318 / ${stats.craftPose}`
        :stats.craftStatus==='failed'?'Player craft failed to load; temporary body remains':'Loading authored player craft; temporary body shown');
      }
      const errors=[...s.failures,...(s.distant?.failures||[]),...(s.distant?.scene?.errors||[]),...(s.terrain?.errors||[]),...(scene?.errors||[]),
        ...(stats.craftError?[`Player craft: ${stats.craftError}`]:[])].map(e=>typeof e==='string'?e:JSON.stringify(e));
      const missing=s.terrain?.missingMinimaps||[];
      $('resource-problems').querySelector('summary').textContent=[
        errors.length?`${errors.length} loading issues`:'',
        missing.length?`${missing.length} optional map previews unavailable`:'',
      ].filter(Boolean).join(' · ');
      $('problems').textContent=[...errors,...(missing.length?
        ['Optional map previews are absent from this installation. Terrain and collision are unaffected.',...missing]:[])].join('\n');
      $('resource-problems').hidden=!errors.length&&!missing.length;
      evidence.fps=(app.frames-app.hudFrames)*1000/(now-app.hudTime);app.hudFrames=app.frames;app.hudTime=now;
    }
  } catch(error){app.running=false;app.fail(error);}
}
}

/** Top-of-screen Ironforge Standard Time readout; the speed slider shows only in fly mode (outside it the clock runs 1x). */
function updateTimeHud(app) {
  const r=app.renderer,d=document,t=r?.timeOfDay;if(t===undefined)return;
  const c=d.getElementById('ist-clock'),text=istText(t);if(c.textContent!==text)c.textContent=text;
  d.getElementById('time-speed').hidden=!app.flight;
  app.music.setNight(daylightAt(t)<.5);
}
