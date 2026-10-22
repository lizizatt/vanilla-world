// Pure track height normalizer. Rule: every gate sits at max(ground, water) + CLEAR_DEFAULT, the same
// surface base the editor snap and clampTrack use. The start is only raised when it is below the surface.
// `sample(pos)` returns {ground, water} or undefined/non-finite when the tile is not loaded (never guessed).
import {surfaceBase,CLEAR_DEFAULT} from './track-edit.js';

const round=n=>Math.round(n*1000)/1000;

export function normalizeTrack(track,sample) {
  const out=JSON.parse(JSON.stringify(track)),report=[];
  const item=(label,p,rule)=>{
    const base=surfaceBase(sample(p)),old=p[1];
    if(!Number.isFinite(base)){report.push({label,old,status:'unloaded'});return;}
    const next=rule(base,old);
    report.push({label,old,new:next,base:round(base),delta:round(next-old),status:next===old?'same':'changed'});
    p[1]=next;
  };
  item('start',out.start.pos,(base,old)=>old<base?round(base):old);
  out.gates.forEach((g,i)=>item(`gate ${i+1}`,g.pos,base=>round(base+CLEAR_DEFAULT)));
  return {track:out,report,unresolved:report.filter(r=>r.status==='unloaded').map(r=>r.label)};
}

// Same layout as browser/tracks/steamwheedle.json: 2-space JSON, CRLF, trailing newline.
export const formatTrack=t=>JSON.stringify(t,null,2).replace(/\n/g,'\r\n')+'\r\n';
