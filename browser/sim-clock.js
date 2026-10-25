// Authoritative sim clock (see design/time.md). Pure: no DOM, no GPU.
export const DAY_PERIOD=2880,NOON=1440,TIME_SCALES=[0,1,10,100,1000];

/** Time units are Light.dbc half-minutes (2880 = 24h). 1x runs one game minute per real second (a 24 minute day). */
export const UNITS_PER_SECOND=2;
export const simDelta=(dt,scale)=>Math.max(0,dt)*Math.max(0,scale)*UNITS_PER_SECOND;
export const wrapTime=t=>((t%DAY_PERIOD)+DAY_PERIOD)%DAY_PERIOD;
/** Ironforge Standard Time HH:MM IST (noon = 12:00). */
export const istText=t=>{const m=Math.floor(wrapTime(t)/DAY_PERIOD*1440)%1440;return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')+' IST';};
export const sanitiseScale=s=>TIME_SCALES.includes(Number(s))?Number(s):1;
/** Smoothly sun-based daylight 0..1 (1 at noon, 0 at midnight), matching the sky's nightAlpha. */
export const daylightAt=t=>1-Math.min(1,Math.max(0,Math.cos(t/DAY_PERIOD*Math.PI*2)*2));

export class SimClock {
  constructor(time=NOON,scale=1) {this.t=wrapTime(time);this.scale=sanitiseScale(scale);this.dt=0;}
  now() {return this.t;}
  set(time) {this.t=wrapTime(time);}
  /** Advance by real dt; this.dt is the sim time units elapsed this frame (0 when paused). */
  step(dt) {this.dt=simDelta(dt,this.scale);this.t=wrapTime(this.t+this.dt);return this.t;}
}

/** Cloud/whirlpool animation rate (cloud seconds per real second): linear to 10x, then compressed (the flow map cannot cross-fade 1000x) so 100x/1000x still read as fast but not strobing; 0 when paused. */
export const cloudRate=scale=>scale<=10?Math.max(0,scale):10*Math.pow(scale/10,.45);
/** Flow-map cycle stretch: keeps the cloud flow reset slow in real time at high speed (cycle >= ~5 s) so it never strobes. */
export const flowScale=rate=>Math.min(5,Math.max(1,rate/10));
/** Wrap for the f32 shader clock (about 1 hour at the 1000x rate). */
export const CLOUD_TIME_WRAP=4e6;
export const CLOUD_MAX_DT=.1,FLOW_SCALE_TAU=1.5;

/**
 * Cloud animation clock. time (cloud s) drives noise/spin; cycles (0..1) is the flow-map phase. The cycle stretch eases toward flowScale(rate)
 * and cycles integrates dt*rate/(period*stretch), so a speed change or hitch never jumps the phase; one frame advances at most CLOUD_MAX_DT real s.
 */
export class CloudClock {
  constructor(time=0,period=90) {this.time=time%CLOUD_TIME_WRAP;this.period=period;this.stretch=1;this.cycles=(time/period)%1;}
  step(dt,simScale) {
    const d=Math.min(Math.max(dt,0),CLOUD_MAX_DT),rate=cloudRate(simScale);
    this.stretch+=(flowScale(rate)-this.stretch)*(1-Math.exp(-d/FLOW_SCALE_TAU));
    this.time=(this.time+d*rate)%CLOUD_TIME_WRAP;
    this.cycles=(this.cycles+d*rate/(this.period*this.stretch))%1;
    return this;
  }
}
