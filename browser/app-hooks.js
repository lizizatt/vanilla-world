import {loadPodModel} from './swe1r/skin.js';
import {getSwe1r} from './swe1r/ui.js';
export function createWorldTest(app) {
const {client,audio,settings}=app;
return {renderer:()=>app.renderer,restore:pose=>client.request('restore',{pose}).then(s=>{client.state=s;app.flight=undefined;app.renderer.camera=undefined;app.running=true;return s.telemetry;}),particles:()=>app.renderer.particles,testCrash:app.testCrash,wreck:()=>app.renderer.wreck&&{frames:app.renderer.wreck.frames.length,connected:app.renderer.wreck.connected,parts:app.renderer.wreck.parts.length},startRace:app.startRace,selectVehicle:app.selectVehicle,tracks:()=>app.tracks,raceObj:()=>app.race,heldLoops:()=>Object.values(audio.held||{}).map(h=>h?.name).filter(Boolean),raceInfo:()=>app.race&&{state:app.race.state,next:app.race.next,finishing:app.race.finishing,gates:app.race.track.gates.length},choice:()=>app.choice,
      focus:pose=>{app.flight=pose.slice();},manifest:()=>client.info.manifest,sky:()=>app.renderer.gameSky&&{top:app.renderer.gameSky.top,fog:app.renderer.gameSky.fog,horizon:app.renderer.gameSky.horizon,time:app.renderer.timeOfDay},maelstrom:()=>import('./clouds.js').then(m=>m.maelstromCentre(client.info.manifest)),gateKit:()=>!!app.gateKit,propCount:()=>app.renderer.props?.length,props:list=>app.renderer.setProps(list),beamFx:o=>{app.renderer.fxOverride=o;},propTexture:path=>client.request('prop-texture',{path}),propModel:path=>client.request('prop-model',{path}),swe1rModel:(index,scale)=>loadPodModel(getSwe1r(),{index,scale}),mockGates:list=>{for(const g of app.renderer.gates)app.renderer.release(g);app.renderer.gates=list.map(({vertices,pos})=>app.renderer.drawable(vertices,pos));app.renderer.terrainView=undefined;},settings:o=>Object.assign(settings,o),showCraft:v=>{app.renderer.showCraftInFlight=v;},timeLock:v=>{app.renderer.timeLock=v;},
      instances:()=>app.renderer.instances.filter(i=>i.kind==='group').slice(0,8),
      npcs:()=>app.renderer.instances.filter(i=>i.id.includes(':npc:')).slice(0,5),
      request:async(action,fields)=>{const s=await client.request(action,fields);if(s.telemetry)client.state=s;return s;},
      gamepads:pads=>{app.testPads=pads;},
      freezePresentation:value=>{app.frozenPresentation=value;if(value)client.discardFrame();},
      audioRms:()=>{if(!audio.analyser)return 0;const samples=new Float32Array(audio.analyser.fftSize);audio.analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((n,s)=>n+s*s,0)/samples.length);},
    };
}
