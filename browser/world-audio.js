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
export class WorldAudio {
  constructor(){this.envelope=new EngineEnvelope();this.enabled=false;this.voices=[];this.active=false;this.activation=0;}
  async enable() {
    const activation=++this.activation;
    if(!globalThis.AudioContext)throw new Error('Web Audio is unavailable in this browser.');
    if(!this.context) {
      this.context=new AudioContext();
      this.master=this.context.createGain();this.master.gain.value=0;
      this.analyser=this.context.createAnalyser();this.master.connect(this.analyser);this.analyser.connect(this.context.destination);
      for(let layer=0;layer<3;layer++) {
        const buffer=this.context.createBuffer(2,48000,24000);
        fillEngineBuffer(buffer,layer);
        const source=this.context.createBufferSource(),gain=this.context.createGain(),filter=this.context.createBiquadFilter();
        source.buffer=buffer;source.loop=true;gain.gain.value=0;
        filter.type='lowpass';filter.Q.value=.5;filter.frequency.value=1000;
        source.connect(filter);filter.connect(gain);gain.connect(this.master);source.start();
        this.voices.push({source,gain,filter});
      }
    }
    clearTimeout(this.release);
    await this.context.resume();
    if(activation!==this.activation)return;
    this.envelope.reset();this.active=false;
    for(const voice of this.voices)voice.gain.gain.setValueAtTime(0,this.context.currentTime);
    this.master.gain.setValueAtTime(0,this.context.currentTime);this.enabled=true;
  }
  mute() {
    this.activation++;
    this.enabled=false;this.active=false;
    if(!this.context)return;
    this.master.gain.setTargetAtTime(0,this.context.currentTime,.06);
    clearTimeout(this.release);
    this.release=setTimeout(()=>this.context.suspend().catch(error=>console.error('Engine audio suspension failed',error)),200);
  }
  update(state,input,dt,active) {
    if(!this.enabled || this.context?.state!=='running')return;
    const now=this.context.currentTime;
    if(active!==this.active){
      this.active=active;this.envelope.reset();
      this.master.gain.setTargetAtTime(active?1:0,now,.06);
    }
    if(!active)return;
    const p=state.telemetry,held=!!p[8] || !!state.scene?.waitingCollision;
    const boosting=!!(input.flags&2) && input.throttle>0 && !!p[7] && p[6]>0 && !(input.flags&1);
    const layers=this.envelope.advance(p[5],input.throttle,boosting,held,!!(input.flags&1),dt,!!p[7],!!p[9]);
    for(let i=0;i<this.voices.length;i++) {
      const voice=this.voices[i],layer=layers[i];
      voice.gain.gain.setTargetAtTime(layer[0],now,.03);
      voice.source.playbackRate.setTargetAtTime(layer[1],now,.06);
      voice.filter.frequency.setTargetAtTime(layer[2],now,.08);
    }
  }
}
