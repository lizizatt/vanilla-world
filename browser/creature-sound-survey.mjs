import {openAsBlob,readFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDataSource} from './asset-source.js';
import {decodeTrimmed} from './npc-pack.js';
import {CreatureSounds,CREATURE_SOUND} from './creature-sound.js';

// On-demand, read-only real WoW data: for every creature display in the public NPC pack, resolve its death sound and report the container
// format (WAV format tag / channels / rate / bits, or mp3) and whether the file is within the size cap. Nothing is written.
// Run: $env:WOW_DATA='...\Data'; node creature-sound-survey.mjs
const dir=process.env.WOW_DATA;
if(!dir){console.error('Set WOW_DATA to the read-only local Data directory');process.exit(2);}
const catalog=[];
for(const f of await readdir(dir,{withFileTypes:true}))if(f.isFile()&&/\.mpq$/i.test(f.name))catalog.push({path:f.name,file:await openAsBlob(join(dir,f.name))});
const source=await openDataSource(catalog),sounds=new CreatureSounds(source);
await sounds.load();
const pack=decodeTrimmed(JSON.parse(readFileSync(fileURLToPath(new URL('./npc-pack.public.json',import.meta.url)),'utf8')));
const ids=[...new Set(pack.spawns.map(s=>s.displayId))],byPath=new Map();let withSound=0;
for(const id of ids){const paths=sounds.catalog.deathPaths(id);if(paths.length)withSound++;for(const p of paths)byPath.set(p,(byPath.get(p)||0)+1);}
const formats=new Map(),bad=[];
export const waveFormat=b=>{
  if(b.length>=3&&b[0]===0x49&&b[1]===0x44&&b[2]===0x33||b[0]===0xff&&(b[1]&0xe0)===0xe0)return'mp3';
  if(String.fromCharCode(...b.subarray(0,4))!=='RIFF')return'unknown';
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  for(let o=12;o+8<=b.length;o+=8+v.getUint32(o+4,true)+(v.getUint32(o+4,true)&1)){
    if(String.fromCharCode(...b.subarray(o,o+4))==='fmt ')return`wav tag=0x${v.getUint16(o+8,true).toString(16)} ch=${v.getUint16(o+10,true)} rate=${v.getUint32(o+12,true)} bits=${v.getUint16(o+22,true)}`;
  }
  return'wav no-fmt';
};
for(const p of byPath.keys()){
  try{
    const b=await source.read(p);const tag=waveFormat(b).replace(/ rate=\d+/,'');
    formats.set(tag,(formats.get(tag)||0)+1);
    if(b.length>CREATURE_SOUND.maxBytes)bad.push(`${p} ${b.length} bytes over cap`);
    if(/tag=0x(?!1 )/.test(tag)||tag==='unknown')bad.push(`${p} ${tag}`);
  }catch(e){bad.push(`${p} unreadable: ${e.message}`);}
}
console.log(`displays ${ids.length}, with a death sound ${withSound}, distinct files ${byPath.size}`);
console.log('formats',JSON.stringify([...formats]));
console.log(`${bad.length} problem files`,bad.slice(0,30).join('\n'));
