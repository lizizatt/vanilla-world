// Polar light (design/poles.md 9): imitate an axial tilt without seasons. North pole = eternal night, south pole = eternal day (low golden sun), blended in by |latitude| only,
// so mid-latitude day/night and the golden shots stay bit-identical. Applies to the LOCAL lighting vector only; the shared orbit/sky is untouched.
import {smoothstep} from './math.js';

const deg=Math.PI/180;
export const POLAR_LIGHT={start:60*deg,full:80*deg,tilt:.16,// tilt: sin of the apparent sun elevation offset (~9 deg)
  southDay:.78,northFloor:0};// scalar daylight targets for the global-clock path (Azeroth)

export const polarWeight=lat=>smoothstep(POLAR_LIGHT.start,POLAR_LIGHT.full,Math.abs(lat));

/** Sun direction (unit, body space) seen at a point of latitude `lat` (rad): nudged toward -Y by tilt*weight, so the south pole sees it always above the horizon and the north pole always below. Identity below `start`. */
export function polarSun(sun,lat,p=POLAR_LIGHT) {
  const w=polarWeight(lat);
  if(w===0)return sun;
  const v=[sun[0],sun[1]-p.tilt*w,sun[2]],m=Math.hypot(...v);
  return [v[0]/m,v[1]/m,v[2]/m];
}
/** Azeroth's scalar daylight (0 night .. 1 day, from the global clock curve) blended toward the polar targets. Identity below `start`. */
export function polarDaylight(daylight,lat,p=POLAR_LIGHT) {
  const w=polarWeight(lat);
  return w===0?daylight:daylight+((lat<0?p.southDay:p.northFloor)-daylight)*w;
}
