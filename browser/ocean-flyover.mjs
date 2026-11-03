// Integration test: flies a flight camera from Booty Bay out over the sea to the Maelstrom through many checkpoints on the real WoW data,
// and at each one waits for streaming to settle, captures a screenshot (twice, for flicker) and measures glitch metrics. Fails on magenta /
// black holes, isolated bright sparkles, horizontal/vertical colour bands, colour jumps between adjacent checkpoints and repeat-frame flicker.
//   WOW_DATA=<read-only Data folder> node browser/ocean-flyover.mjs          (heavy: takes the machine-wide heavy lock itself)
// Env: VARIANTS=high,low,down,side  TIMES='[1440]' (half-minutes, 1440 noon)  LABEL=ocean-flyover  START='[x,z]'  STOP_SHORT=1500
//      COAST/OPEN/NEAR (checkpoint spacing, yd)  LIMIT=<max checkpoints>  SETTLE_MS=40000  REPEAT_MS=800  WIDTH/HEIGHT
// Output: browser/test-results/<LABEL>/{report.json,frames/*.png,sheet-*.png} (git-ignored; derived from game data, never commit).
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {acquireHeavyLock} from './heavy-lock.mjs';
import {flyoverRoute,analyseFrame,checkRows,DEFAULT_LIMITS} from './ocean-flyover-lib.js';

assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data folder');
const label=process.env.LABEL||'ocean-flyover';
assert(/^[\w-]+$/.test(label));
const VARIANTS={
  high:{alt:60,pitch:-.25,yaw:0},
  low:{alt:5,pitch:-.04,yaw:0},
  down:{alt:200,pitch:-1.1,yaw:0},
  side:{alt:25,pitch:-.15,yaw:Math.PI/2},
};
const names=(process.env.VARIANTS||'high,low').split(',');
for(const n of names)assert(VARIANTS[n],`Unknown variant ${n}`);
const times=JSON.parse(process.env.TIMES||'[1440]');
const settleMs=+process.env.SETTLE_MS||40000,repeatMs=+process.env.REPEAT_MS||800,W=+process.env.WIDTH||960,H=+process.env.HEIGHT||600;
const out=new URL(`./test-results/${label}/`,import.meta.url);
await mkdir(new URL('frames/',out),{recursive:true});

