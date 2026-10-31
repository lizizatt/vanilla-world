// WGSL twin of weather-field.js: built from the same WEATHER constants, dropped into the cloud module (needs vnoise3 from flowWGSL).
import {WEATHER as W} from './weather-config.js';

const f=x=>Number.isInteger(x)?x.toFixed(1):String(x);
export function weatherWGSL() {
  const s=f(1/W.cell.scale);
  return `
fn wxCellNoise(Q:vec3f)->f32 {
  let a=vnoise3(Q*${s});let b=vnoise3(Q*${s}*${f(W.cell.octave2)}+vec3f(11.0));
  return smoothstep(${f(W.cell.gate[0])},${f(W.cell.gate[1])},${f(1-W.cell.mix)}*a+${f(W.cell.mix)}*b);
}
fn wxLifeEnvelope(u:f32)->f32 {let fr=fract(u);return smoothstep(0.0,${f(W.life.build)},fr)*(1.0-smoothstep(${f(1-W.life.decay)},1.0,fr));}
fn wxCellIntensity(Q:vec3f,t:f32)->f32 {
  let phase=vnoise3(Q*${f(1/W.cell.scale*.5)}+vec3f(19.7));
  return wxCellNoise(Q)*wxLifeEnvelope(t/${f(W.life.period)}+phase*3.0);
}
fn wxCoverageGate(cov:f32)->f32 {return smoothstep(${f(W.coverage[0])},${f(W.coverage[1])},cov);}
fn wxStormRain(storm:f32,eye:f32)->f32 {return smoothstep(${f(W.storm.from)},${f(W.storm.to)},storm)*eye*${f(W.storm.heavy)};}
fn wxSpaceRain(P:f32,n:f32,k:f32)->f32 {return clamp(P*(1.0+k*${f(W.space.streak)}*(1.1*smoothstep(.3,.7,n)-.65)),0.0,1.0);}`;
}
/** Cloud look under precipitation (shared by both cloud tiers and the CPU mirror): coverage swells and the base darkens with P. */
export const WEATHER_LOOK={coverage:.1,dim:.45};
