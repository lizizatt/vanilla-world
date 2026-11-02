// Pure helpers for the creature death survey (creature-death-survey.mjs): read an M2's Death sequences and classify why a hit would not make a
// creature react. Mirrors the runtime gates in creature-collision.js / actors.js so the survey and the game cannot drift.
const u16=(b,o)=>b[o]|b[o+1]<<8,u32=(b,o)=>(b[o]|b[o+1]<<8|b[o+2]<<16|b[o+3]<<24)>>>0;
export const ANIM_STAND=0,ANIM_DEATH=1;

/** Stand and Death sequences of an M2 (header 0x1c/0x20, stride 0x44: animId u16, subId u16, start u32, end u32 ms). */
export function deathClip(bytes){
  const out={stand:undefined,death:undefined,deathVariants:0,sequences:0};
  if(bytes.length<0x40||String.fromCharCode(bytes[0],bytes[1],bytes[2],bytes[3])!=='MD20')return out;
  const count=u32(bytes,0x1c),ofs=u32(bytes,0x20);out.sequences=count;
  for(let s=0;s<count&&ofs+(s+1)*0x44<=bytes.length;s++){
    const r=ofs+s*0x44,id=u16(bytes,r),ms=u32(bytes,r+8)-u32(bytes,r+4);
    if(!(ms>0))continue;
    if(id===ANIM_STAND&&!out.stand)out.stand={ms,seq:s};
    if(id===ANIM_DEATH){out.deathVariants++;if(!out.death)out.death={ms,seq:s};}
  }
  return out;
}

/**
 * Why a hit on this display would not react (undefined = reacts when hit, for every spawn scale).
 * `classes`: path is not creature\/character\ (no class); `no-death`: no Death sequence; `too-big`: cylinder over the size gate at the
 * smallest spawn scale; `size-varies`: only some scales are small enough; `no-model`: unreadable/undecodable model.
 */
export function reasonFor(info,cls,scales,cfg){
  if(info.error||!info.bounds)return 'no-model';
  if(!cls||!cfg.classes.includes(cls))return 'no-class';
  if(!(info.clips?.death?.ms>0))return 'no-death';
  const [lo,hi]=info.bounds,foot=Math.sqrt((hi[0]-lo[0])*(hi[1]-lo[1])*.25),h=hi[2]-lo[2];
  const fits=k=>foot*k<=cfg.maxCreatureRadius&&h*k<=cfg.maxCreatureHeight;
  const some=scales.some(fits),all=scales.every(fits);
  if(!some)return 'too-big';
  return all?undefined:'size-varies';
}

export function summarize(rows){
  const total={displays:rows.length,spawns:0,models:new Set(),withDeath:0,withDeathSpawns:0,reacts:0,reactsSpawns:0};
  const by=new Map();
  for(const r of rows){
    total.spawns+=r.spawns;total.models.add(r.path);
    if(r.clips?.death?.ms>0){total.withDeath++;total.withDeathSpawns+=r.spawns;}
    const key=r.reason??'reacts';
    if(!r.reason){total.reacts++;total.reactsSpawns+=r.spawns;}
    const e=by.get(key)??{reason:key,displays:0,spawns:0,models:new Set(),examples:[]};
    e.displays++;e.spawns+=r.spawns;e.models.add(r.path);
    if(e.examples.length<4&&!e.examples.includes(r.path.split(/[\\/]/).pop()))e.examples.push(r.path.split(/[\\/]/).pop());
    by.set(key,e);
  }
  return {totals:{...total,models:total.models.size},byReason:[...by.values()].map(e=>({...e,models:e.models.size})).sort((a,b)=>b.spawns-a.spawns)};
}