const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
const release=await acquireHeavyLock('ocean-flyover');
const port=await freePort();
assert.notEqual(port,4173);
const server=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',()=>reject(new Error('server exited')));});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});
const errors=[],rows=[];
let failures=[];
try{
  const context=await browser.newContext({viewport:{width:W,height:H},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text());});
  await page.goto(`http://127.0.0.1:${port}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[],'World failed to start');
  await page.locator('#world').click();
  await page.waitForTimeout(2000);
  const {booty,centre}=await page.evaluate(async()=>{
    const m=worldTest.manifest(),{regionOffset}=await import('./worldmap.js'),{maelstromCentre}=await import('./clouds.js');
    const [kx,kz]=regionOffset(m.regions[1]);
    return {booty:[500*-1+kx,14300+kz],centre:maelstromCentre(m)};
  });
  const start=process.env.START?JSON.parse(process.env.START):booty;
  const route=flyoverRoute(start,centre,{coast:+process.env.COAST||150,open:+process.env.OPEN||450,near:+process.env.NEAR||250,stopShort:+process.env.STOP_SHORT||1500});
  const limit=+process.env.LIMIT||route.length;
  console.log(`Booty Bay ${start.map(Math.round)} -> Maelstrom ${centre.map(Math.round)}: ${route.length} checkpoints x ${names.length} variants x ${times.length} times`);
  const yaw0=Math.atan2(-(centre[0]-start[0]),-(centre[1]-start[1]));
  // Self-contained analysis + contact-sheet code runs in the page so screenshots are decoded once and only metrics cross the wire.
  await page.evaluate(({src,W,H})=>{
    window.__analyse=new Function('return '+src)();
    window.__sheets=[];window.__cell=0;window.__cols=6;window.__rowsPerSheet=5;window.__tw=320;window.__th=200;
    window.__capture=async(b64,caption)=>{
      const img=await createImageBitmap(new Blob([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],{type:'image/png'}));
      const c=new OffscreenCanvas(img.width,img.height).getContext('2d');c.drawImage(img,0,0);
      const stats=window.__analyse(c.getImageData(0,0,img.width,img.height).data,img.width,img.height);
      if(caption){
        const per=window.__cols*window.__rowsPerSheet,k=window.__cell++,s=Math.floor(k/per),j=k%per;
        if(!window.__sheets[s]){const cv=new OffscreenCanvas(window.__cols*window.__tw,window.__rowsPerSheet*window.__th);const g=cv.getContext('2d');g.fillStyle='#000';g.fillRect(0,0,cv.width,cv.height);window.__sheets[s]=cv;}
        const g=window.__sheets[s].getContext('2d'),x=(j%window.__cols)*window.__tw,y=Math.floor(j/window.__cols)*window.__th;
        g.drawImage(img,x,y,window.__tw,window.__th);g.font='13px monospace';g.fillStyle='#000';g.fillRect(x,y,window.__tw,16);g.fillStyle='#ff0';g.fillText(caption,x+3,y+12);
      }
      return stats;
    };
  },{src:analyseFrame.toString(),W,H});
  let warm=true;
  const settle=async()=>{
    const t0=Date.now(),cap=warm?300000:settleMs;
    warm=false;
    let prev='',same=0;
    await page.waitForTimeout(1200);
    while(Date.now()-t0<cap){
      const sig=await page.evaluate(()=>{const st=worldEvidence.state,tr=st.terrain||{},w=st.water||{},d=st.distant||{};
        const busy=tr.pending||tr.farPending||d.pending;
        return busy?'busy'+JSON.stringify([tr.pending,tr.farPending,d.pending]):JSON.stringify([st.resident?.length,st.nearTerrain,w.resident,w.pending,st.loads]);});
      same=sig===prev?same+1:0;prev=sig;
      if(process.env.DEBUG_SETTLE)console.log(Date.now()-t0,sig.slice(0,300));
      if(same>=5)break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(400);
    return Date.now()-t0;
  };
  for(const time of times)for(const name of names){
    const v=VARIANTS[name];
    for(const [i,p] of route.slice(0,limit).entries()){
      await page.evaluate(([x,y,z,yaw,pitch,time])=>{worldTest.timeLock(time);worldTest.focus([x,y,z,yaw,pitch]);},[p.x,v.alt,p.z,yaw0+v.yaw,v.pitch,time]);
      const settledMs=await settle();
      const variant=`${name}@${time}`,caption=`${i} d${Math.round(p.d)} ${variant}`;
      const png=await page.screenshot();
      const stats=await page.evaluate(([b,c])=>window.__capture(b,c),[png.toString('base64'),caption]);
      await page.waitForTimeout(repeatMs);
      const repeat=await page.evaluate(([b])=>window.__capture(b,null),[(await page.screenshot()).toString('base64')]);
      const file=`frames/${variant.replace('@','-')}-${String(i).padStart(3,'0')}-d${Math.round(p.d)}.png`;
      await writeFile(new URL(file,out),png);
      const ev=await page.evaluate(()=>{const st=worldEvidence.state;return {near:st.nearTerrain,pending:st.terrain?.pending,water:st.water&&{resident:st.water.resident,pending:st.water.pending}};});
      rows.push({i,d:p.d,x:p.x,z:p.z,variant,settledMs,file,stats,repeat,ev});
      if(i%10===0)console.log(caption,stats.mean.map(Math.round).join(','),`row ${stats.rowStep.toFixed(1)} col ${stats.colStep.toFixed(1)} settled ${settledMs}ms`);
    }
  }
  const sheets=await page.evaluate(async()=>{const r=[];for(const cv of window.__sheets){const b=await cv.convertToBlob({type:'image/png'});r.push(await new Promise(res=>{const f=new FileReader();f.onload=()=>res(f.result.split(',')[1]);f.readAsDataURL(b);}));}return r;});
  for(const [k,b] of sheets.entries())await writeFile(new URL(`sheet-${k}.png`,out),Buffer.from(b,'base64'));
  failures=checkRows(rows,{...DEFAULT_LIMITS,...(process.env.LIMITS?JSON.parse(process.env.LIMITS):{})});
  if(errors.length)failures.push(...errors.slice(0,10).map(e=>'page error: '+e));
}finally{
  await writeFile(new URL('report.json',out),JSON.stringify({failures,rows},null,1));
  await browser.close();server.kill();release();
}
console.log(failures.length?`FAIL: ${failures.length} glitches\n${failures.join('\n')}`:'PASS');
process.exit(failures.length?1:0);
