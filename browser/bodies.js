// Bodies (design/elune.md M0): Azeroth and Elune as coexisting spheres in one inertial frame (f64, Azeroth-centred, +Y up).
// Pure functions: per-body transition ranges, regimes, gravity, rails, tidal-lock frames and chart <-> inertial conversions.
// Azeroth's numbers are the existing constants unchanged; nothing here is wired into the renderer yet.
import {PLANET_RADIUS,WORLD_CENTRE,MOONS} from './space.js';
import {smoothRange} from './math.js';
import {simEpoch} from './sim-clock.js';
import {BEND_RANGE,GLOBE_RANGE,SPACE_RANGE,ZONE_LIGHT_RANGE} from './terrain-transition.js';
import {SURFACE_GRAVITY,ATMOSPHERE_EDGE,gravityAt,densityAt,circularSpeed} from './planet-physics.js';
import {toPlanet,fromPlanet} from './planet-frame.js';

export const ELUNE_CIRCUMFERENCE=32000;
export const ELUNE_RADIUS=ELUNE_CIRCUMFERENCE/(2*Math.PI);
export const ELUNE_GRAVITY_SCALE=.25;
/** Elune's orbit takes 5 sim days (SimClock units: a day is 2880, see sim-clock DAY_PERIOD); 300 kyd out that is ~262 yd/s. */
export const ELUNE_ORBIT_DAYS=5;
export const ELUNE_ORBIT=300000;
const DAY_UNITS=2880;

const scaleRange=(range,k)=>Object.freeze(range.map(v=>Number((v*k).toFixed(3))));
const rangesFor=k=>Object.freeze({bend:scaleRange(BEND_RANGE,k),globe:scaleRange(GLOBE_RANGE,k),space:scaleRange(SPACE_RANGE,k),zone:scaleRange(ZONE_LIGHT_RANGE,k)});

export const AZEROTH=Object.freeze({
  id:'azeroth',radius:PLANET_RADIUS,centre:WORLD_CENTRE,gravity:SURFACE_GRAVITY,atmosphereEdge:ATMOSPHERE_EDGE,sea:true,
  circumference:2*Math.PI*PLANET_RADIUS,rangeScale:1,ranges:rangesFor(1),maxLevel:9,
});
// Transition ranges scale with sqrt(R) (design 1: linear would start bending below a pod's height).
const ELUNE_RANGE_SCALE=Math.sqrt(ELUNE_RADIUS/PLANET_RADIUS);
export const ELUNE_RAIL=Object.freeze({...MOONS[0],radius:ELUNE_RADIUS,orbit:ELUNE_ORBIT,turns:1/ELUNE_ORBIT_DAYS});
// A moon is a body with a circular rail about its parent; adding another is a config entry here plus a generator and site list.
export const ELUNE=Object.freeze({
  id:'elune',parent:'azeroth',orbitDays:ELUNE_ORBIT_DAYS,rail:ELUNE_RAIL,radius:ELUNE_RADIUS,centre:[0,0],gravity:SURFACE_GRAVITY*ELUNE_GRAVITY_SCALE,atmosphereEdge:0,sea:false,
  circumference:ELUNE_CIRCUMFERENCE,rangeScale:ELUNE_RANGE_SCALE,ranges:rangesFor(ELUNE_RANGE_SCALE),maxLevel:7,
});
export const BODIES=Object.freeze({azeroth:AZEROTH,elune:ELUNE});
export const bodyOf=id=>{const b=BODIES[id];if(!b)throw new RangeError('unknown body '+id);return b;};

export const muOf=body=>body.gravity*body.radius*body.radius;
/** Sphere of influence of Elune about Azeroth (patched conics): a*(mu_e/mu_a)^0.4. */
export const soiOf=body=>body.rail?body.rail.orbit*(muOf(body)/muOf(bodyOf(body.parent)))**.4:Infinity;
export const ELUNE_SOI=soiOf(ELUNE);
/** Multi-body world is the default in a page; ?bodies=0 (or off/false) opts out, and ?moonEngine=0 skips the resident extra engines. */
export const bodiesEnabled=(search,flag='bodies')=>{const v=new URLSearchParams(search).get(flag);return v===null||!['0','off','false'].includes(v);};
export const SOI_ENTER=.9,SOI_EXIT=1.1;

