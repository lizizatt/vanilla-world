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
