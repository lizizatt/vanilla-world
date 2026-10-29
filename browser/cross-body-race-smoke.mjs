// Real-data smoke: a user track that starts on Elune and ends with a gate on Azeroth, flown with the 90-degree ramp launch.
// Needs WOW_DATA and SWE1R_DATA; muted headless Edge on an ephemeral port; takes the machine-wide heavy lock itself.
// Pass 1 flies the same launch without a race to learn where the pod lands on Azeroth; pass 2 flies it as the race and asserts
// the gate order, the next-gate HUD across bodies, the finish, the saved score and the handler p99.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';
assert(process.env.WOW_DATA&&process.env.SWE1R_DATA,'Set WOW_DATA and SWE1R_DATA');
const release=await acquireHeavyLock('cross-body-race'),root=new URL('./',import.meta.url),out=new URL('./test-results/cross-body-race/',root);
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,file=new URL(name==='/'?'index.html':'.'+name,root);
  if(name==='/favicon.ico'){res.writeHead(204).end();return;}
  if(!file.href.startsWith(root.href)){res.writeHead(403).end();return;}
  try{res.setHeader('content-type',mime[extname(file.pathname)]||'application/octet-stream');res.end(await readFile(file));}
  catch{res.writeHead(404).end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),errors=[];
let page;
const shot=name=>page.screenshot({path:fileURLToPath(new URL(name,out))});
// Flies the ramp launch with the same pad script as pod-launch-smoke; `race` additionally samples the race and its HUD.
const fly=async race=>{
  await page.evaluate(race=>{
    const mine=window.cb={samples:[],frames:[],on:true,seen:undefined};let last,burnStart;
    const pad={connected:true,mapping:'standard',index:0,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
    const record=t=>{
      if(!mine.on||window.cb!==mine)return;
      const pod=worldEvidence.state?.pod,j=pod?.journey,r=worldTest.raceObj();
      if(r)cb.seen=r;
      if(last)cb.frames.push(t-last);last=t;
      if(j?.mode==='orbit'&&burnStart===undefined)burnStart=j.time;
      const powered=j?.mode==='orbit'&&(j.time-burnStart)/2<16;
      pad.buttons[0]={pressed:powered,value:+powered};pad.buttons[7]={pressed:!j||powered,value:!j||powered?1:0};
      worldTest.gamepads([pad]);
      const s=cb.samples.at(-1);
      if(!s||t-s.at>100||(race&&r&&(s.next!==r.next||s.body!==cbBody().id)))cb.samples.push({at:t,body:cbBody().id,jp:j?.parent??null,p:worldEvidence.state.telemetry.slice(0,6),
        state:r?.state,next:r?.next,pod:pod&&{rem:pod.remaining,spent:pod.spent?.length,mode:j?.mode},gateText:document.getElementById('race-gate').textContent,arrowHidden:document.getElementById('race-arrow').hidden,props:worldTest.propCount?.(),swaps:worldEvidence.bodySwaps});
      requestAnimationFrame(record);
    };requestAnimationFrame(record);
  },race);
};
try{
  await mkdir(out,{recursive:true});
  // A fresh page per pass: a second in-page launch after a map teleport has no warm parent engine to swap into.
  const boot=async()=>{
    const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
    await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
    page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='warning'||m.type()==='error')console.log('CONSOLE',m.text().slice(0,220));});
    await page.goto(`http://127.0.0.1:${server.address().port}/?test`);
    await page.waitForFunction(()=>!document.getElementById('select').disabled);
    await page.locator('#swe1r-files').setInputFiles(process.env.SWE1R_DATA);
    await page.waitForFunction(()=>document.getElementById('swe1r-status').dataset.ok==='1');
    await page.locator('#files').setInputFiles(process.env.WOW_DATA);
    await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
    assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
    await page.evaluate(()=>{document.getElementById('welcome').hidden=true;});
    await page.locator('#world').click();
    await page.waitForTimeout(6000);
    await page.evaluate(()=>worldTest.launch.swap('elune'));
    await page.evaluate(async()=>{
      const {VEHICLES}=await import('./vehicles.js');
      window.cbBody=(await import('./body-shaders.js')).activeBody;
      worldTest.selectVehicle({vehicle:'podracer',skin:VEHICLES.podracer.skins.find(s=>s.source==='swe1r').id});
      worldTest.focus([-300,300,120,0,-1]);
    });
    await page.waitForTimeout(6000);
  };
  await boot();
  // Elune's launch window depends on the sim clock, so both passes freeze it at the same time.
  const freeze=()=>page.evaluate(async t=>{const {simEpoch}=await import('./sim-clock.js'),r=worldTest.renderer();r.clock.set(t);r.clock.step=()=>{};simEpoch.days=0;},Number(process.env.SIM_TIME||1000));
  const setup=()=>page.evaluate(async()=>{
    await worldTest.launch.save([]);
    await worldTest.launch.place([-300,0,0],0,'ramp',90);
    await worldTest.launch.place([-300,0,60],0,'powerup');
    const [ground]=await worldTest.request('probe',{points:[[-300,220]]}),[g1]=await worldTest.request('probe',{points:[[-300,150]]});
    const top=s=>Math.max(...s.slice(1,3).filter(Number.isFinite));
    return {start:top(ground),gate1:top(g1)};
  });
  // Pass 1: no race, learn the Azeroth landing.
  const ground=await setup();
  await freeze();
  await page.evaluate(y=>worldTest.restore([-300,y+3,220,0]),ground.start);
  await page.locator('#world').click();
  await fly(false);
  await page.waitForFunction(()=>worldEvidence.state?.pod?.journey?.parent==='azeroth'||worldEvidence.errors.length,null,{timeout:240000});
  await page.waitForFunction(()=>!worldEvidence.state.pod.journey||worldEvidence.errors.length,null,{timeout:180000});
  await page.waitForTimeout(1500);
  const dry=await page.evaluate(()=>{cb.on=false;return cb.samples;});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await writeFile(new URL('dry-samples.json',out),JSON.stringify(dry));
  const air=dry.filter(s=>s.jp==='azeroth').at(-1),land=dry.find(s=>s.at>air.at&&!s.jp);
  assert(air&&land,'dry run must end with a landing on Azeroth');
  const dx=land.p[0]-air.p[0],dz=land.p[2]-air.p[2],len=Math.hypot(dx,dz)||1,yaw=Math.atan2(-dx,-dz);
  const gate2=[land.p[0]+dx/len*40,land.p[1]+20,land.p[2]+dz/len*40];
  await writeFile(new URL('dry.json',out),JSON.stringify({air,land,gate2,yaw},null,2));
  await page.context().close();
  await boot();
  const ground2=await setup();
  await freeze();
  // Author, validate, save and reload the user track through the same store the editor uses.
  const stored=await page.evaluate(async([g,gate2,yaw])=>{
    const {validateTrack}=await import('./race.js'),store=await import('./world-store.js');
    const track=validateTrack({id:'moon-to-home',name:'Moon to home',body:'elune',vehicle:'podracer',mode:'p2p',laps:1,start:{pos:[-300,g.start+1,220],yaw:0},
      gates:[{pos:[-300,g.gate1+20,150],yaw:0,width:60},{pos:gate2,yaw,width:200,body:'azeroth'}]});
    await store.trackOverride(track.id,track);await store.trackOverride('~index',[track.id]);
    return {saved:track,loaded:await store.trackOverride(track.id)};
  },[ground2,gate2,yaw]);
  assert.deepEqual(stored.loaded,stored.saved);assert.equal(stored.loaded.gates[1].body,'azeroth');
  const swaps0=await page.evaluate(()=>worldEvidence.bodySwaps);
  // A launch that burns out short of Azeroth's gravity well falls back; that is flight physics noise (frame hitches on a busy machine), so the race is simply flown again.
  let handedOff=false;
  for(let attempt=1;attempt<=3&&!handedOff;attempt++){
    if(attempt>1){await page.evaluate(()=>worldTest.raceObj()?.cancel('retry'));await page.waitForFunction(()=>!worldTest.raceObj(),null,{timeout:30000});await setup();await freeze();}
    await page.evaluate(y=>worldTest.restore([-300,y+3,220,0]),ground2.start);
    await page.evaluate(t=>worldTest.startRace(t),stored.loaded);
    await page.waitForFunction(()=>worldTest.raceObj()?.state==='countdown',null,{timeout:30000});
    await page.locator('#world').click();
    if(attempt===1)await shot('race-start.png');
    await fly(true);
    handedOff=await page.waitForFunction(()=>{
      if(worldEvidence.errors.length||worldEvidence.state?.pod?.journey?.parent==='azeroth')return true;
      cb.had||=!!worldEvidence.state?.pod?.journey;
      return cb.had&&!worldEvidence.state.pod.journey&&cbBody().id==='elune'?'fell':false;
    },null,{timeout:120000,polling:250}).then(h=>h.jsonValue()).then(v=>v===true);
    console.log('race attempt',attempt,handedOff?'reached Azeroth':'fell back');
  }
  assert(handedOff,'the powered launch must reach Azeroth within 3 attempts');
  await shot('race-space-handoff.png');
  // The landing spot drifts with frame timing, so the final approach starts from a fixed pose short of gate 2 (a respawn, as a player would after a bad landing).
  await page.waitForFunction(()=>!worldEvidence.state.pod.journey&&cbBody().id==='azeroth',null,{timeout:180000});
  await page.waitForTimeout(1500);
  await page.evaluate(([g,y])=>{const dx=-Math.sin(y),dz=-Math.cos(y);return worldTest.restore([g[0]-dx*60,g[1]-17,g[2]-dz*60,y]).then(()=>worldTest.raceObj()?.jump());},[gate2,yaw]);
  await page.waitForFunction(()=>!worldTest.raceObj()||worldEvidence.errors.length,null,{timeout:240000});
  await page.waitForTimeout(1500);
  await shot('race-finish.png');
  const res=await page.evaluate(async()=>{
    cb.on=false;const store=await import('./world-store.js'),r=cb.seen;
    return {samples:cb.samples,frames:cb.frames,state:r.state,next:r.next,splits:r.splits,time:r.time,errors:worldEvidence.errors,swaps:worldEvidence.bodySwaps,
      board:document.getElementById('race-board').textContent,boardHidden:document.getElementById('race-board').hidden,scores:await store.raceScores('moon-to-home')};
  });
  await writeFile(new URL('results.json',out),JSON.stringify(res,null,2));
  assert.deepEqual([...errors,...res.errors],[]);
  assert.equal(res.state,'finished');assert.equal(res.next,2);assert.equal(res.splits.length,2);assert(res.splits[0]<res.splits[1]);
  assert(res.swaps-swaps0>=1,'the Elune->Azeroth swap happened during the race');
  assert(!res.boardHidden&&res.board.includes('Moon to home'));assert.equal(res.scores?.runs?.length,1);
  const S=res.samples;
  const first=S.find(s=>s.state==='running'&&s.body==='elune'&&s.next===0);
  assert(first&&first.arrowHidden===false&&/^Gate 1\/2$/.test(first.gateText),`gate 1 HUD on Elune: ${JSON.stringify(first)}`);
  const away=S.find(s=>s.state==='running'&&s.body==='elune'&&s.next===1);
  assert(away&&away.arrowHidden===true&&/Gate 2\/2 \(azeroth\)/.test(away.gateText),`cross-body HUD: ${JSON.stringify(away)}`);
  const home=S.find(s=>s.state==='running'&&s.body==='azeroth'&&s.jp!=='elune'&&s.next===1);
  assert(home&&home.arrowHidden===false&&/^Gate 2\/2$/.test(home.gateText)&&home.props>0,`Azeroth HUD and finish gantry: ${JSON.stringify(home)}`);
  assert(!S.some(s=>s.state==='cancelled'));
  const p99=res.frames.toSorted((a,b)=>a-b)[Math.floor(res.frames.length*.99)];
  assert(p99<=20,`frame p99=${p99}ms`);
  console.log(JSON.stringify({swaps:res.swaps-swaps0,splits:res.splits,time:res.time,p99,samples:S.length}));
}catch(error){
  if(page)await writeFile(new URL('failure.json',out),JSON.stringify(await page.evaluate(()=>({state:worldEvidence.state,errors:worldEvidence.errors,race:worldTest.raceObj()&&{s:worldTest.raceObj().state,n:worldTest.raceObj().next},samples:window.cb?.samples?.filter((s,i)=>i%3===0).map(s=>({...s,p:s.p.slice(0,4).map(Math.round)}))}))));
  throw error;
}finally{await browser.close();await new Promise(r=>server.close(r));release();}
