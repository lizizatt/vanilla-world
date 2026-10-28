import {CLOUD_ALTITUDE,CLOUD_THICKNESS} from './cloud-config.js';
import {smoothstep as smooth} from './math.js';
// Sole owner of the far-to-near transition ramps. Altitude (yd) ranges [start,end] of each smoothstep fade between the
// flat near terrain and the planet view; space.js (globe/fog shader), regime.js, clouds and the renderer all read these.
// Azeroth was R=42,781 when these were tuned; they scale with sqrt(R/42,781) (ALTITUDE_SCALE) for the current radius.
export const ALTITUDE_SCALE=0.577;
const scaled=r=>Object.freeze(r.map(v=>Math.round(v*ALTITUDE_SCALE)));
export const BEND_RANGE=scaled([150,1500]);
export const GLOBE_RANGE=scaled([0,60]);
export const SPACE_RANGE=scaled([2000,9000]);
// Per-zone lighting (Light.dbc tint) fades to the global sun look, reaching zero at the base of the lowest cloud layer.
export const ZONE_LIGHT_RANGE=Object.freeze([300,CLOUD_ALTITUDE-CLOUD_THICKNESS*.5]);


const fix=n=>Number(n.toFixed(6));
const ramp=(range,altitude)=>fix(smooth(range[0],range[1],altitude));

/** WGSL `smoothstep(start,end,` prefix for a range, so shader literals come from the same table. */
export const wgslRamp=range=>`smoothstep(${range[0].toFixed(1)},${range[1].toFixed(1)},`;

// The cloud shell's rendered radius is CLOUD_RADIUS_GROUND_SCALE x the planet radius at the ground and relaxes (smoothstep, C1, monotonic) to the true radius by CLOUD_RADIUS_RANGE[1],
// following the terrain bend ramp so the clouds curve exactly as much as the terrain below them (curvature, not radius, is blended) and match the globe from BEND_RANGE[1] up.
export const CLOUD_RADIUS_RANGE=BEND_RANGE;
export const CLOUD_RADIUS_GROUND_SCALE=12;
export const cloudShellRadius=(altitude,planetRadius)=>planetRadius/(1/CLOUD_RADIUS_GROUND_SCALE+(1-1/CLOUD_RADIUS_GROUND_SCALE)*smooth(CLOUD_RADIUS_RANGE[0],CLOUD_RADIUS_RANGE[1],altitude));

// The ground cloud layer sits at 11% of R on the shrunken planet, which reads as a detached shell from space. Above the weather it settles
// (smoothstep over CLOUD_LAYER_RANGE, eye altitude) to a layer at 3.5% of R, so the planet view and every far body view hug the surface.
export const CLOUD_LAYER_RANGE=Object.freeze([3000,9000]);
export const CLOUD_FAR_ALTITUDE_FRACTION=.035;
export const cloudAltitudeAt=(eyeAltitude,planetRadius)=>{const far=Math.min(CLOUD_ALTITUDE,CLOUD_FAR_ALTITUDE_FRACTION*planetRadius);return CLOUD_ALTITUDE+(far-CLOUD_ALTITUDE)*smooth(CLOUD_LAYER_RANGE[0],CLOUD_LAYER_RANGE[1],eyeAltitude);};

/** Fade factors for an altitude: bend (terrain curvature), globe (sphere alpha), space (black sky, stars), zone (per-zone lighting). Clouds have no ramp of their own: the curved layer is always drawn. */
export function planetFactors(altitude,enabled=true) {
  if(!enabled||!(altitude>0))return {bend:0,globe:0,space:0,zone:1};
  return {zone:fix(1-ramp(ZONE_LIGHT_RANGE,altitude)),bend:ramp(BEND_RANGE,altitude),globe:ramp(GLOBE_RANGE,altitude),space:ramp(SPACE_RANGE,altitude)};
}
