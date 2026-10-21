// Plane flight model: pure, deterministic, no DOM and no world access (ground height is passed in).
// Units: yards and seconds, same as the podracer. Yaw 0 faces world -Z (see craftMatrix); pitch up is positive;
// roll right is positive. Boost numbers deliberately mirror the podracer defaults in
// client/crates/flats-racer-web/src/voyage.rs (150 / 1000 yd/s, 50 / 250 yd/s^2); keep them in step by hand.
// shortcut: JS-only, not in Rust, so the plane has no wasm collision sweep (terrain/water height only); move it
// into flats-racer-physics if scenery collision or server-grade determinism is wanted.
export const PLANE=Object.freeze({
  cruise:150, boostSpeed:1000, thrust:50, boostThrust:250, drag:.35, brake:60,
  stall:45, maxRoll:1.05, rollRate:2.6, maxPitch:.95, pitchRate:1.1, gravity:30,
  clearance:3, boostDrain:.25, boostRegen:.1,
});

export const newPlane=(pos,yaw=0)=>({pos:[...pos],yaw,pitch:0,roll:0,speed:PLANE.cruise*.6,sink:0,boost:1});
export const forward=p=>{const c=Math.cos(p.pitch);return [-Math.sin(p.yaw)*c,Math.sin(p.pitch),-Math.cos(p.yaw)*c];};
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));

// input: {throttle:-1..1, steer:-1..1 (bank), pitch:-1..1 (+ = nose up), boost:boolean}. ground: surface height or NaN.
// Mutates and returns the plane plus `contact` ('ground' when scraping the surface, else '').
export function stepPlane(p,input,dt,ground=NaN,c=PLANE) {
  const boosting=!!input.boost&&p.boost>0&&input.throttle>=0;
  p.boost=clamp(p.boost+(boosting?-c.boostDrain:c.boostRegen)*dt,0,1);
  p.roll+=clamp(input.steer*c.maxRoll-p.roll,-c.rollRate*dt,c.rollRate*dt);
  const flying=Math.min(1,(p.speed/c.stall)**2);
  p.pitch=clamp(p.pitch+(input.pitch*c.pitchRate-(1-flying)*.8)*dt,-c.maxPitch,c.maxPitch);
  // Coordinated turn: heading rate from bank, weaker at high speed so 1000 yd/s boost stays controllable.
  p.yaw-=Math.tan(p.roll)*c.gravity/Math.max(p.speed,c.stall)*dt*flying;
  const limit=boosting?c.boostSpeed:c.cruise,thrust=boosting?c.boostThrust:c.thrust*Math.max(input.throttle,0);
  p.speed+=((p.speed<limit?thrust:0)-(input.throttle<0?c.brake:0)-Math.sin(p.pitch)*c.gravity-c.drag*Math.max(p.speed-limit,0)-c.drag*.1*p.speed)*dt;
  p.speed=clamp(p.speed,0,c.boostSpeed);
  p.sink=(p.sink+(1-flying)*c.gravity*dt)*Math.exp(-4*flying*dt);
  const f=forward(p);
  for(let i=0;i<3;i++)p.pos[i]+=f[i]*p.speed*dt;
  p.pos[1]-=p.sink*dt;
  let contact='';
  if(Number.isFinite(ground)&&p.pos[1]<ground+c.clearance) {
    p.pos[1]=ground+c.clearance;p.pitch=Math.max(p.pitch,0);p.sink=0;
    p.speed=Math.max(0,p.speed-c.brake*dt);contact='ground';
  }
  p.contact=contact;return p;
}
