import {beltWind,FLOW} from './cloud-flow.js';
import {subPoint} from './space.js';
import {windSeaK} from './wind.js';

// Visual sea state (design/ocean.md phase 1). Never read by physics; a pure function of latitude and the smoothed weather level.
export const SEA={calm:.2,beltGain:.6,rainGain:.35};
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const PEAK_WIND=FLOW.zonal*FLOW.westerlyBoost;

/** Wind energy 0..1 at a latitude (rad) from the planetary belt winds, raised by rain intensity 0..1. */
export function seaWindK(lat,rain=0) {
  const [u,v]=beltWind(lat);
  return clamp(SEA.calm+SEA.beltGain*Math.hypot(u,v)/PEAK_WIND+SEA.rainGain*clamp(rain,0,1),0,1);
}

/** [windK, rain] for the terrain/water uniform at a flat chart position. */
export function seaState(x,z,rain=0,centre,radius,windStrength) {
  const r=clamp(rain,0,1),k=seaWindK(subPoint(x,z,centre,radius).lat,r);
  // The procedural wind (wind.js) can only raise the sea state (whitecaps, fine-normal gain); the physics waves never read it.
  return [windStrength===undefined?k:Math.max(k,windSeaK(windStrength)),r];
}
