// Inter-body flight readout (design/elune.md step D): HUD text from a space-flight state.
import {nearestSurface,regimeOf} from './bodies.js';
/** Top readout visibility: shown when airborne in the atmosphere, hidden once the body's space band is reached; returns below 95% of that altitude (hysteresis, no flicker). */
export function readoutVisible(altitude,body,wasVisible=true) {
  const edge=body.ranges.space[1],ground=regimeOf(altitude,body)==='ground';
  return !ground&&(wasVisible?altitude<edge:altitude<edge*.95);
}
import {flySpeed} from './space-flight.js';

const compact=v=>v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(1)+'k':v.toFixed(0);

/** {parent, nearest, altitude, speed, label}: yd and yd/s. */
export function spaceReadout(state,t,fast=false) {
  const {id,altitude}=nearestSurface(state.pos,t),speed=flySpeed(altitude,fast);
  return {parent:state.parent,nearest:id,altitude,speed,
    label:`${id.toUpperCase()} ${compact(altitude)} yd · ${compact(speed)} yd/s · WELL ${state.parent.toUpperCase()}`};
}
