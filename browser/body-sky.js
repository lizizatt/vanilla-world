// Bodies as seen from another body (design/elune.md step D3): real positions from the shared sim clock, in the viewing body's planet frame,
// ready for spaceUniform's moon slots. Elune from Azeroth replaces the stylised moon; Azeroth from Elune is the other large disc.
import {BODIES,AZEROTH,ELUNE,centreAt,axesAt} from './bodies.js';
import {MOONS,moonPlanetPosition,planetFrame} from './space.js';
import {dirLatLon,flatOf,frameAtLatLon,clampLat} from './equirect.js';
import {sunInertial} from './sky-coupling.js';

/** Each body's disc uses its own config: atmospheric bodies (Azeroth) are drawn with sea/land/cloud/limb shading, airless ones as regolith. */
export const atmosphericDisc=body=>body.atmosphereEdge>0;
const TINT={azeroth:[.45,.62,1],elune:[.9,.93,1]};

/** Planet-frame position of `other`'s centre relative to `body`'s centre. */
export function relativeCentre(body,other,t) {
  const a=centreAt(other,t),b=centreAt(body,t),ax=axesAt(body,t),v=[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  return ax.map(col=>col[0]*v[0]+col[1]*v[1]+col[2]*v[2]);
}

/** `body` option for spaceUniform: viewing body plus the moon slots (other body real-size, then Azeroth's second stylised moon when viewed from Azeroth). */
export function viewFrom(body,t) {
  const other=body.id==='elune'?AZEROTH:ELUNE;
  const moons=[{other:other.id,position:relativeCentre(body,other,t),radius:other.radius,tint:TINT[other.id],axisY:other.id==='elune'?axesAt(other,t)[1]:undefined,axes:atmosphericDisc(other)?axesAt(other,t).map(a=>axesAt(body,t).map(col=>col[0]*a[0]+col[1]*a[1]+col[2]*a[2])):undefined}];
  if(body.id==='azeroth')moons.push({...MOONS[1],position:moonPlanetPosition(MOONS[1],t)});
  return {radius:body.radius,centre:body.centre,moons,sun:body.id==='azeroth'?sunInertial(t):undefined};
}
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const mulAxes=(axes,v)=>[0,1,2].map(i=>axes[0][i]*v[0]+axes[1][i]*v[1]+axes[2][i]*v[2]);
const mulAxesT=(axes,v)=>axes.map(a=>dot3(a,v));

/** The camera of `active` (chart eye + eye-local look/right/up) re-expressed as a camera hovering over `other`, so the other body's own far renderer can be drawn with its own shaders in the shared space.
 * Returns the chart-eye view over `other`, its altitude, the true sun in that eye frame, and `toOther` (an active-eye-local vector -> other-eye-local). Null if the camera is inside `other`. */
export function otherView(view,active,other,t) {
  const [x,alt,z]=view.eye,fa=planetFrame(x,z,active.centre,active.radius),axA=axesAt(active,t),axB=axesAt(other,t);
  const local=[fa.east,fa.up,fa.south],toPlanetA=v=>[0,1,2].map(i=>local[0][i]*v[0]+local[1][i]*v[1]+local[2][i]*v[2]);
  const ca=centreAt(active,t),cb=centreAt(other,t),r=active.radius+Math.max(0,alt);
  const eye=mulAxes(axA,fa.up.map(v=>v*r)).map((v,i)=>v+ca[i]-cb[i]),cB=mulAxesT(axB,eye),dist=Math.hypot(...cB),altitude=dist-other.radius;
  if(!(altitude>0))return null;
  const {lat,lon}=dirLatLon(cB.map(v=>v/dist)),[ex,ez]=flatOf(lat,lon,other.centre,other.radius),fb=frameAtLatLon(clampLat(lat),lon),localB=[fb.east,fb.up,fb.south];
  const toOther=v=>{const p=mulAxesT(axB,mulAxes(axA,toPlanetA(v)));return localB.map(a=>dot3(a,p));};
  const sunB=mulAxesT(axB,sunInertial(t)),sun=localB.map(a=>dot3(a,sunB));
  return {view:{eye:[ex,altitude,ez],look:toOther(view.look),right:toOther(view.right),up:toOther(view.up),aspect:view.aspect},altitude,sun,toOther};
}
export {BODIES};
