// The one equirectangular chart <-> sphere mapping (JS side): flat (x, z) is lon = (x-cx)/R, lat = (cz-z)/R, so a radial descent lands on the same (x, z).
// Pure and body-agnostic: every function takes the chart centre and radius (space.js binds the Azeroth defaults).
// The WGSL copies (bend, surface, lights, cloud worldAt) must keep matching these; unify.test.mjs and the shader mirrors guard it.
export const LAT_MAX=Math.PI/2-1e-4;
export const clampLat=lat=>Math.max(-LAT_MAX,Math.min(LAT_MAX,lat));
/** Flat render (x, z) -> {lat, lon} (radians, unclamped). */
export const latLonOf=(x,z,centre,radius)=>({lat:-(z-centre[1])/radius,lon:(x-centre[0])/radius});
/** {lat, lon} -> flat [x, z]. */
export const flatOf=(lat,lon,centre,radius)=>[centre[0]+radius*lon,centre[1]-radius*lat];
/** Unit planet-frame direction (X toward lon 0 / lat 0, Y north, Z toward lon +90deg) -> {lat, lon}. */
export const dirLatLon=v=>({lat:Math.asin(Math.max(-1,Math.min(1,v[1]))),lon:Math.atan2(v[2],v[0])});
/** Local frame at (lat, lon): columns east, up, south as planet-frame unit vectors. */
export function frameAtLatLon(lat,lon) {
  const [sl,cl,sp,cp]=[Math.sin(lon),Math.cos(lon),Math.sin(lat),Math.cos(lat)];
  return {east:[-sl,0,cl],up:[cp*cl,sp,cp*sl],south:[sp*cl,-cp,sp*sl]};
}
