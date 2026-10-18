// Compare compiled admissions against a saved baseline; private assets stay in memory.
import assert from 'node:assert/strict';
import {openAsBlob} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDataSource} from './asset-source.js';

assert(process.env.WOW_DATA&&process.argv[2],'Set WOW_DATA and pass the baseline pkg directory');
assert.notEqual(resolve(process.argv[2]),resolve('browser','pkg'),'Baseline must be a separately saved build');
globalThis.crypto ||= webcrypto;
const modules=[];
for(const directory of [resolve(process.argv[2]),resolve('browser','pkg')]){
  const module=await import(pathToFileURL(join(directory,'flats_racer_web.js')));
  module.initSync({module:await readFile(join(directory,'flats_racer_web_bg.wasm'))});
  modules.push(module);
}
const catalog=[];
for(const entry of await readdir(process.env.WOW_DATA,{withFileTypes:true})){
  if(entry.isFile()&&/\.mpq$/i.test(entry.name))
    catalog.push({path:entry.name,file:await openAsBlob(join(process.env.WOW_DATA,entry.name))});
}
const source=await openDataSource(catalog),worlds=[];
const digest=value=>createHash('sha256').update(typeof value==='string'?value:
  Buffer.from(value.buffer,value.byteOffset,value.byteLength)).digest('hex');
const distribution=values=>{
  const sorted=values.toSorted((a,b)=>a-b);
  return {count:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],
    p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)};
};
try{
  const headers=[];
  for(const map of ['Kalimdor','Azeroth'])for(const extension of ['wdt','wdl'])
    headers.push(await source.read(`World\\Maps\\${map}\\${map}.${extension}`));
  const manifestJSON=modules[0].world_manifest(...headers),manifest=JSON.parse(manifestJSON);
  assert.equal(modules[1].world_manifest(...headers),manifestJSON);
  for(const module of modules){
    const world=new module.Voyage(manifestJSON);world.set_admission_profiling(true);worlds.push(world);
  }
  // Include the costly admissions from the retained terrestrial trace and both continents.
  const indices=[[0,35,34],[0,36,34],[0,34,35],[0,35,35],[0,36,35],[0,35,36],[0,36,36],[1,31,48]]
    .map(([region,x,y])=>manifest.tiles.findIndex(t=>t.region===region&&t.x===x&&t.y===y));
  assert(indices.every(index=>index>=0),'Expected source tiles are absent');
  const samples=[[],[]],parity=[];
  for(const index of indices){
    const entry=manifest.tiles[index],map=manifest.regions[entry.region].map;
    const bytes=await source.read(`World\\Maps\\${map}\\${entry.file}`);
    let reference;
    for(let round=0;round<4;round++)for(const side of round%2?[1,0]:[0,1]){
      const world=worlds[side],start=performance.now();
      world.add_tile(index,bytes);
      const elapsed=performance.now()-start,stages=Array.from(world.admission_timings());
      samples[side].push({index,round,elapsed,materials:stages[2]});
      if(round===0){
        const material=world.terrain_material(index);
        try{
          const actual={geometry:digest(world.geometry(index)),placements:digest(world.tile_placements(index,bytes)),
            vertices:digest(material.vertices()),indices:digest(material.indices()),masks:digest(material.masks()),
            paths:digest(material.paths())};
          if(side===0)reference=actual;else assert.deepEqual(actual,reference,`${entry.file}: authored streams changed`);
        }finally{material.free();}
      }
      world.remove_tile(index);
    }
    parity.push({index,file:entry.file,...reference});
  }
  console.log(JSON.stringify({parity,samples,summary:samples.map(rows=>({
    admissionMs:distribution(rows.map(r=>r.elapsed)),materialMs:distribution(rows.map(r=>r.materials)),
    warmAdmissionMs:distribution(rows.filter(r=>r.round>0).map(r=>r.elapsed)),
    warmMaterialMs:distribution(rows.filter(r=>r.round>0).map(r=>r.materials)),
  }))},null,2));
}finally{
  for(const world of worlds)world.free();
  source.close();
}
