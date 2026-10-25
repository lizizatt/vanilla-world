import {moveFlight,FLIGHT_PITCH} from './flight.js';
import {basis,fromEuler,toEuler,stepOrient,turnAround} from './orient.js';
import {spaceHud} from './space.js';
import {gpuBytesOf} from './memory-budget.js';
import {regimeOf} from './regime.js';
import {nearestFlag} from './race-flags.js';
import {tracksFor,skinOf} from './vehicles.js';
import {hitFlash,boostFx} from './swe1r/hud.js';
import {gibTrigger,healthTrigger,overheatTrigger} from './wreck.js';
export function installFrame(app) {
const {canvas,keys,input,audio,cameraCollision,evidence,settings,gib,gibMem,music,client}=app;
const $=id=>document.getElementById(id);
Object.assign(app,{frame});
function frame(now) {
  requestAnimationFrame(frame);
  if(now-app.soundTime>250){app.syncSound();app.soundTime=now;}
  const dt=app.last?Math.min((now-app.last)/1000,.1):0;app.last=now;
  if(!app.running || !client.state || app.busy || document.hidden) {
    client.discardFrame();
    if(client.state){audio.update(client.state,{throttle:0,flags:1},0,false);music.update(client.state.area,false);}
    return;
  }
  try {
    const focused=document.hasFocus(),editing=app.raceMenu.open||app.editor.isOpen;
    const accepts=document.activeElement===canvas && focused && !editing;
    const controls={...input.sample(keys,app.testPads || Array.from(navigator.getGamepads?.() || []),accepts,settings.controls,!focused||!editing)};
    if(controls.reset)$('reset').click();
    if(controls.flight&&!app.race)$(app.flight?'drive':'fly').click();
    if(controls.help&&!editing)app.openRaceMenu();
    if(controls.cockpit)app.cockpit();
    if(controls.zoom)app.zoom(controls.zoom);
    const cameraOrbit=app.orbit;app.orbit=[0,0];const keyDrive=!!(controls.throttle||controls.steer),right=!app.flight&&!!(app.mouseButtons&2);
    if(right){controls.steer=Math.max(-1,Math.min(1,(app.renderer.chase?.[0]||0)*4));if(app.mouseButtons&1)controls.throttle=1;}
    const locked=app.wreckLocked();if(locked){Object.assign(controls,{throttle:0,steer:0,flags:0});client.pendingHop=0;}else if(app.wasLocked&&!app.flight)void app.respawn();app.wasLocked=locked;
    if(app.flight) {
      const before=app.flight,[yaw,pitch]=app.flight.length>=9?toEuler(app.flight.slice(5,9),app.flight[3]):[0,0];
      // A pose without a matching quaternion (fresh, loaded, or moved by a test hook) is rebuilt from its yaw/pitch.
      let q=app.flight.length>=9&&Math.abs(Math.sin(yaw-app.flight[3]))<1e-6&&Math.abs(pitch-app.flight[4])<1e-6?app.flight.slice(5,9):fromEuler(app.flight[3],app.flight[4]);
      const dk=k=>Number(keys.has(k));
      q=keys.has('KeyX')?fromEuler(toEuler(q,app.flight[3])[0],-FLIGHT_PITCH):stepOrient(q,{yaw:(dk('ArrowLeft')-dk('ArrowRight'))*dt-cameraOrbit[0]*.004,pitch:(dk('ArrowUp')-dk('ArrowDown'))*dt-cameraOrbit[1]*.004},app.flight[1],dt);
      const aim=basis(q);
      app.flight=moveFlight(app.flight,keys,dt,aim);if(app.flight.poleFlip)q=turnAround(q);const [ny,np]=toEuler(q,app.flight[3]);app.flightSpeed=dt>0?Math.hypot(app.flight[0]-before[0],app.flight[1]-before[1],app.flight[2]-before[2])/dt:0;
      app.flight[3]=ny;app.flight[4]=np;app.flight.length=5;app.flight.push(...q);
    }
    if(app.race){app.flight=undefined;if(!app.raceMenu.open)app.raceFrame(controls,now/1000);}
    if(app.editor.isOpen)app.flight=app.editor.pose();
    app.syncGates();
    if(!app.frozenPresentation&&!locked)client.frame(dt,controls.throttle,controls.steer,controls.flags,app.flight?.slice(0,3),settings.distant,app.renderer.view);
    cameraCollision.frame(client.state,app.renderer.sceneRegion ?? client.state.telemetry[10]);
    app.renderer.fxInput={throttle:Math.max(0,controls.throttle),boosting:(controls.flags&2)!==0,heat:app.dial?client.state.telemetry[6]:0,health:[client.state.telemetry[15]??1,client.state.telemetry[16]??1],drifting:(controls.flags&4)!==0};
    const stats=app.renderer.draw(app.frozenPresentation || app.flight?client.state.telemetry:client.presentation(),app.flight,dt,app.frozenPresentation?0:now/1000,
      {...settings,cameraLook:controls.look,cameraOrbit,cameraSteer:right,cameraRecentre:keyDrive&&!app.dragging},keys.has('KeyV')&&!keys.has('AltLeft')&&!keys.has('AltRight'));
    app.editor.frame();
    if(app.memoryBytes&&now-(app.gpuSent||0)>=1000){app.gpuSent=now;evidence.gpuBytes=gpuBytesOf(stats);client.budget(app.memoryBytes,evidence.gpuBytes);}
    const cameraWarning=stats.cameraBlocked==='pending'?'Cockpit view waiting for nearby camera geometry.'
      :stats.cameraBlocked?'Cockpit view blocked by nearby geometry.':'';
    $('camera-blocked').hidden=!cameraWarning;
    if($('camera-blocked').textContent!==cameraWarning)$('camera-blocked').textContent=cameraWarning;
    const audible=document.hasFocus()&&!app.flight&&!app.frozenPresentation;
    if(gibTrigger(gibMem,client.state.telemetry,gib.on,gib.speed,now,!!app.flight||!!app.frozenPresentation||app.editor.isOpen||app.wreckBusy)){app.flashMem.at=now/1000;app.flashMem.strength=1;void app.testCrash(true,gibMem.speed);}
    else if(gib.durable?healthTrigger(gibMem,client.state.telemetry,true,now,!!app.flight||!!app.frozenPresentation||app.editor.isOpen||app.wreckBusy):app.dial&&overheatTrigger(gibMem,client.state.telemetry,(controls.flags&2)!==0,gib.overheat,now,!!app.flight||!!app.frozenPresentation||app.editor.isOpen||app.wreckBusy)){app.flashMem.at=now/1000;app.flashMem.strength=1;void app.testCrash(true,client.state.telemetry[5]);}
    const flash=app.dial&&app.hudOn&&!app.flight?hitFlash(app.flashMem,client.state.telemetry[8],client.state.telemetry[5],now/1000):0;$('boost-fx').hidden=!(app.dial&&app.hudOn&&!app.flight&&(boostFx(app.boostMem,(controls.flags&2)!==0,dt)>0));if(!$('boost-fx').hidden)$('boost-fx').style.opacity=(app.boostMem.v*.8).toFixed(2);$('hit-flash').hidden=flash<=0;if(flash>0)$('hit-flash').style.opacity=flash.toFixed(2);
    audio.update(client.state,controls,dt,audible);app.ownHud(client.state.telemetry[6],client.state.telemetry[15],client.state.telemetry[16]);if(app.dial){const on=app.hudOn&&!app.flight;$('swe1r-hud').hidden=!on;if(on)app.dial(Math.min(1,client.state.telemetry[5]/app.tuningValues[1]),client.state.telemetry[6],$('speed').textContent,now/1000);$('swe1r-heat').hidden=!(on&&app.heatGauge);if(on&&app.heatGauge)app.heatGauge(client.state.telemetry[6],now/1000,client.state.telemetry[15],client.state.telemetry[16]);}audio.setHeat(app.dial?client.state.telemetry[6]:0,(controls.flags&2)!==0);if(!app.race)music.setBattle(false);music.update(client.state.area,audible);evidence.music=music.snapshot();
    app.frames++;Object.assign(evidence,{frames:app.frames,state:client.state,mode:app.flight?'fly':'drive',camera:app.flight?.slice(),render:stats,adapter:app.renderer.adapter});
    evidence.input={...controls,device:input.device};evidence.view=app.renderer.camera?.slice();
    evidence.cockpit={requested:settings.cockpit,active:app.renderer.cameraMode==='cockpit',available:stats.cockpitAvailable};
    evidence.cameraCollision={ready:cameraCollision.ready,terrainTiles:cameraCollision.tiles.size,triangles:(cameraCollision.tree?.vertices.length||0)/9};
    if(now-app.hudTime>250) {
      const s=client.state,p=s.telemetry,scene=s.scene;
      const held=!!scene?.waitingCollision || !!p[8];
      app.promptTrack=app.race||app.flight?undefined:nearestFlag(tracksFor(app.tracks,app.choice.vehicle),p);
      const again=app.race||app.flight?undefined:app.raceAgain();
      $('race-prompt').hidden=!app.promptTrack&&!again;if(again)$('race-prompt').textContent='Press F to race again';else if(app.promptTrack)$('race-prompt').textContent=`Press F to start race: ${app.promptTrack.name||app.promptTrack.id}`;
      $('speed').textContent=app.flight?'FLY':p[5]<10000?p[5].toFixed(0).padStart(3,'0'):p[5].toExponential(1);
      $('direction').textContent=app.flight?'FREE':p[14]<-.1?'REV':p[14]>.1?'FWD':p[5]<.1?'IDLE':'--';
      $('drive-state').textContent=app.flight?'FLIGHT':scene?.waitingCollision||p[8]===1?'WAIT':p[8]===3?'CONTACT':p[8]===2?'NO GROUND':'';
      Object.assign(app.meters.dataset,{held:String(held),flight:String(!!app.flight),sprites:String(!!(app.dial&&app.hudOn))});
      
      
      $('drive').hidden=!app.flight;$('fly').hidden=!!app.flight||!!app.race;
      $('cockpit').setAttribute('aria-pressed',String(settings.cockpit&&!app.flight));
      $('motion').textContent=app.flight?'':scene?.waitingCollision||p[8]===1?'Loading nearby ground'
        :p[8]===2?'Unsupported surface':p[8]===3?'Obstacle or steep ground':'';
      if(app.raceMenu.open&&!app.raceMenu.querySelector('[data-page=diagnostics]').hidden) {
      $('input-device').textContent=input.device==='controller'?'Controller':'Keyboard';
      $('camera-status').textContent=app.flight?'Flight camera is collision-free':settings.cockpit
        ?cameraWarning||(app.renderer.cameraMode==='cockpit'?'Cockpit / exact posed seat':'Cockpit waiting for craft'):!cameraCollision.ready?'Chase clearance waiting for geometry'
        :cameraCollision.coverageLimited?'Chase distance limited to its collision window':'Vehicle-relative chase collision ready';
      const airborne=!!app.flight&&regimeOf(app.flight[1])!=='ground';$('space-hud').hidden=!airborne;if(airborne)$('space-hud').textContent=spaceHud(app.flight,app.flightSpeed,app.renderer.planetRects?.(),app.landmarks());
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
