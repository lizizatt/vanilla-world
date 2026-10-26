// Airless sky for driving on Elune (design/elune.md step C): sun, daylight, earthshine and the direction of Azeroth in the pod's local frame.
import {ELUNE} from './bodies.js';
import {planetFrame} from './space.js';
import {sunInBody,daylightFor,ambientFor} from './sky-coupling.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const local=(frame,v)=>[dot(frame.east,v),dot(frame.up,v),dot(frame.south,v)];

/** For a chart position (x,z) at sim time t: sun/Azeroth directions as (east, up, south), daylight 0..1, and the ambient floor. */
export function eluneSkyAt(x,z,t) {
  const frame=planetFrame(x,z,ELUNE.centre,ELUNE.radius);
  const sun=local(frame,sunInBody(ELUNE,t));
  // Elune is tidally locked: +X in its own frame (chart 0,0) always faces Azeroth.
  const azeroth=local(frame,[1,0,0]);
  return {sun,azeroth,daylight:daylightFor(ELUNE,t,frame.up),ambient:ambientFor(ELUNE,t),up:frame.up};
}
export const AIRLESS_SKY=[0,0,0];
