import {openAsBlob,readFileSync} from 'node:fs';
import {readdir,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDataSource} from './asset-source.js';
import {npcClass} from './wander.js';
import {CREATURE_COLLISION} from './creature-collision.js';
import {decodeTrimmed} from './npc-pack.js';
import {modelPath} from './scene-stream.js';
import {reasonFor,summarize,deathClip} from './creature-survey.js';

// On-demand, read-only real WoW data: survey every creature display in the public NPC pack for a usable Death clip and, per display, why a
// podracer hit would not make it react. Run: $env:WOW_DATA='...\Data'; node creature-death-survey.mjs [--json out.json]
// Needs browser\pkg (prebuilt wasm, never committed). Prints a report; writes test-results/creature-survey/survey.json.
const dir=process.env.WOW_DATA;
if(!dir){console.error('Set WOW_DATA to the read-only local Data directory');process.exit(2);}
const here=new URL('./',import.meta.url);
const wasm=await import('./pkg/flats_racer_web.js');
wasm.initSync({module:readFileSync(fileURLToPath(new URL('./pkg/flats_racer_web_bg.wasm',here)))});
const catalog=[];
for(const f of await readdir(dir,{withFileTypes:true}))if(f.isFile()&&/\.mpq$/i.test(f.name))catalog.push({path:f.name,file:await openAsBlob(join(dir,f.name))});
const source=await openDataSource(catalog);
const dbc=n=>source.read(`DBFilesClient\\${n}.dbc`);
const pack=decodeTrimmed(JSON.parse(readFileSync(fileURLToPath(new URL('./npc-pack.public.json',here)),'utf8')));
const ids=[...new Set(pack.spawns.map(s=>s.displayId))];
const [models,displays,extra]=await Promise.all([dbc('CreatureModelData'),dbc('CreatureDisplayInfo'),dbc('CreatureDisplayInfoExtra').catch(()=>new Uint8Array())]);
const map=JSON.parse(wasm.scene_resolve_displays(models,displays,extra,Uint32Array.from(ids)));
const spawnsBy=new Map();
for(const s of pack.spawns){const a=spawnsBy.get(s.displayId)??[];a.push(s);spawnsBy.set(s.displayId,a);}

const perPath=new Map();
async function inspect(entry){
  const key=entry.path; // skins/geosets only change textures and humanoid parts, not the sequence table or creature bounds
  if(perPath.has(key))return perPath.get(key);
  const out={path:entry.path};
  try{
    const bytes=await source.read(entry.path);
    out.clips=deathClip(bytes);
    const skins=JSON.stringify(entry.skins||[]),geosets=entry.geosets&&JSON.stringify(entry.geosets);
    const m=wasm.SceneModel.m2(bytes,entry.path,skins,geosets);out.bounds=JSON.parse(m.metadata()).bounds;m.free?.();
    try{const a=wasm.SceneActor.create(bytes,entry.path,skins,geosets);out.rigStand=a.duration(0);out.rigDeath=a.duration(1);a.free();}
    catch(e){out.rigError=String(e?.message??e).slice(0,120);}
  }catch(e){out.error=String(e?.message??e).slice(0,120);}
  perPath.set(key,out);return out;
}

const rows=[];
for(const id of ids){
  const entry=map[id],spawns=spawnsBy.get(id)??[];if(!entry)continue;
  const info=await inspect({...entry,path:modelPath(entry.path)});
  const scales=spawns.map(s=>s.scale||1);
  rows.push({displayId:id,path:modelPath(entry.path),spawns:spawns.length,cls:npcClass(entry.path)??'none',...info,scaleMin:Math.min(...scales),scaleMax:Math.max(...scales),
    reason:reasonFor(info,npcClass(entry.path),scales,CREATURE_COLLISION)});
}
const report=summarize(rows);
console.log(JSON.stringify(report.totals,null,1));
for(const r of report.byReason)console.log(`${String(r.reason).padEnd(14)} displays=${String(r.displays).padStart(5)} models=${String(r.models).padStart(4)} spawns=${String(r.spawns).padStart(6)}  e.g. ${r.examples.join(', ')}`);
const focus=rows.filter(r=>/basilisk/i.test(r.path));
console.log('basilisk displays:',JSON.stringify(focus.map(r=>({displayId:r.displayId,path:r.path,spawns:r.spawns,reason:r.reason,death:r.clips?.death?.ms,bounds:r.bounds,scale:[r.scaleMin,r.scaleMax]})),null,1));
const out=new URL('./test-results/creature-survey/',here);await mkdir(out,{recursive:true});
await writeFile(new URL('survey.json',out),JSON.stringify({report,rows},null,1));
await source.close();

