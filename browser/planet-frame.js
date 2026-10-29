// Planet-centred frame (M2). Position = f64 vector from Azeroth's centre; the flat world pose (x, y up, z) is the sub-point
// (lon, lat) plus radial altitude, so old saves/poses need no migration: flat -> planet -> flat is the identity.
import {PLANET_RADIUS,WORLD_CENTRE,subPoint,globeToFlat,planetFrame} from './space.js';
import {unwrapNear} from './math.js';
import {dirLatLon} from './equirect.js';
import {rotate} from './frames.js';

const unrotate=(q,v)=>[q[0][0]*v[0]+q[1][0]*v[1]+q[2][0]*v[2],q[0][1]*v[0]+q[1][1]*v[1]+q[2][1]*v[2],q[0][2]*v[0]+q[1][2]*v[1]+q[2][2]*v[2]];
// Sea level sits on the sphere: planet radius is measured to altitude 0.
/** Flat pose [x,y,z] -> planet-centred [X,Y,Z] (X toward lon 0 / lat 0, Y north, Z toward lon +90deg). */
export function toPlanet(pose,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  const {lat,lon}=subPoint(pose[0],pose[2],centre,radius),r=radius+pose[1],c=Math.cos(lat);
  const v=[r*c*Math.cos(lon),r*Math.sin(lat),r*c*Math.sin(lon)];
  return centre.q?rotate(centre.q,v):v;
}
/** Planet-centred vector -> flat pose [x,y,z]; longitude is unwrapped near `near` (a flat x) so continuous flight does not jump a full turn. */
export function fromPlanet(v,near=WORLD_CENTRE[0],centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  const r=Math.hypot(v[0],v[1],v[2]),u=[v[0]/r,v[1]/r,v[2]/r],{lat,lon}=dirLatLon(centre.q?unrotate(centre.q,u):u);
  const turn=2*Math.PI*radius,[x,z]=globeToFlat(lat,lon,centre,radius);
  return [unwrapNear(x,near,turn),r-radius,z];
}
/** Local frame (east, up, south) as planet-centred unit vectors at a flat pose. */
export function localAxes(pose,centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  return planetFrame(pose[0],pose[2],centre,radius);
}
/** Floating origin: camera-relative offset (f32-safe) of a point from an eye, both planet-centred f64. */
export function relative(point,eye) {
  return [point[0]-eye[0],point[1]-eye[1],point[2]-eye[2]];
}
