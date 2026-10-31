// Single source of truth for the gameplay sea (design/ocean.md section 4). The physics (Rust, `set_waves`), the JS mirror
// (wave-math.js) and any shader read these numbers; nothing else may carry private wave constants.
// Units: yards and seconds. Chart x/z are the flat world chart (the same coordinates as the Rust physics).
import {MAELSTROM,WHIRLPOOL_DIP} from './cloud-config.js';

/** Bumped whenever the wave function or its numbers change: recordings and ghosts store it (waveTag) and only replay when it matches. */
export const WAVE_VERSION=1;
/** Gravity used in the deep-water dispersion w^2 = g k; equals the physics GRAVITY (flats-racer-physics lib.rs), asserted by test. */
export const WAVE_G=48;
/** Master period (s). Every angular frequency is 2 pi n / T with integer n, so the clock wraps with zero discontinuity. */
export const WAVE_PERIOD=1024;
/** Sim ticks per second: the wave clock is the sim tick count, never a wall or render clock, so pause pauses the waves. */
export const WAVE_TICKS_PER_SECOND=120;
export const WAVE_PARAMS_VERSION=1;
/** Compass-free wind heading in the chart plane (rad from +x toward +z); region wind from beltWind can replace it later. */
export const WAVE_WIND=.6;

/**
 * Wave components, longest first. `n` is the integer frequency multiple, `dir` the heading offset from the wind (rad),
 * `amp` the amplitude (yd) at scale 1 (sum 1.0 yd = "1 yd normal"), `q` the Gerstner steepness (<= 1).
 * Wavelengths come out of the dispersion: 356, 165, 89 and 45 yd. At scale 1 the largest slope is about .038, so the
 * default sea is nearly glass to a pod; steep faces exist only in the big-scale regions.
 */
export const WAVE_COMPONENTS=Object.freeze([
  Object.freeze({n:150,dir:0,amp:.5,q:.5,phase:.7}),
  Object.freeze({n:220,dir:.35,amp:.3,q:.5,phase:2.1}),
  Object.freeze({n:300,dir:-.5,amp:.15,q:.5,phase:4}),
  Object.freeze({n:420,dir:.9,amp:.05,q:.5,phase:5.3}),
]);

/** Amplitude multipliers by region (1 = the normal 1 yd sea). */
export const WAVE_SCALES=Object.freeze({normal:1,storm:2.5,maelstrom:10});
/** Largest slope any region may reach. Default slopes stay gentle (~.25 cap) so a wave face only becomes an impact when it is very large. */
export const WAVE_SLOPE_CAPS=Object.freeze({normal:.25,storm:.5,maelstrom:.5});
/** Shore: waves are exactly 0 within `margin` yd of land or authored water and reach full size `fade` yd further out. The margin exceeds the largest horizontal displacement. */
export const WAVE_SHORE=Object.freeze({fade:32,margin:12});
/** Maelstrom regions (yd around the whirlpool centre): full 10x inside `peakRadius`, easing to the storm sea at the funnel's `MAELSTROM.radius`, which eases to the normal sea by `haloRadius`. */
export const WAVE_MAELSTROM=Object.freeze({peakRadius:2*WHIRLPOOL_DIP.radius,stormRadius:MAELSTROM.radius,haloRadius:2*MAELSTROM.radius});

/** Largest per-tick-safe limits the loader enforces (also re-validated in Rust). */
export const WAVE_LIMITS=Object.freeze({contraction:.9,maxScale:20});

const k_of=n=>{const w=2*Math.PI*n/WAVE_PERIOD;return w*w/WAVE_G;};
export const waveComponent=c=>{
  const omega=2*Math.PI*c.n/WAVE_PERIOD,heading=WAVE_WIND+c.dir;
  return {k:omega*omega/WAVE_G,omega,dir:[Math.cos(heading),Math.sin(heading)],amp:c.amp,steepness:c.q,phase:c.phase};
};
export const waveSlopeSum=(components=WAVE_COMPONENTS)=>components.reduce((s,c)=>s+c.amp*k_of(c.n),0);

/**
 * Parameter block uploaded to Rust with world.set_waves(Float64Array) and read by wave-math.js `paramsFromArray`:
 * [version, period, shoreFade, shoreMargin, defaultSlopeCap, n, n*(k, omega, dx, dz, amp, steepness, phase),
 *  m, m*(cx, cz, inner, outer, scale, slopeCap)].
 * `maelstrom` is the whirlpool centre in global chart yd; `storms` are extra [x, z, radius] storm discs (hook for weather cells).
 */
export function waveParams({maelstrom,storms=[],components=WAVE_COMPONENTS,scales=WAVE_SCALES,caps=WAVE_SLOPE_CAPS}={}){
  const discs=[];
  const [mx,mz]=maelstrom??[0,0];
  for(const [x,z,r] of storms)discs.push([x,z,r,2*r,scales.storm,caps.storm]);
  if(maelstrom){
    const m=WAVE_MAELSTROM;
    discs.push([mx,mz,m.stormRadius,m.haloRadius,scales.storm,caps.storm]);
    discs.push([mx,mz,m.peakRadius,m.stormRadius,scales.maelstrom,caps.maelstrom]);
  }
  const out=[WAVE_PARAMS_VERSION,WAVE_PERIOD,WAVE_SHORE.fade,WAVE_SHORE.margin,caps.normal,components.length];
  for(const c of components){const w=waveComponent(c);out.push(w.k,w.omega,w.dir[0],w.dir[1],w.amp,w.steepness,w.phase);}
  out.push(discs.length);
  for(const d of discs)out.push(...d);
  return Float64Array.from(out);
}

/** Tag stored with a recording or ghost: it replays only against the same wave function, and waves-off recordings (0) stay valid with waves off. */
export const waveTag=(enabled,startTick=0)=>({waveVersion:enabled?WAVE_VERSION:0,waveTick:enabled?startTick:0});
export const waveTagCompatible=(tag,enabled)=>(tag?.waveVersion??0)===(enabled?WAVE_VERSION:0);
