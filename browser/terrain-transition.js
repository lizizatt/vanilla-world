// Sole owner of the far-to-near transition ramps. Altitude (yd) ranges [start,end] of each smoothstep fade between the
// flat near terrain and the planet view; space.js (globe/fog shader), regime.js, clouds and the renderer all read these.
export const BEND_RANGE=Object.freeze([150,1500]);
export const GLOBE_RANGE=Object.freeze([0,60]);
export const SPACE_RANGE=Object.freeze([2000,9000]);
export const CLOUD_RANGE=Object.freeze([3000,9000]);

const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const fix=n=>Number(n.toFixed(6));
const ramp=(range,altitude)=>fix(smooth(range[0],range[1],altitude));

/** WGSL `smoothstep(start,end,` prefix for a range, so shader literals come from the same table. */
export const wgslRamp=range=>`smoothstep(${range[0].toFixed(1)},${range[1].toFixed(1)},`;

/** Fade factors for an altitude: bend (terrain curvature), globe (sphere alpha), space (black sky, stars), cloud (cloud visibility). */
export function planetFactors(altitude,enabled=true) {
  if(!enabled||!(altitude>0))return {bend:0,globe:0,space:0,cloud:1};
  return {bend:ramp(BEND_RANGE,altitude),globe:ramp(GLOBE_RANGE,altitude),space:ramp(SPACE_RANGE,altitude),cloud:fix(1-ramp(CLOUD_RANGE,altitude))};
}
