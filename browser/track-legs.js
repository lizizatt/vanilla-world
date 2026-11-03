// Pure cross-body track structure and authoring checks. No DOM. A track starts on trackBody; each gate stands on its own body
// (gate.body, default the track's body) in that body's own frame. A "leg" is a run of consecutive gates on one body and a
// "jump" is the change of body between two legs. The start counts as part of leg 0 (so leg 0 has no gates when gate 1 is elsewhere).
import {trackBody,gateBody,spansBodies} from './race.js';
import {BODIES} from './bodies.js';
import {surfaceBase} from './track-edit.js';

export const MIN_GATE_GAP=10; // yd between consecutive gates on one body: closer is an authoring mistake
export const WARN_GATE_GAP=30; // yd: closer still works but the swept crossing test may credit both in one step
export const GROUND_SLACK=1;   // yd a gate may sit below the sampled surface before it counts as inside terrain

export const bodyLabel=b=>b?b[0].toUpperCase()+b.slice(1):'?';
export const gateBodies=t=>t.gates.map(g=>gateBody(t,g));

// [{body,first,last,count}] in track order; first..last are gate indices (first>last = the start leg with no gates).
export function legs(t) {
  const out=[{body:trackBody(t),first:0,last:-1,count:0}];
  t.gates.forEach((g,i)=>{
    const b=gateBody(t,g),leg=out.at(-1);
    if(b===leg.body){if(!leg.count)leg.first=i;leg.last=i;leg.count++;}
    else out.push({body:b,first:i,last:i,count:1});
  });
  return out;
}

// Body changes between consecutive gates: [{at,from,to}] where `at` is the index of the first gate after the jump.
export function transitions(t) {
  const out=[];let prev=trackBody(t);
  t.gates.forEach((g,i)=>{const b=gateBody(t,g);if(b!==prev)out.push({at:i,from:prev,to:b});prev=b;});
  return out;
}

// Indices of the gates standing on `body`.
export const gatesOn=(t,body)=>t.gates.flatMap((g,i)=>gateBody(t,g)===body?[i]:[]);

const d3=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);

/**
 * Authoring checks for a validated track. `surfaces[i]` is the {ground,water} sample for [start,...gates][i] when it could be
 * probed (only points on the active body can be); unknown samples are skipped. Returns {errors,warnings} of readable strings.
 * Errors block save/export/test; warnings do not.
 */
export function checkTrack(t,surfaces=[]) {
  const errors=[],warnings=[],n=t.gates.length;
  if(!n)return {errors:['Add at least one gate.'],warnings};
  const known=b=>Object.hasOwn(BODIES,b);
  if(!known(trackBody(t)))errors.push(`Unknown start body "${trackBody(t)}".`);
  t.gates.forEach((g,i)=>{if(!known(gateBody(t,g)))errors.push(`Gate ${i+1} is on unknown body "${gateBody(t,g)}".`);});
  const cross=spansBodies(t);
  if(cross&&t.mode==='lap')errors.push('A track that jumps between bodies must be point to point, not a lap.');
  if(cross){
    legs(t).forEach((l,k)=>{if(!l.count)errors.push(`Leg ${k+1} (${bodyLabel(l.body)}) has no gates: place at least one gate after the start before jumping.`);});
  }
  // Spacing between consecutive gates in the same frame (the start counts for gate 1 when it is on the same body).
  const prevPos=(i)=>i===0?(gateBody(t,t.gates[0])===trackBody(t)?t.start.pos:undefined):(gateBody(t,t.gates[i-1])===gateBody(t,t.gates[i])?t.gates[i-1].pos:undefined);
  t.gates.forEach((g,i)=>{
    const p=prevPos(i);if(!p)return;
    const gap=d3(p,g.pos),what=i===0?'the start':`gate ${i}`;
    if(gap<MIN_GATE_GAP)errors.push(`Gate ${i+1} is only ${gap.toFixed(1)} yd from ${what}; keep gates at least ${MIN_GATE_GAP} yd apart.`);
    else if(gap<WARN_GATE_GAP&&i>0)warnings.push(`Gate ${i+1} is close to gate ${i} (${gap.toFixed(0)} yd).`);
  });
  // Gates below the sampled terrain/planet surface.
  t.gates.forEach((g,i)=>{
    const base=surfaceBase(surfaces[i+1]);
    if(Number.isFinite(base)&&g.pos[1]<base-GROUND_SLACK)errors.push(`Gate ${i+1} is ${(base-g.pos[1]).toFixed(0)} yd inside the ground on ${bodyLabel(gateBody(t,g))}; raise it.`);
  });
  const sb=surfaceBase(surfaces[0]);
  if(Number.isFinite(sb)&&t.start.pos[1]<sb-GROUND_SLACK)errors.push('The start is inside the ground; raise it.');
  return {errors,warnings};
}
