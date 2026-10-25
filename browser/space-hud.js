// Inter-body flight readout (design/elune.md step D): HUD text from a space-flight state.
import {nearestSurface} from './bodies.js';
import {flySpeed} from './space-flight.js';

const compact=v=>v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(1)+'k':v.toFixed(0);

/** {parent, nearest, altitude, speed, label}: yd and yd/s. */
export function spaceReadout(state,t,fast=false) {
  const {id,altitude}=nearestSurface(state.pos,t),speed=flySpeed(altitude,fast);
  return {parent:state.parent,nearest:id,altitude,speed,
    label:`${id.toUpperCase()} ${compact(altitude)} yd · ${compact(speed)} yd/s · WELL ${state.parent.toUpperCase()}`};
}
