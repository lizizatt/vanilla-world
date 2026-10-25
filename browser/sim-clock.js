// Authoritative sim clock (see design/time.md). Pure: no DOM, no GPU.
export const DAY_PERIOD=2880,NOON=1440,TIME_SCALES=[0,1,10,100,1000];
const EASE_RATE=DAY_PERIOD/4;

/** Sim minutes advanced for dt real seconds at scale sim-seconds per real second. */
export const simDelta=(dt,scale)=>Math.max(0,dt)*Math.max(0,scale)/60;
export const wrapTime=t=>((t%DAY_PERIOD)+DAY_PERIOD)%DAY_PERIOD;
export const sanitiseScale=s=>TIME_SCALES.includes(Number(s))?Number(s):1;
/** Smoothly sun-based daylight 0..1 (1 at noon, 0 at midnight), matching the sky's nightAlpha. */
export const daylightAt=t=>1-Math.min(1,Math.max(0,Math.cos(t/DAY_PERIOD*Math.PI*2)*2));

export class SimClock {
  constructor(time=NOON,scale=1) {this.t=wrapTime(time);this.scale=sanitiseScale(scale);this.dt=0;this.target=undefined;}
  now() {return this.t;}
  set(time) {this.t=wrapTime(time);this.target=undefined;}
  /** Ease to a time over about a second (the night toggle); free-runs afterwards. */
  easeTo(time) {this.target=wrapTime(time);}
  /** Advance by real dt; this.dt is the sim minutes elapsed this frame (0 when paused). */
  step(dt) {
    if(this.target!==undefined) {
      const gap=(this.target-this.t+DAY_PERIOD)%DAY_PERIOD;
      if(gap<1){this.t=this.target;this.target=undefined;this.dt=0;return this.t;}
      const move=Math.min(gap,EASE_RATE*Math.max(0,dt));this.t=wrapTime(this.t+move);this.dt=move;return this.t;
    }
    this.dt=simDelta(dt,this.scale);this.t=wrapTime(this.t+this.dt);return this.t;
  }
}

/** Cloud/whirlpool animation rate (cloud seconds per real second): linear to 10x, then compressed (the flow map cannot cross-fade 1000x) so 100x/1000x still read as fast but not strobing; 0 when paused. */
export const cloudRate=scale=>scale<=10?Math.max(0,scale):10*Math.pow(scale/10,.45);
/** Wrap for the f32 shader clock (about 1 hour at the 1000x rate). */
export const CLOUD_TIME_WRAP=4e6;
