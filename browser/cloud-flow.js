// Worldwide cloud flow model (see CLOUD-FLOW.md, option A): an analytic, stateless wind field over the globe (Hadley / Ferrel / polar belts,
// Coriolis-signed meridional flow) used to advect the cloud noise with a two-phase flow-map warp. Pure JS and deterministic; the same
// formulas are emitted as WGSL (flowWGSL) so the shader and the cloud-march.js mirror agree. Latitudes/longitudes are radians; speeds
// are yards per second; the east/north wind pair is in the local tangent frame (north up on the world map), never lon/lat noise space.

const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};

export const FLOW={
  // Peak zonal / meridional surface wind of the belts; westerlies run stronger than the trades.
  zonal:24,meridional:6,westerlyBoost:1.25,
  // Zonal speed fades out toward the pole (east/north degenerate there); rad. `soft` rounds the kink of |lat| at the equator.
  poleFade:[80*Math.PI/180,89*Math.PI/180],soft:.05,
  // Cloud coverage offsets by latitude band (ITCZ boost, subtropical clearing, storm-track boost, thin polar cloud).
  bands:{itcz:.16,itczWidth:.12,clear:.22,clearAt:.49,clearWidth:.11,track:.14,trackAt:.87,trackWidth:.14,polar:.12,polarFrom:[1.2,1.45]},
  // Two-phase flow-map warp: cycle length (s) and the blend window of the triangle wave (pure single phase outside it).
  period:90,blend:[.35,.65],
  // Pinned Maelstrom vortex: Rankine core (yd) and far-field decay, peak tangential speed, and inflow angle off tangential.
  vortex:{core:5200,decay:14000,speed:50,inflow:.35},
};

/** Zonal (east) and meridional (north) belt wind at a latitude. Mirror-symmetric in hemispheres, Coriolis sign included. */
export function beltWind(lat) {
  const s=Math.sqrt(lat*lat+FLOW.soft*FLOW.soft)-FLOW.soft,x=Math.sin(6*s);
  const fade=1-smoothstep(FLOW.poleFade[0],FLOW.poleFade[1],Math.abs(lat));
  return [-FLOW.zonal*x*(x<0?FLOW.westerlyBoost:1)*fade,-FLOW.meridional*Math.sin(6*lat)];
}

/** Coverage offset from the global cells: wet ITCZ, dry subtropics, stormy mid-latitudes, thin polar cloud. */
export function bandCoverage(lat) {
  const B=FLOW.bands,a=Math.abs(lat),g=(x,c,w)=>Math.exp(-(((x-c)/w)**2));
  return B.itcz*g(lat,0,B.itczWidth)-B.clear*g(a,B.clearAt,B.clearWidth)+B.track*g(a,B.trackAt,B.trackWidth)-B.polar*smoothstep(B.polarFrom[0],B.polarFrom[1],a);
}

/** Two-phase flow-map weights at time t: phase offsets (s) into the cycle and the weight of phase A (phase B = 1 - wA, half a cycle later). */
export function flowPhase(t) {
  const f=t/FLOW.period-Math.floor(t/FLOW.period),tri=1-Math.abs(2*f-1),g=FLOW.period;
  return {tauA:f*g,tauB:((f+.5)%1)*g,wA:smoothstep(FLOW.blend[0],FLOW.blend[1],tri)};
}

/** Wind (east, north) at a point: belt winds. */
export const wind=(lat,lon)=>beltWind(lat);

/** The WGSL twin of the functions above; uses only constants, so it can be dropped into any module. */
export function flowWGSL() {
  const f=x=>Number.isInteger(x)?x.toFixed(1):String(x),B=FLOW.bands;
  return `
fn beltWind(lat:f32)->vec2f {
  let s=sqrt(lat*lat+${f(FLOW.soft*FLOW.soft)})-${f(FLOW.soft)};let x=sin(6.0*s);
  let fade=1.0-smoothstep(${f(FLOW.poleFade[0])},${f(FLOW.poleFade[1])},abs(lat));
  return vec2f(-${f(FLOW.zonal)}*x*select(1.0,${f(FLOW.westerlyBoost)},x<0.0)*fade,-${f(FLOW.meridional)}*sin(6.0*lat));
}
fn g2(x:f32)->f32 {return exp(-x*x);}
fn bandCoverage(lat:f32)->f32 {
  let a=abs(lat);
  return ${f(B.itcz)}*g2(lat/${f(B.itczWidth)})-${f(B.clear)}*g2((a-${f(B.clearAt)})/${f(B.clearWidth)})+${f(B.track)}*g2((a-${f(B.trackAt)})/${f(B.trackWidth)})-${f(B.polar)}*smoothstep(${f(B.polarFrom[0])},${f(B.polarFrom[1])},a);
}`;
}
