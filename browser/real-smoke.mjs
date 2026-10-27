// On-demand, real WoW data: node real-smoke.mjs <tag> ; env WOW_DATA (Data folder), PORT (dev server), QUERY (default 'bodies&test'), STEPS (json [[name,{pose:[x,y,z,yaw,pitch],time,wait}]]).
// Screenshots go to runtime/real-smoke/. Prints page errors; exit 1 on any.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';

const {WOW_DATA,PORT='4291',QUERY='bodies&test'}=process.env;
if(!WOW_DATA)throw new Error('WOW_DATA required');
const tag=process.argv[2]||'real',out=path.resolve('..','runtime','real-smoke');fs.mkdirSync(out,{recursive:true});
const ctx=await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(),'edge-real-')),{channel:'msedge',headless:!process.env.LAB_HEADED,args:['--mute-audio'],ignoreDefaultArgs:['--autoplay-policy=no-user-gesture-required'],viewport:{width:1280,height:720},serviceWorkers:'block'});
const page=ctx.pages()[0]||await ctx.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(process.env.LOGS&&m.type()==='warning')console.log('WARN',m.text().slice(0,300));if(m.type()==='error'){errors.push(m.text());Promise.all(m.args().map(a=>a.evaluate(v=>v&&v.message||String(v)).catch(()=>''))).then(x=>console.log('ERRMSG',x.join(' ').slice(0,600)));}});
await page.goto(`http://127.0.0.1:${PORT}/?${QUERY}`);
await page.waitForFunction(()=>!document.getElementById('select').disabled,null,{timeout:60000});
await page.locator('#files').setInputFiles(WOW_DATA);
await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:300000});
console.log('ready',await page.evaluate(()=>worldEvidence.ready),'errors',await page.evaluate(()=>worldEvidence.errors));
await page.keyboard.press('Escape');if(await page.locator('[data-tab=options]').isVisible()){await page.locator('[data-tab=options]').click();await page.keyboard.press('Escape');}await page.evaluate(()=>document.getElementById('welcome')?.remove());await page.locator('#world').click();
const shot=async name=>page.screenshot({path:path.join(out,`${tag}-${name}.png`)});
await page.waitForTimeout(3000);await shot('spawn');
await page.evaluate(()=>{window.__maxGap=0;let last=performance.now();const tick=t=>{window.__maxGap=Math.max(window.__maxGap,t-last);last=t;requestAnimationFrame(tick);};requestAnimationFrame(tick);});
let cdp,t0;
if(process.env.PROFILE){cdp=await ctx.newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:200});await cdp.send('Profiler.start');t0=await page.evaluate(()=>performance.now());}
for(const [name,step] of JSON.parse(process.env.STEPS||'[]')) {
  if(step.key)await page.keyboard.press(step.key);else if(step.click)await page.locator(step.click).first().click();else if(step.pose)await page.evaluate(s=>{window.worldTest.settings({planet:true,...s.settings});if(s.time!==undefined)window.worldTest.timeLock(s.time);window.worldTest.focus(s.pose);},step);
  if(step.tiles)await page.waitForFunction(n=>window.worldTest.renderer().tiles.size>=n,step.tiles,{timeout:60000}).catch(()=>console.log(name,'tiles timeout'));
  await page.waitForTimeout(step.wait??6000);await shot(name);
  if(step.seq) {
    // Hold keys and capture a frame sequence (per-frame camera + swap count) to catch single-frame flashes around a swap.
    for(const k of step.seq.down||[])await page.keyboard.down(k);
    for(let i=0;i<step.seq.n;i++){
      const info=await page.evaluate(()=>({c:worldEvidence.camera?.slice(0,3).map(v=>Math.round(v)),s:worldEvidence.bodySwaps||0,hud:document.getElementById('space-hud')?.textContent}));
      if(!step.seq.noshot)await shot(`${name}-${String(i).padStart(3,'0')}`);console.log(name,i,JSON.stringify(info));
      await page.waitForTimeout(step.seq.gap??100);
    }
    for(const k of step.seq.down||[])await page.keyboard.up(k);
  }
  if(step.eval)console.log(name,JSON.stringify(await page.evaluate(step.eval)));
}
if(cdp) {
  const {profile}=await cdp.send('Profiler.stop'),swaps=await page.evaluate(()=>(worldEvidence.swapProfiles||[]).map(p=>p.start));
  const byId=new Map(profile.nodes.map(n=>[n.id,n])),offset=profile.startTime/1000-t0;let at=profile.startTime/1000;
  for(const start of swaps) {
    const self=new Map();at=profile.startTime/1000;
    profile.samples.forEach((id,i)=>{at+=profile.timeDeltas[i]/1000;const t=at-offset;if(t<start-50||t>start+700)return;const f=byId.get(id).callFrame,key=`${f.functionName||'(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`;self.set(key,(self.get(key)||0)+profile.timeDeltas[i]/1000);});
    console.log('PROFILE swap@',Math.round(start),[...self].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>`${v.toFixed(0)}ms ${k}`).join('\n  '));
  }
}
console.log('METRICS',JSON.stringify(await page.evaluate(()=>({swaps:(worldEvidence.swapProfiles||[]).map(p=>({to:p.to,blockedMs:p.total,phases:p.phases,firstNearMs:p.firstNearMs})),maxFrameGapMs:+window.__maxGap.toFixed(1)}))));
const blocked=await page.evaluate(()=>Math.max(0,...(worldEvidence.swapProfiles||[]).map(p=>p.total)));
if(blocked>+(process.env.MAX_SWAP_MS||20)){errors.push(`swap blocked ${blocked}ms > ${process.env.MAX_SWAP_MS||20}`);}
console.log('url',page.url(),'errors',errors);
await ctx.close();process.exit(errors.length?1:0);
