// Read-only census of the Moonglade source tiles in the local WoW data (nothing is written): node moonglade-census.mjs "<Data folder>" [map=Kalimdor] [areaId=493]
// Prints the tiles with MCNK chunks in the area and their chunk counts. Result feeds browser\elune-sites.js (tile list only, no game data).
import {openAsBlob,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {openDataSource} from './asset-source.js';
import {adtChunks,mcnkAreas} from './graft-adt.js';

const [,,folder,map='Kalimdor',area='493']=process.argv;
if(!folder)throw new Error('usage: node moonglade-census.mjs <Data folder> [map] [areaId]');
const catalog=[];
for(const name of readdirSync(folder))if(/\.mpq$/i.test(name))catalog.push({path:name,file:await openAsBlob(join(folder,name))});
const source=await openDataSource(catalog);
const wdt=await source.read(`World\\Maps\\${map}\\${map}.wdt`),found=[];
let main;for(const c of adtChunks(wdt))if(c.magic==='MAIN')main=c;
const view=new DataView(wdt.buffer,wdt.byteOffset+main.start,main.size);
for(let i=0;i<4096;i++) {
  if(!(view.getUint32(i*8,true)&1))continue;
  const x=i%64,y=i>>6;
  let bytes;try{bytes=await source.read(`World\\Maps\\${map}\\${map}_${x}_${y}.adt`);}catch{continue;}
  const n=mcnkAreas(bytes).filter(a=>a===+area).length;
  if(n)found.push({x,y,chunks:n});
}
console.log(JSON.stringify(found));
await source.close();
