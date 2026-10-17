const unit=n=>Number.isFinite(n)?Math.max(0,Math.min(1,n)):0;
const tone=(hz,t)=>Math.sin(2*Math.PI*hz*t);
export function engineSample(layer,t) {
  if(layer===0) {
    const engine=hz=>(.64*tone(hz,t)+.22*tone(hz*2,t)+.09*tone(hz*3,t))*(.85+.15*tone(7,t));
    const left=engine(47),right=engine(49);
    return [.8*left+.2*right,.2*left+.8*right];
  }
  if(layer===1){const n=.7*tone(360,t)+.2*tone(720,t)+.08*tone(1080,t);return [n,n];}
  return [( .65*tone(610,t)+.25*tone(1220,t))*(.85+.15*tone(11,t)),
    (.65*tone(613,t)+.25*tone(1226,t))*(.85+.15*tone(11,t))];
}
export class EngineEnvelope {
  constructor(){this.speed=0;this.thrust=0;this.boost=0;}
  advance(speed,throttle,boosting,held,brake,dt) {
    const follow=-Math.expm1(-Math.max(0,dt)/.22),boost=boosting && !held?1:0;
    this.speed+=((held?0:unit(speed/120))-this.speed)*follow;
    this.thrust+=((held || brake?0:unit(Math.abs(throttle)))-this.thrust)*follow;
    this.boost+=(boost-this.boost)*-Math.expm1(-Math.max(0,dt)/(boost>this.boost?.09:.25));
    return [[.075+.035*this.thrust,.8+.7*this.speed+.2*this.thrust],
      [.008+.022*this.thrust+.010*this.speed,.65+this.speed+.4*this.thrust],
      [.035*this.boost,.9+.7*this.speed+.3*this.boost]];
  }
}
export class WorldAudio {
  constructor(){this.envelope=new EngineEnvelope();this.enabled=false;this.voices=[];this.active=false;}
  async enable() {
    if(!globalThis.AudioContext)throw new Error('Web Audio is unavailable in this browser.');
    if(!this.context) {
      this.context=new AudioContext();
      this.master=this.context.createGain();this.master.gain.value=0;
      this.analyser=this.context.createAnalyser();this.master.connect(this.analyser);this.analyser.connect(this.context.destination);
      for(let layer=0;layer<3;layer++) {
        const buffer=this.context.createBuffer(2,48000,24000),left=buffer.getChannelData(0),right=buffer.getChannelData(1);
        for(let i=0;i<left.length;i++){const sample=engineSample(layer,i/24000);left[i]=sample[0];right[i]=sample[1];}
        const source=this.context.createBufferSource(),gain=this.context.createGain();
        source.buffer=buffer;source.loop=true;gain.gain.value=0;
        source.connect(gain);gain.connect(this.master);source.start();
        this.voices.push({source,gain});
      }
    }
    clearTimeout(this.release);
    await this.context.resume();this.envelope=new EngineEnvelope();this.active=false;
    this.master.gain.setValueAtTime(0,this.context.currentTime);this.enabled=true;
  }
  mute() {
    this.enabled=false;this.active=false;
    if(!this.context)return;
    this.master.gain.setTargetAtTime(0,this.context.currentTime,.06);
    clearTimeout(this.release);
    this.release=setTimeout(()=>this.context.suspend().catch(error=>console.error('Engine audio suspension failed',error)),200);
  }
  update(state,input,dt,active) {
    if(!this.enabled || this.context?.state!=='running')return;
    const now=this.context.currentTime;
    if(active!==this.active){this.active=active;this.master.gain.setTargetAtTime(active?1:0,now,.06);}
    const p=state.telemetry,held=!!p[8] || !!state.scene?.waitingCollision;
    const boosting=!!(input.flags&2) && input.throttle>0 && !!p[7] && p[6]>0 && !(input.flags&1);
    const layers=this.envelope.advance(p[5],input.throttle,boosting,held,!!(input.flags&1),dt);
    for(let i=0;i<this.voices.length;i++) {
      this.voices[i].gain.gain.setTargetAtTime(layers[i][0],now,.03);
      this.voices[i].source.playbackRate.setTargetAtTime(layers[i][1],now,.03);
    }
  }
}
