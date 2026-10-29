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
export const NORTH_TWILIGHT=-.02;// sine of the sun elevation the cap's terrain/water is lit as: a deep blue-hour glow, still clearly night
/** Raises a below-horizon sun toward NORTH_TWILIGHT by fill/NORTH_NIGHT_FILL (terrain night shading reads the sun elevation). Only affects shading; the sky clock is taken from the raw sun. */
export function northTwilightSun(sun,fill) {
  const w=Math.min(1,fill/NORTH_NIGHT_FILL),y=sun[1]<NORTH_TWILIGHT?sun[1]+(NORTH_TWILIGHT-sun[1])*w:sun[1],m=Math.hypot(sun[0],y,sun[2]);
  return [sun[0]/m,y/m,sun[2]/m];
}
/** Azeroth north cap: a night fill (daylight floor) fading in with polar weight so the ice and sea read against the sky; 0 outside the cap. (x,z) is the eye in global pole-chart coordinates. */
export const NORTH_NIGHT_FILL=.25;
export function northNightFill(x,z,radius,anchor=[0,-200000]) {
  const lat=Math.PI/2-Math.hypot(x-anchor[0],z-anchor[1])/radius;
  return NORTH_NIGHT_FILL*polarWeight(lat);
}
/** Lamp glow on the north flag (a single point 9 yd up the pole), in the renderer's origin-relative matrix form. */
export const northFlagLamp=(origin,anchor=[0,-200000])=>({points:[[0,9,0]],matrix:[1,0,0,0,0,1,0,0,0,0,1,0,anchor[0]-origin[0],0,anchor[1]-origin[1],1]});
/** Azeroth's scalar daylight (0 night .. 1 day, from the global clock curve) blended toward the polar targets. Identity below `start`. */
export function polarDaylight(daylight,lat,p=POLAR_LIGHT) {
  const w=polarWeight(lat);
  return w===0?daylight:daylight+((lat<0?p.southDay:p.northFloor)-daylight)*w;
}
