// Position-based sun: the sun is one inertial direction (sky-coupling sunInertial), so what a camera sees depends on where it stands on the sphere, not on the global clock.
import {planetFrame} from './space.js';
import {sunInBody} from './sky-coupling.js';
import {DAY_PERIOD,wrapTime} from './sim-clock.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

/** Sun at a chart position (x,z) of `body` at sim time t, as (east, up, south) of the local frame; up is the sine of the sun elevation. */
export function localSunAt(body,x,z,t) {
  const f=planetFrame(x,z,body.centre,body.radius),s=sunInBody(body,t);
  return [dot(f.east,s),dot(f.up,s),dot(f.south,s)];
}

/** Light.dbc half-minute clock reading that a local sun corresponds to: 720 sunrise (sun east, on the horizon), 1440 noon, 2160 sunset, 0 midnight. Equals the global clock at the chart origin. */
export const solarTime=sun=>wrapTime(DAY_PERIOD/4+Math.atan2(sun[1],sun[0])*DAY_PERIOD/(2*Math.PI));
