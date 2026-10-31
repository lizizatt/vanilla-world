// CPU precipitation field (design/weather.md, option A). A cell is low-frequency noise sampled at the cloud's own flow-advected point Q, so it
// rides the deck; its intensity is gated by the cloud coverage, scaled by a looping lifecycle, and overridden by the Maelstrom storm.
// weather-wgsl.js emits the same expressions for the GPU; weather-field.test.mjs checks the two agree.
import {WEATHER as W} from './weather-config.js';
import {vnoise3} from './cloud-flow.js';
import {smoothstep} from './math.js';

const fract=x=>x-Math.floor(x);
/** Cell strength 0..1 at the advected sphere point Q (yd). */
export function cellNoise(Q) {
  const s=1/W.cell.scale,a=vnoise3(Q[0]*s,Q[1]*s,Q[2]*s),b=vnoise3(Q[0]*s*W.cell.octave2+11,Q[1]*s*W.cell.octave2+11,Q[2]*s*W.cell.octave2+11);
  return smoothstep(W.cell.gate[0],W.cell.gate[1],(1-W.cell.mix)*a+W.cell.mix*b);
}
/** Lifecycle envelope 0..1: zero at the wrap, so cells fade in and out and never pop. */
export function lifeEnvelope(u) {
  const f=fract(u);
  return smoothstep(0,W.life.build,f)*(1-smoothstep(1-W.life.decay,1,f));
}
/** Cell intensity before the coverage gate, at point Q and cloud time t. The phase is spatially smooth noise so neighbouring cells are out of step. */
export function cellIntensity(Q,t) {
  const s=1/W.cell.scale*.5,phase=vnoise3(Q[0]*s+19.7,Q[1]*s+19.7,Q[2]*s+19.7);
  return cellNoise(Q)*lifeEnvelope(t/W.life.period+phase*3);
}
export const coverageGate=coverage=>smoothstep(W.coverage[0],W.coverage[1],coverage);
/** Maelstrom: heavy rain wherever the storm envelope is strong, calm in the eye (eye = smoothstep over eyeRadius, 0 in the eye). */
export const stormRain=(storm,eye)=>smoothstep(W.storm.from,W.storm.to,storm)*eye*W.storm.heavy;
/** Precipitation intensity 0..1 for a sheet point: the cell under its coverage gate, or the storm term (also gated: no rain without rendered cloud), whichever is higher. */
export const precipitation=(Q,t,coverage,storm=0,eye=1)=>Math.max(cellIntensity(Q,t)*coverageGate(coverage),stormRain(storm,eye)*smoothstep(W.storm.cover[0],W.storm.cover[1],coverage));

/** Precipitation as drawn from above: streak noise n (0..1) modulates P with depth k (0 = plain P), so wet cells read as wind-stretched virga. Visual only; the local rain still uses P. */
export const spaceRain=(P,n,k)=>Math.min(1,Math.max(0,P*(1+k*W.space.streak*(1.1*smoothstep(.3,.7,n)-.65))));
/** 0..1 weight of the from-above look for an eye `h` yd above the cloud top (times the tier switch). */
export const spaceLook=(h,on=1)=>on*smoothstep(W.space.ramp[0],W.space.ramp[1],h);

/**
 * Camera-side smoothed state with Schmitt hysteresis: `intensity` eases toward the sampled target, `raining` flips on above W.on and off below
 * W.off so a cell edge never makes it flicker. `kind` is 'rain' | 'snow' | 'none' from the climate.
 */
export class WeatherState {
  constructor() {this.intensity=0;this.raining=false;this.kind='none';this.snowMix=0;}
  step(dt,target,climate={wet:1,snow:0}) {
    const d=Math.min(Math.max(dt,0),.5),t=Math.max(0,Math.min(1,target))*climate.wet;
    this.intensity+=(t-this.intensity)*(1-Math.exp(-d/W.tau));
    this.snowMix+=(climate.snow-this.snowMix)*(1-Math.exp(-d/W.tau));
    if(this.raining?this.intensity<W.off:this.intensity>W.on)this.raining=!this.raining;
    this.kind=!this.raining?'none':this.snowMix>.5?'snow':'rain';
    return this;
  }
  get level() {return this.raining?this.intensity:this.intensity*.5;}
  get heavy() {return this.intensity>=W.heavy;}
}
