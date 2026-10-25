import {SFX,HEAT,heatStage,POD_ENGINES,podEngineFor} from './swe1r/sfx.js';
const unit=n=>Number.isFinite(n)?Math.max(0,Math.min(1,n)):0;
const tone=(hz,t)=>Math.sin(2*Math.PI*hz*t);
const engine=(hz,t)=>.56*tone(hz,t)+.17*tone(hz*2,t)+.06*tone(hz*3,t);
export function fillEngineBuffer(buffer,layer) {
  const left=buffer.getChannelData(0),right=buffer.getChannelData(1),rate=buffer.sampleRate;
  if(layer===0) {
    for(let i=0;i<left.length;i++) {
      const t=i/rate,a=engine(43,t),b=engine(46,t);
      left[i]=.82*a+.18*b;right[i]=.18*a+.82*b;
    }
    return;
  }
  for(let channel=0;channel<2;channel++) {
    const output=channel?right:left;
    let low=0,dc=0;
    // Repeat the deterministic noise cycle to settle the filters at the loop seam.
    for(let pass=0;pass<2;pass++) {
      let seed=0x51f15e+channel*173+layer*7919;
      for(let i=0;i<output.length;i++) {
        seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
        low+=(((seed>>>0)/2147483648-1)-low)*(layer===1?.28:.16);
        dc+=(low-dc)*.012;
        output[i]=(low-dc)*.8;
      }
    }
  }
}
export class EngineEnvelope {
  constructor(){
    this.layers=[[0,1,1000],[0,1,1000],[0,1,1000]];
    this.reset();
  }
  reset(){
    this.speed=0;this.thrust=0;this.boost=0;this.air=0;this.water=0;
    this.landing=0;this.lift=0;this.braking=0;this.airTime=0;this.initialized=false;
  }
  advance(speed,throttle,boosting,held,brake,dt,grounded=true,water=false) {
    dt=Number.isFinite(dt)?Math.max(0,Math.min(.1,dt)):0;
    const follow=-Math.expm1(-dt/.22),boost=boosting && !held && !brake?1:0;
    this.speed+=((held?0:unit(Math.abs(speed)/120))-this.speed)*-Math.expm1(-dt/(held?.1:.3));
    this.thrust+=((held || brake?0:unit(Math.abs(throttle)))-this.thrust)*-Math.expm1(-dt/(held?.06:.22));
    this.boost+=(boost-this.boost)*-Math.expm1(-dt/(boost>this.boost?.28:.35));
    this.air+=((grounded?0:1)-this.air)*follow;
    this.water+=((water && grounded?1:0)-this.water)*follow;
    this.landing*=Math.exp(-dt/.085);this.lift*=Math.exp(-dt/.12);this.braking*=Math.exp(-dt/.18);
    if(this.initialized && !held) {
      if(grounded && !this.grounded && this.airTime>.12)this.landing=Math.min(.045,.015+this.airTime*.018);
      if(!grounded && this.grounded)this.lift=.016;
      if(brake && !this.brake)this.braking=.025*this.speed;
    }
    this.airTime=grounded || held?0:this.airTime+dt;
    this.grounded=grounded;this.brake=brake;this.initialized=true;
    const core=this.layers[0],air=this.layers[1],jet=this.layers[2];
    core[0]=.085+.035*this.thrust+.018*this.boost-.015*this.air+this.landing;
    core[1]=.82+.48*this.speed+.24*this.thrust+.12*this.boost;
    core[2]=260+420*this.thrust+180*this.speed;
    air[0]=.008+this.speed*(.065*(.65+.35*this.air)+.025*this.water)+this.lift+this.braking;
    air[1]=.85+.3*this.speed;air[2]=(650+1550*this.speed+350*this.air)*(1-.45*this.water);
    jet[0]=.09*this.boost;jet[1]=.9+.2*this.speed;
    jet[2]=500+1500*this.boost;
    return this.layers;
  }
}
/** Perceptual master curve: slider 0..1 -> amplitude v^2 (50% = 0.25, about -12 dB). */
export const masterGain=v=>unit(v)**2;
export class WorldAudio {
  constructor(){this.volume=.5;this.envelope=new EngineEnvelope();this.enabled=false;this.voices=[];this.active=false;this.activation=0;}
  setVolume(v) {this.volume=unit(v);if(this.out)this.out.gain.setTargetAtTime(masterGain(this.volume),this.context.currentTime,.03);}
  async enable() {
    if(this.enabled && this.context?.state==='running')return;
    const activation=++this.activation;
    this.enabled=false;
    if(!globalThis.AudioContext)throw new Error('Web Audio is unavailable in this browser.');
    if(!this.context || this.context.state==='closed') {
      this.voices=[];
      this.context=new AudioContext();
      this.master=this.context.createGain();this.master.gain.value=0;
      this.analyser=this.context.createAnalyser();this.master.connect(this.analyser);this.out=this.context.createGain();this.out.gain.value=masterGain(this.volume);this.context.masterOut=this.out;this.analyser.connect(this.out);this.out.connect(this.context.destination);
      for(let layer=0;layer<3;layer++) {
        const buffer=this.context.createBuffer(2,48000,24000);
        fillEngineBuffer(buffer,layer);
        const source=this.context.createBufferSource(),gain=this.context.createGain(),filter=this.context.createBiquadFilter();
        source.buffer=buffer;source.loop=true;gain.gain.value=0;
        filter.type='lowpass';filter.Q.value=.5;filter.frequency.value=1000;
        source.connect(filter);filter.connect(gain);gain.connect(this.master);source.start();
        this.voices.push({source,gain,filter});
      }
      this.buildSamples();
    }
    clearTimeout(this.release);
    await this.context.resume();
    if(activation!==this.activation)return;
    if(this.context.state!=='running')throw new Error(`Sound is ${this.context.state}. Try Resume sound.`);
    this.envelope.reset();this.active=false;
    for(const voice of this.voices)voice.gain.gain.setValueAtTime(0,this.context.currentTime);
    this.master.gain.setValueAtTime(0,this.context.currentTime);this.enabled=true;
  }
  mute() {
    this.activation++;
    this.enabled=false;this.active=false;this.setDrift(false);this.setHeat(0,false);
    clearTimeout(this.release);
    const context=this.context;
    if(!context || context.state==='closed')return;
    this.master.gain.setTargetAtTime(0,context.currentTime,.06);
    this.release=setTimeout(()=>{
      if(context.state!=='closed')context.suspend().catch(error=>console.error('Engine audio suspension failed',error));
    },200);
  }
  async useSamples(raw) {this.raw=raw;this.samples=undefined;await this.buildSamples();}
  // SWE1R wav engine/boost loops replace the synthetic layers when the optional folder is attached.
  async buildSamples() {
    const raw=this.raw,context=this.context;
    if(!raw || !context || this.samples || this.building)return;
    this.building=true;
    try {
      const buffers={};
      for(const [name,bytes] of raw)buffers[name]=await context.decodeAudioData(bytes.slice().buffer);
      const loop=name=>{
        if(!buffers[name])return;
        const source=context.createBufferSource(),gain=context.createGain();
        source.buffer=buffers[name];source.loop=true;gain.gain.value=0;source.connect(gain);gain.connect(this.master);source.start();
        return {source,gain};
      };
      const engines={};
      for(const name of new Set([SFX.engine,...Object.values(POD_ENGINES)]))engines[name]=loop(name);
      this.samples={buffers,engines,jet:loop(SFX.boost)};
      this.pickEngine();
    } catch(error) {console.error('SWE1R sound decode failed',error);}
    this.building=false;
  }
  // Selects the engine loop for the current pod; falls back to the generic loop, then the procedural layers.
  setPod(skin) {this.podEngine=podEngineFor(skin);this.pickEngine();}
  pickEngine() {
    const s=this.samples;if(!s)return;
    const next=s.engines[this.podEngine]??s.engines[SFX.engine];
    if(s.engine&&s.engine!==next)s.engine.gain.gain.setTargetAtTime(0,this.context.currentTime,.05);
    s.engine=next;
  }
  // Plays raw wav bytes once (voice lines); one at a time so lines never overlap.
  async say(bytes,gain=1) {
    if(!this.sampleOn || !this.enabled || !this.active || this.context.state!=='running' || this.talking)return;
    this.talking=true;
    try {
      const source=this.context.createBufferSource(),node=this.context.createGain();
      source.buffer=await this.context.decodeAudioData(bytes.slice().buffer);node.gain.value=gain;source.connect(node);node.connect(this.master);
      source.onended=()=>{this.talking=false;};source.start();
    } catch {this.talking=false;}
  }
  // Plays a music stinger once, independent of voice lines.
  async stinger(bytes,gain=.7) {
    if(!bytes || !this.sampleOn || !this.enabled || !this.active || this.context.state!=='running')return;
    try {
      const source=this.context.createBufferSource(),node=this.context.createGain();
      source.buffer=await this.context.decodeAudioData(bytes.slice().buffer);node.gain.value=gain;source.connect(node);node.connect(this.master);source.start();
    } catch {/* undecodable stinger: stay silent */}
  }
  // Looping music (race track); a newer call or stopLoop() replaces it.
  async loopMusic(bytes,gain=.6) {
    this.stopLoop();
    if(!bytes || !this.sampleOn || !this.enabled || !this.active || this.context.state!=='running')return false;
    const token=this.loopToken;
    try {
      const buffer=await this.context.decodeAudioData(bytes.slice().buffer);
      if(token!==this.loopToken)return false;
      const source=this.context.createBufferSource(),node=this.context.createGain();
      source.buffer=buffer;source.loop=true;node.gain.value=gain;source.connect(node);node.connect(this.master);source.start();
      this.loop=source;return true;
    } catch {return false;}
  }
  stopLoop() {this.loopToken=(this.loopToken||0)+1;try{this.loop?.stop();}catch{/* already stopped */}this.loop=undefined;}
  cue(name,gain=.8) {
    const buffer=this.samples?.buffers[name];
    if(!buffer || !this.sampleOn || !this.enabled || !this.active || this.context.state!=='running')return;
    const source=this.context.createBufferSource(),node=this.context.createGain();
    source.buffer=buffer;node.gain.value=gain;source.connect(node);node.connect(this.master);source.start();
  }
  // Drift: activate one-shot, then the steady loop until released (silent without the SWE1R samples).
  setDrift(on) {
    const b=this.samples?.buffers,start=b?.sfx_pod_binder_activate_a,loop=b?.sfx_pod_binder_steady_loop;
    on=on&&!!start&&!!loop&&this.sampleOn&&this.enabled&&this.context?.state==='running';
    if(on===!!this.drifting)return;
    if(!on){try{this.drifting.stop();}catch{/* already stopped */}this.drifting=undefined;return;}
    const t=this.context.currentTime,gain=this.context.createGain(),source=this.context.createBufferSource();
    gain.gain.value=.5;gain.connect(this.master);source.buffer=loop;source.loop=true;source.connect(gain);source.start(t+start.duration);
    this.cue('sfx_pod_binder_activate_a',.6);this.drifting=source;
  }
  // Looping sample that follows a condition (klaxon, coolant); name undefined stops it.
  holdLoop(key,name,gain) {
    const held=this.held??={},b=name&&this.samples?.buffers[name];
    const want=b&&this.sampleOn&&this.enabled&&this.active&&this.context?.state==='running'?name:undefined;
    if(held[key]?.name===want)return;
    try{held[key]?.source.stop();}catch{/* already stopped */}
    delete held[key];
    if(!want)return;
    const gainNode=this.context.createGain(),source=this.context.createBufferSource();
    gainNode.gain.value=gain;gainNode.connect(this.master);source.buffer=b;source.loop=true;source.connect(gainNode);source.start();
    held[key]={name,source};
  }
  // Engine heat 0..1: klaxon by stage; coolant one-shot then loop while venting after a hot run (heat was >= .5).
  setHeat(heat,boosting) {
    const was=this.heatMem??={};
    this.holdLoop('klaxon',HEAT.klaxon[heatStage(heat)-1],.3);
    if(heat>=.5)was.hot=true;
    const cooling=!!was.hot&&!boosting&&heat>.05;
    if(cooling&&!was.cooling)this.cue(HEAT.coolOn,.5);
    was.cooling=cooling;
    if(heat<=.05)was.hot=false;
    this.holdLoop('coolant',cooling?HEAT.cool:undefined,.25);
  }
  // One-shot SWE1R effects on rising/falling edges of boost, airbrake and obstacle contact.
  edges(boost,brake,hit,now) {
    const was=this.was??={};
    if(boost&&!was.boost)this.cue(SFX.ignite,.5);
    if(brake!==was.brake&&was.brake!==undefined)this.cue(brake?'sfx_pod_airbrakes_on':'sfx_pod_airbrakes_off',.4);
    if(hit&&!was.hit&&now>(was.crashAt??0)+.5){was.crashAt=now;this.cue('sfx_crash_metal_med1',.7);}
    was.boost=boost;was.brake=brake;was.hit=hit;
  }
  update(state,input,dt,active) {
    if(!this.enabled || this.context?.state!=='running')return;
    const now=this.context.currentTime;
    if(active!==this.active){
      this.active=active;this.envelope.reset();if(this.was)this.was.boost=this.was.brake=this.was.hit=undefined;
      this.master.gain.setTargetAtTime(active?1:0,now,.06);
    }
    this.setDrift(active&&!!(input.flags&4));
    if(!active)return;
    const p=state.telemetry,held=!!p[8] || !!state.scene?.waitingCollision;
    const boosting=!!(input.flags&2) && input.throttle>0 && !!p[7] && !(input.flags&1);
    this.edges(!!(input.flags&2),!!(input.flags&1),p[8]===3,now);
    const layers=this.envelope.advance(p[5],input.throttle,boosting,held,!!(input.flags&1),dt,!!p[7],!!p[9]);
    const s=this.samples,real=this.sampleOn && s?.engine;
    if(real) {
      const e=this.envelope;
      s.engine.gain.gain.setTargetAtTime(.12+.25*e.thrust,now,.05);
      s.engine.source.playbackRate.setTargetAtTime(.7+1.1*e.speed+.3*e.thrust,now,.08);
      if(s.jet){s.jet.gain.gain.setTargetAtTime(.3*e.boost,now,.05);s.jet.source.playbackRate.setTargetAtTime(.9+.2*e.speed,now,.08);}
    } else if(s?.engine) {
      s.engine.gain.gain.setTargetAtTime(0,now,.05);
      if(s.jet)s.jet.gain.gain.setTargetAtTime(0,now,.05);
    }
    for(let i=0;i<this.voices.length;i++) {
      const voice=this.voices[i],layer=layers[i];
      voice.gain.gain.setTargetAtTime(real?0:layer[0],now,.03);
      voice.source.playbackRate.setTargetAtTime(layer[1],now,.06);
      voice.filter.frequency.setTargetAtTime(layer[2],now,.08);
    }
  }
}
