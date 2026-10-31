// Shared route definitions for the streaming stress harness (browser and CPU-only variants).
// Flat coordinates: x east, z south, yd. Globe circumference is 2*pi*PLANET_RADIUS ~ 89.6 kyd; Kalimdor x[-21867,5333] z[-12267,17600], Eastern Kingdoms x[13525,24725] z[-5333,17067].
import {PLANET_RADIUS,WORLD_CENTRE} from './space.js';
export const CIRCUMFERENCE=2*Math.PI*PLANET_RADIUS;
const [CX]=WORLD_CENTRE;
export const ROUTES={
  // Start on Kalimdor, climb out to sea heading west along an ocean-only latitude, go a full lap (crossing the date-line wrap), then keep going west to a hop and land on the Eastern Kingdoms east coast.
  default:[
    {from:[-14000,-9000],to:[-30000,-9000]},
    {from:'prev',to:[-30000-CIRCUMFERENCE,-9000]},
    {hop:true,to:[CX+CIRCUMFERENCE/2-3000,-8000]},
    {from:'prev',to:[24000,4000],stop:true},
  ],
  // Control: no flight at all, just teleport to the stop pose; defines what a healthy load looks like.
  control:[{hop:true,to:[24000,4000]},{from:[24000,4000],to:[24000,4000],stop:true}],
  // Several laps at a latitude with no land, then the coast stop.
  long:[
    {from:[-14000,-9000],to:[-30000,-9000]},
    ...Array.from({length:6},(_,i)=>({from:'prev',to:[-30000-CIRCUMFERENCE*(i+1),-9000]})),
    {hop:true,to:[CX+CIRCUMFERENCE/2-3000,-8000]},
    {from:'prev',to:[24000,4000],stop:true},
  ],
  quick:[
    {from:[-24000,-9000],to:[-24000-CIRCUMFERENCE*.6,-9000]},
    {from:'prev',to:[24000,4000],stop:true},
  ],
};
export function routeLegs(name,{speed=8000,alt=300}={}) {
  let prev;
  return ROUTES[name].map(l=>{
    const from=l.from==='prev'?prev:(l.from??l.to);
    const leg={...l,from,speed,alt};
    prev=l.to;
    return leg;
  });
}