const smooth=smoothRange;
/** Regime tag for an altitude above a body's surface. */
export const regimeOf=(altitude,body=AZEROTH)=>altitude>=body.ranges.space[1]?'orbit':altitude>=body.ranges.bend[0]?'atmosphere':'ground';
/** Fade factors (bend, globe, space, zone) for an altitude above a body; same shape as terrain-transition planetFactors. */
export function planetFactorsFor(body,altitude,enabled=true) {
  if(!enabled||!(altitude>0))return {bend:0,globe:0,space:0,zone:1};
  const f=n=>Number(n.toFixed(6)),r=body.ranges;
  return {zone:f(1-smooth(r.zone,altitude)),bend:f(smooth(r.bend,altitude)),globe:f(smooth(r.globe,altitude)),space:body.atmosphereEdge?f(smooth(r.space,altitude)):1};
}
export const gravityFor=(body,altitude)=>gravityAt(altitude,body.radius,body.gravity);
export const densityFor=(body,altitude)=>densityAt(altitude,body.atmosphereEdge);
export const circularSpeedFor=(body,altitude)=>circularSpeed(altitude,body.radius,body.gravity);
/** Distance to the horizon from an eye height above a sphere. */
export const horizonDistance=(body,height)=>Math.sqrt(2*body.radius*Math.max(0,height)+height*height);

// Rails (analytic, circular). Elune reuses the existing moon rail shape with the physical period.

/** Inertial position (yd) of a body's centre at sim time t (SimClock units). Azeroth is the origin. */
/** Circular rail in the X-Z plane turning the same way as the sun (up toward east, east=+Z), so Elune's synodic day is regular (1.25 Azeroth days). Phase matches MOONS[0]. */
export const centreAt=(body,t)=>{
  if(!body.rail)return [0,0,0];
  const a=railAngle(body,t);
  return [body.rail.orbit*Math.sin(a),0,body.rail.orbit*Math.cos(a)];
};
/** Rail angle with the whole cycles removed in double precision first, so sin/cos stay exact at any sim time or timeScale. */
export const railAngle=(body,t)=>{
  const cycles=(t-720+simEpoch.days*DAY_UNITS)/(body.orbitDays*DAY_UNITS);
  return 2*Math.PI*(cycles-Math.floor(cycles))+body.rail.phase;
};
export const orbitSpeed=()=>2*Math.PI*ELUNE_ORBIT/(ELUNE_ORBIT_DAYS*DAY_UNITS/2);

const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
/** Body-local axes in inertial space as columns [x,y,z]. Azeroth: identity. Every rail body is tidally locked (spin period = orbital period): local +X (lon 0, lat 0) faces the parent and +Y is the orbit normal. Closed form, so the frame is exact and the parent stays at body-frame +X at any time. */
export function axesAt(body,t) {
  if(!body.rail)return [[1,0,0],[0,1,0],[0,0,1]];
  const a=railAngle(body,t),s=Math.sin(a),c=Math.cos(a);
  return [[-s,0,-c],[0,1,0],[c,0,-s]];
}
/** Parent direction in a tidally locked body's frame: constant (libration is not modelled). */
export const PARENT_DIRECTION=Object.freeze([1,0,0]);
const apply=(axes,v)=>[0,1,2].map(i=>axes[0][i]*v[0]+axes[1][i]*v[1]+axes[2][i]*v[2]);
const applyT=(axes,v)=>axes.map(a=>a[0]*v[0]+a[1]*v[1]+a[2]*v[2]);

/** Chart pose [x,y,z] on a body -> inertial position at time t. */
export function toInertial(body,pose,t) {
  const c=centreAt(body,t),v=apply(axesAt(body,t),toPlanet(pose,body.centre,body.radius));
  return [c[0]+v[0],c[1]+v[1],c[2]+v[2]];
}
/** Inertial position -> chart pose on a body (longitude unwrapped near `near`, a chart x). */
export function fromInertial(body,p,t,near=body.centre[0]) {
  const c=centreAt(body,t);
  return fromPlanet(applyT(axesAt(body,t),[p[0]-c[0],p[1]-c[1],p[2]-c[2]]),near,body.centre,body.radius);
}
/** Altitude of an inertial position above a body's mean surface. */
export const altitudeAbove=(body,p,t)=>{const c=centreAt(body,t);return Math.hypot(p[0]-c[0],p[1]-c[1],p[2]-c[2])-body.radius;};
/** Nearest-surface distance over all bodies, and which body it is. Feeds the fly speed law. */
export function nearestSurface(p,t) {
  let best;
  for(const b of Object.values(BODIES)){const d=altitudeAbove(b,p,t);if(!best||d<best.altitude)best={id:b.id,altitude:d};}
  return best;
}

/** Parent gravity well with hysteresis. `current` is 'azeroth'|'elune'; the swap is refused while a chart is active on the current parent (altitude below its space band). */
export function parentOf(p,t,current='azeroth') {
  const parent=bodyOf(current);
  if(altitudeAbove(parent,p,t)<parent.ranges.space[1])return current;
  const dist=b=>Math.hypot(...p.map((v,i)=>v-centreAt(b,t)[i]));
  if(parent.rail)return dist(parent)>SOI_EXIT*soiOf(parent)?parent.parent:current;
  let best=current,near=Infinity;
  for(const b of Object.values(BODIES)){if(b.parent!==current)continue;const d=dist(b);if(d<SOI_ENTER*soiOf(b)&&d<near){best=b.id;near=d;}}
  return best;
}
