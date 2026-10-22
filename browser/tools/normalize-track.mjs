// Repeatable track height normalizer.
//   WOW_DATA=<Classic Data folder> node tools/normalize-track.mjs [--write | --out <file>] <track.json> [more.json ...]
// Boots the app in headless Edge on isolated port 4183 (own server, stopped at exit), flies the camera over each point so its
// tile streams in, samples the real ground/water with the same 'probe' the editor snap and clampTrack use, and applies
// browser/track-normalize.js. Dry run unless --write (in place) or --out (single input). Exit 1 if any tile never loaded
// (nothing is written for that track). The game data never leaves the machine.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeTrack,formatTrack} from '../track-normalize.js';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
let write=false,outFile;const inputs=[];
for(let a=process.argv.slice(2);a.length;) {
  const x=a.shift();
  if(x==='--write')write=true;else if(x==='--out')outFile=a.shift();else inputs.push(x);
}
if(!inputs.length||!process.env.WOW_DATA||(outFile&&inputs.length>1)){console.error('usage: WOW_DATA=<Data> node tools/normalize-track.mjs [--write|--out f] <track.json> ...');process.exit(2);}

const PORT=4183,server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(PORT)},stdio:'ignore'});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'edge-norm-'));
let ctx,failed=false;
try {
  await new Promise(r=>setTimeout(r,2000));
  ctx=await chromium.launchPersistentContext(dir,{channel:'msedge',headless:true,args:['--mute-audio'],viewport:{width:1100,height:700},serviceWorkers:'block'});
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  await page.waitForTimeout(2500);

  // A point counts as loaded once ground or water is finite; otherwise it is reported, never guessed.
  async function sample(p) {
    const deadline=Date.now()+45000;
    await page.evaluate(([x,y,z])=>worldTest.focus([x,y+120,z,0,-.4]),p);
    while(Date.now()<deadline) {
      const [s]=await page.evaluate(([x,z])=>worldTest.request('probe',{points:[[x,z]]}),[p[0],p[2]]);
      if(s&&(Number.isFinite(s[1])||Number.isFinite(s[2])))return {ground:s[1],water:s[2]};
      await page.waitForTimeout(500);
    }
  }

  for(const file of inputs) {
    const src=JSON.parse(fs.readFileSync(file,'utf8')),pts=[src.start.pos,...src.gates.map(g=>g.pos)],samples=new Map();
    for(const p of pts)samples.set(p[0]+','+p[2],await sample(p));
    const {track,report,unresolved}=normalizeTrack(src,p=>samples.get(p[0]+','+p[2]));
    console.log(`\n${file} (${src.id}, ${src.gates.length} gates)`);
    for(const r of report)console.log(`  ${r.label.padEnd(8)} ${r.status==='unloaded'?'tile not loaded: left as authored':`${r.old.toFixed(2)} -> ${r.new.toFixed(2)}  (delta ${r.delta>=0?'+':''}${r.delta}, surface ${r.base})`}`);
    const changed=report.filter(r=>r.status==='changed').length;
    console.log(`  ${changed} changed, ${report.length-changed-unresolved.length} unchanged, ${unresolved.length} unresolved`);
    if(unresolved.length){failed=true;console.log('  REFUSED: not written (unresolved gates).');continue;}
    if(write||outFile){fs.writeFileSync(outFile||file,formatTrack(track));console.log(`  wrote ${outFile||file}`);}
  }
} finally {
  await ctx?.close().catch(()=>{});
  server.kill();
}
process.exit(failed?1:0);
