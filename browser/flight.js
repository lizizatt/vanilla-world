function worldBounds(manifest) {
  return manifest.horizons.map(h => {
    const r=manifest.regions[h.region],s=1600/3;
    return [r.placement[0]+(h.source_bounds[0]-r.tile_origin[0])*s,
      r.placement[1]+(h.source_bounds[1]-r.tile_origin[1])*s,
      r.placement[0]+(h.source_bounds[2]-r.tile_origin[0])*s,
      r.placement[1]+(h.source_bounds[3]-r.tile_origin[1])*s];
  });
}
export function overview(manifest) {
  const bounds=worldBounds(manifest);
  const x0=Math.min(...bounds.map(b=>b[0])),z0=Math.min(...bounds.map(b=>b[1]));
  const x1=Math.max(...bounds.map(b=>b[2])),z1=Math.max(...bounds.map(b=>b[3]));
  const size=Math.max(x1-x0,z1-z0);
  return [(x0+x1)/2,size*.75,(z0+z1)/2+size*.34,0,-1.15];
}
// Above ~1.5 kyd the speed grows with altitude (capped at 60x) so the planet-scale climb to space takes seconds; ground flight is unchanged.
export const FLIGHT_CEILING=1000000;
export const flightBoost=altitude=>Math.min(60,Math.max(1,altitude/1500));
export function moveFlight(pose,keys,dt) {
  const p=pose.slice(),down=k=>Number(keys.has(k));
  p[3]+=(down('ArrowLeft')-down('ArrowRight'))*dt;
  p[4]=Math.max(-1.55,Math.min(1.55,p[4]+(down('ArrowUp')-down('ArrowDown'))*dt));
  const speed=(keys.has('ShiftLeft') || keys.has('ShiftRight') ? 8000 : 1200)*dt*flightBoost(p[1]);
  const f=down('KeyW')-down('KeyS'),s=down('KeyD')-down('KeyA');
  p[0]+=(-Math.sin(p[3])*Math.cos(p[4])*f+Math.cos(p[3])*s)*speed;
  p[2]+=(-Math.cos(p[3])*Math.cos(p[4])*f-Math.sin(p[3])*s)*speed;
  p[1]=Math.max(-10000,Math.min(FLIGHT_CEILING,p[1]+(Math.sin(p[4])*f+down('KeyE')-down('KeyQ'))*speed));
  return p;
}
