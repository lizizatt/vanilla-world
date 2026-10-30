import {loadPodModel} from './swe1r/skin.js';
import {getSwe1r} from './swe1r/ui.js';
import {maelstromCentre} from './clouds.js';
export function createWorldTest(app) {
const {client,audio,settings}=app;
return {launch:app.launch,renderer:()=>app.renderer,restore:pose=>app.arrival(()=>client.request('restore',{pose}).then(s=>{client.state=s;app.flight=undefined;app.renderer.camera=undefined;app.running=true;return s.telemetry;})),particles:()=>app.renderer.particles,testCrash:app.testCrash,wreck:()=>app.renderer.wreck&&{frames:app.renderer.wreck.frames.length,connected:app.renderer.wreck.connected,parts:app.renderer.wreck.parts.length},startRace:app.startRace,selectVehicle:app.selectVehicle,tracks:()=>app.tracks,raceObj:()=>app.race,heldLoops:()=>Object.values(audio.held||{}).map(h=>h?.name).filter(Boolean),raceInfo:()=>app.race&&{state:app.race.state,next:app.race.next,finishing:app.race.finishing,gates:app.race.track.gates.length},choice:()=>app.choice,
      focus:(pose,frame)=>{app.flight=pose.slice();app.space=undefined;app.pendingFrame=frame;},flightState:()=>({flight:app.flight,space:app.space,frame:app.flightFrame??'E'}),manifest:()=>client.info.manifest,sky:()=>app.renderer.gameSky&&{top:app.renderer.gameSky.top,fog:app.renderer.gameSky.fog,horizon:app.renderer.gameSky.horizon,time:app.renderer.timeOfDay},maelstrom:()=>import('./clouds.js').then(m=>m.maelstromCentre(client.info.manifest)),gateKit:()=>!!app.gateKit,propCount:()=>app.renderer.props?.length,props:list=>app.renderer.setProps(list),beamFx:o=>{app.renderer.fxOverride=o;},propTexture:path=>client.request('prop-texture',{path}),propModel:path=>client.request('prop-model',{path}),swe1rModel:(index,scale)=>loadPodModel(getSwe1r(),{index,scale}),mockGates:list=>{for(const g of app.renderer.gates)app.renderer.release(g);app.renderer.gates=list.map(({vertices,pos})=>app.renderer.drawable(vertices,pos));app.renderer.terrainView=undefined;},settings:o=>Object.assign(settings,o),showCraft:v=>{app.renderer.showCraftInFlight=v;},timeLock:v=>{app.renderer.timeLock=v;},
      instances:()=>app.renderer.instances.filter(i=>i.kind==='group').slice(0,8),
      npcs:()=>app.renderer.instances.filter(i=>i.id.includes(':npc:')).slice(0,5),
      request:async(action,fields)=>{const s=await client.request(action,fields);if(s.telemetry)client.state=s;return s;},
      gamepads:pads=>{app.testPads=pads;},
      weatherArea:area=>{app.weatherOverride=area;},
      weather:()=>{const r=app.renderer,w=r.weather;return w&&{tier:r.weatherTier,on:w.on,local:w.local,intensity:w.state.intensity,kind:w.state.kind,raining:w.state.raining,heavy:w.state.heavy,anyWet:w.anyWet,nearest:w.nearest,climate:w.climate,sampleMs:w.sampleMs,curtain:r.curtainDrawn,near:r.nearDrawn,level:w.state.level,snowMix:w.state.snowMix};},
      weatherFind:(from,opts={})=>{const r=app.renderer,w=r.weather;if(!w)return;const ctx={time:r.cloudTime,centre:r.manifest?maelstromCentre(r.manifest):[1e9,1e9],mask:r.cloudMask?.mask,flow:r.planet&&{cycles:r.planet.flowCycles,scale:r.planet.flowScale}},min=opts.min??.9,rMax=opts.range??30000,step=opts.step??500;
        const on=w.on;w.on=1;let best;for(let d=0;d<=rMax&&!best;d+=step){const n=Math.max(1,Math.round(d/step*6));for(let i=0;i<n;i++){const a=i/n*Math.PI*2,x=from[0]+Math.cos(a)*d,z=from[1]+Math.sin(a)*d;if(w.sample(x,z,ctx)>=min&&(opts.edge===undefined||w.sample(x+Math.cos(a)*opts.edge,z+Math.sin(a)*opts.edge,ctx)<min)){best=[x,z,d,a];break;}}}w.on=on;return best;},
      freezePresentation:value=>{app.frozenPresentation=value;if(value)client.discardFrame();},
      audioRms:()=>{if(!audio.analyser)return 0;const samples=new Float32Array(audio.analyser.fftSize);audio.analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((n,s)=>n+s*s,0)/samples.length);},
    };
}
