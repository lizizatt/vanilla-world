// Bodies as seen from another body (design/elune.md step D3): real positions from the shared sim clock, in the viewing body's planet frame,
// ready for spaceUniform's moon slots. Elune from Azeroth replaces the stylised moon; Azeroth from Elune is the other large disc.
import {BODIES,AZEROTH,ELUNE,centreAt,axesAt} from './bodies.js';
import {MOONS,moonPlanetPosition} from './space.js';

const TINT={azeroth:[.45,.62,1],elune:[.9,.93,1]};

/** Planet-frame position of `other`'s centre relative to `body`'s centre. */
export function relativeCentre(body,other,t) {
  const a=centreAt(other,t),b=centreAt(body,t),ax=axesAt(body,t),v=[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  return ax.map(col=>col[0]*v[0]+col[1]*v[1]+col[2]*v[2]);
}

/** `body` option for spaceUniform: viewing body plus the moon slots (other body real-size, then Azeroth's second stylised moon when viewed from Azeroth). */
export function viewFrom(body,t) {
  const other=body.id==='elune'?AZEROTH:ELUNE;
  const moons=[{position:relativeCentre(body,other,t),radius:other.radius,tint:TINT[other.id],axisY:other.id==='elune'?axesAt(other,t)[1]:undefined}];
  if(body.id==='azeroth')moons.push({...MOONS[1],position:moonPlanetPosition(MOONS[1],t)});
  return {radius:body.radius,centre:body.centre,moons};
}
export {BODIES};
