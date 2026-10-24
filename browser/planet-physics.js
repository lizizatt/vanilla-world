// M3 foundations for the unified space sim (SPACE-PHYSICS.md): radial gravity, atmosphere density and the space boundary.
// Pure functions, not yet driving flight: the flat Rust physics stays authoritative below ATMOSPHERE_EDGE.
import {PLANET_RADIUS} from './space.js';

export const ATMOSPHERE_EDGE=Math.round(PLANET_RADIUS*.12);
export const SURFACE_GRAVITY=9.81*1.0936;
const SCALE_HEIGHT=ATMOSPHERE_EDGE/7;

/** Gravitational acceleration (yd/s^2) toward the planet centre at an altitude; inverse-square, equals SURFACE_GRAVITY at sea level. */
export const gravityAt=(altitude,radius=PLANET_RADIUS)=>SURFACE_GRAVITY*(radius/(radius+Math.max(0,altitude)))**2;
/** Relative air density (1 at sea level), exponential, forced to 0 at the atmosphere edge so there is no tail to hand off through. */
export const densityAt=altitude=>altitude>=ATMOSPHERE_EDGE?0:Math.exp(-Math.max(0,altitude)/SCALE_HEIGHT)*(1-Math.max(0,altitude)/ATMOSPHERE_EDGE);
/** Orbital speed for a circular orbit at an altitude. */
export const circularSpeed=(altitude,radius=PLANET_RADIUS)=>Math.sqrt(gravityAt(altitude,radius)*(radius+altitude));
