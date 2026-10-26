// M3 foundations for the unified space sim (SPACE-PHYSICS.md): radial gravity, atmosphere density and the space boundary.
// Pure functions parameterised by body constants (bodies.js wraps them as gravityFor/densityFor/circularSpeedFor); defaults are Azeroth.
import {PLANET_RADIUS} from './space.js';

export const ATMOSPHERE_EDGE=Math.round(PLANET_RADIUS*.12);
export const SURFACE_GRAVITY=9.81*1.0936;
const SCALE_HEIGHTS=7;

/** Gravitational acceleration (yd/s^2) toward the planet centre at an altitude; inverse-square, equals SURFACE_GRAVITY at sea level. */
export const gravityAt=(altitude,radius=PLANET_RADIUS,surface=SURFACE_GRAVITY)=>surface*(radius/(radius+Math.max(0,altitude)))**2;
/** Relative air density (1 at sea level), exponential, forced to 0 at the atmosphere edge so there is no tail to hand off through. */
export const densityAt=(altitude,edge=ATMOSPHERE_EDGE)=>{const h=Math.max(0,altitude);return !edge||h>=edge?0:Math.exp(-h/(edge/SCALE_HEIGHTS))*(1-h/edge);};
/** Orbital speed for a circular orbit at an altitude. */
export const circularSpeed=(altitude,radius=PLANET_RADIUS,surface=SURFACE_GRAVITY)=>Math.sqrt(gravityAt(altitude,radius,surface)*(radius+altitude));
