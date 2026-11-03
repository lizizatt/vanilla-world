// Real-data smoke: author an Elune -> Azeroth track through the in-game track editor code path (open, new track, add gates, jump
// bodies mid-edit, validate, save), then race it from the editor's Test drive through the 90-degree ramp launch and the body swap.
// Needs WOW_DATA and SWE1R_DATA; muted headless Edge on an ephemeral port; takes the machine-wide heavy lock itself (do not wrap it).
// Pass 1 flies the launch without a race to learn where the pod lands on Azeroth so the Azeroth gates can be authored just past it.
// Output: browser/test-results/elune-to-azeroth/ (screenshots, authored.json, results.json).
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';
assert(process.env.WOW_DATA&&process.env.SWE1R_DATA,'Set WOW_DATA and SWE1R_DATA');
const release=await acquireHeavyLock('elune-to-azeroth'),root=new URL('./',import.meta.url),out=new URL('./test-results/elune-to-azeroth/',root);
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
const shot=name=>page.screenshot({path:fileURLToPath(new URL(name,out))}).then(()=>console.log('shot',fileURLToPath(new URL(name,out))));
const fly=async()=>{
  await page.evaluate(()=>{
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
      if(!s||t-s.at>100||(r&&(s.next!==r.next||s.body!==cbBody().id)))cb.samples.push({at:t,body:cbBody().id,jp:j?.parent??null,p:worldEvidence.state.telemetry.slice(0,6),
        state:r?.state,next:r?.next,gateText:document.getElementById('race-gate').textContent,rangeText:document.getElementById('race-range').textContent,swaps:worldEvidence.bodySwaps});
      requestAnimationFrame(record);
    };requestAnimationFrame(record);
  });
};
try{
  await mkdir(out,{recursive:true});
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
  const freeze=()=>page.evaluate(async t=>{const {simEpoch}=await import('./sim-clock.js'),r=worldTest.renderer();r.clock.set(t);r.clock.step=()=>{};simEpoch.days=0;},Number(process.env.SIM_TIME||1000));
  // The launch ramp and boost pickup live in the launch store (not in the track JSON); they are placed with the editor's launch tools' API.
  const setup=()=>page.evaluate(async()=>{
    await worldTest.launch.save([]);
    await worldTest.launch.place([-300,0,0],0,'ramp',90);
    await worldTest.launch.place([-300,0,60],0,'powerup');
    const [ground]=await worldTest.request('probe',{points:[[-300,220]]});
    return Math.max(...ground.slice(1,3).filter(Number.isFinite));
  });
  // Pass 1: no race, learn the Azeroth landing.
  const startY=await setup();
  await freeze();
  await page.evaluate(y=>worldTest.restore([-300,y+3,220,0]),startY);
  await page.locator('#world').click();
  await fly();
  await page.waitForFunction(()=>worldEvidence.state?.pod?.journey?.parent==='azeroth'||worldEvidence.errors.length,null,{timeout:240000});
  await page.waitForFunction(()=>!worldEvidence.state.pod.journey||worldEvidence.errors.length,null,{timeout:180000});
  await page.waitForTimeout(1500);
  const dry=await page.evaluate(()=>{cb.on=false;return cb.samples;});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  const air=dry.filter(s=>s.jp==='azeroth').at(-1),land=dry.find(s=>s.at>air.at&&!s.jp);
  assert(air&&land,'dry run must end with a landing on Azeroth');
  const dx=land.p[0]-air.p[0],dz=land.p[2]-air.p[2],len=Math.hypot(dx,dz)||1,yaw=Math.atan2(-dx,-dz);
  const gateA=[land.p[0]+dx/len*40,land.p[1]+20,land.p[2]+dz/len*40],gateB=[gateA[0]+dx/len*110,gateA[1],gateA[2]+dz/len*110];
  await page.context().close();
  await boot();
  const startY2=await setup();
  await freeze();
  await page.evaluate(y=>worldTest.restore([-300,y+3,220,0]),startY2);
  await page.waitForTimeout(1500);

  // Author through the editor: open on Elune, new track, two Elune gates, jump to Azeroth mid-edit, two Azeroth gates, save, Test drive.
  const authored=await page.evaluate(async([ga,gb,yaw])=>{
    const ed=worldTest.editor,wait=async(f,what)=>{for(let i=0;i<400&&!f();i++)await new Promise(r=>setTimeout(r,50));if(!f())throw new Error('timeout: '+what);};
    const el=id=>document.getElementById(id),fire=(id,v)=>{el(id).value=v;el(id).dispatchEvent(new Event('change'));};
    worldTest.toggleEditor();await wait(()=>ed.isOpen,'editor open');
    fire('te-track','');await new Promise(r=>setTimeout(r,200));
    el('te-name').value='Elune to Azeroth';el('te-name').dispatchEvent(new Event('input'));
    await new Promise(r=>setTimeout(r,300));
    const y=ed.draft.start.pos[1];
    await ed.addGateAt([-300,y,170]);await ed.addGateAt([-300,y,110]);
    const lastElune=ed.draft.gates[1].pos.slice();
    if(!await ed.jumpTo('azeroth'))throw new Error(el('te-status').textContent);
    await new Promise(r=>setTimeout(r,800));
    const i=await ed.addGateAt(ga);ed.draft.setGateYaw(i,yaw);ed.draft.setGateHeight(i,ga[1]);
    const j=await ed.addGateAt(gb);ed.draft.setGateYaw(j,yaw);ed.draft.setGateHeight(j,gb[1]);
    const rows=[...el('te-list').children].map(li=>li.textContent);
    await new Promise(r=>setTimeout(r,300));
    const v=await ed.validate();if(!v)throw new Error(el('te-status').textContent);
    el('te-save').click();await wait(()=>/Saved/.test(el('te-status').textContent),'saved');
    const store=await import('./world-store.js');
    return {track:v.track,warnings:v.warnings,rows:[...el('te-list').children].map(li=>li.textContent),rowsBefore:rows,loaded:await store.trackOverride(v.track.id),lastElune,status:el('te-status').textContent,body:cbBody().id};
  },[gateA,gateB,yaw]);
  await writeFile(new URL('authored.json',out),JSON.stringify(authored,null,2));
  console.log('authored',authored.track.id,authored.track.gates.map(g=>g.body||'elune').join(','),authored.rows.join(' | '));
  assert.equal(authored.body,'azeroth');assert.deepEqual(authored.loaded,authored.track);
  assert.deepEqual(authored.track.gates.map(g=>g.body),[undefined,undefined,'azeroth','azeroth']);
  assert.equal(authored.track.mode,'p2p');assert(authored.rows.some(r=>/jump Elune → Azeroth/.test(r)),'the list marks the jump');

  const swaps0=await page.evaluate(()=>worldEvidence.bodySwaps);
  let handedOff=false;
  for(let attempt=1;attempt<=3&&!handedOff;attempt++){
    if(attempt>1){await page.evaluate(()=>worldTest.raceObj()?.cancel('retry'));await page.waitForFunction(()=>!worldTest.raceObj(),null,{timeout:30000});await setup();}
    if(attempt===1)await page.evaluate(()=>document.getElementById('te-test').click());
    else await page.evaluate(t=>worldTest.startRace(t),authored.track);
    await page.waitForFunction(()=>worldTest.raceObj()?.state==='countdown',null,{timeout:60000});
    assert.equal(await page.evaluate(()=>cbBody().id),'elune','Test drive swaps back to the track start body');
    await freeze();
    await page.locator('#world').click();
    if(attempt===1)await shot('0-race-start-elune.png');
    await fly();
    if(attempt===1){
      await page.waitForFunction(()=>{const r=worldTest.raceObj();return r?.state==='running'&&r.next===1&&cbBody().id==='elune';},null,{timeout:90000,polling:50});
      await shot('1-last-elune-gate.png');
      await page.waitForFunction(()=>{const r=worldTest.raceObj();return r?.next===2&&cbBody().id==='elune';},null,{timeout:30000,polling:50}).then(()=>shot('2-cross-body-trail-on-elune.png')).catch(()=>console.log('cross-body trail shot missed'));
    }
    handedOff=await page.waitForFunction(()=>{
      if(worldEvidence.errors.length||worldEvidence.state?.pod?.journey?.parent==='azeroth')return true;
      cb.had||=!!worldEvidence.state?.pod?.journey;
      return cb.had&&!worldEvidence.state.pod.journey&&cbBody().id==='elune'?'fell':false;
    },null,{timeout:120000,polling:250}).then(h=>h.jsonValue()).then(v=>v===true);
    console.log('race attempt',attempt,handedOff?'reached Azeroth':'fell back');
  }
  assert(handedOff,'the powered launch must reach Azeroth within 3 attempts');
  await shot('3-space-handoff.png');
  await page.waitForFunction(()=>!worldEvidence.state.pod.journey&&cbBody().id==='azeroth',null,{timeout:180000});
  await page.waitForTimeout(1200);
  await shot('4-arrival-on-azeroth.png');
  // The landing drifts with frame timing, so the approach to the first Azeroth gate starts from a fixed pose short of it (a respawn).
  const A=authored.track.gates[2];
  await page.evaluate(([g,y])=>{const dx=-Math.sin(y),dz=-Math.cos(y);return worldTest.restore([g[0]-dx*60,g[1]-17,g[2]-dz*60,y]).then(()=>worldTest.raceObj()?.jump());},[A.pos,A.yaw]);
  await page.waitForTimeout(700);
  await shot('5-approaching-first-azeroth-gate.png');
  await page.waitForFunction(()=>!worldTest.raceObj()||worldEvidence.errors.length,null,{timeout:240000});
  await page.waitForTimeout(1500);
  await shot('6-finish.png');
  const res=await page.evaluate(async()=>{
    cb.on=false;const r=cb.seen;
    return {samples:cb.samples,frames:cb.frames,state:r.state,next:r.next,splits:r.splits,time:r.time,errors:worldEvidence.errors,swaps:worldEvidence.bodySwaps};
  });
  await writeFile(new URL('results.json',out),JSON.stringify(res,null,2));
  assert.deepEqual([...errors,...res.errors],[]);
  assert.equal(res.state,'finished');assert.equal(res.splits.length,4);assert(res.splits.every((s,i)=>!i||s>res.splits[i-1]));
  assert(res.swaps-swaps0>=1,'the Elune->Azeroth swap happened during the race');
  const S=res.samples;
  assert(S.some(s=>s.state==='running'&&s.body==='elune'&&s.next===2&&/azeroth/.test(s.gateText)),'cross-body HUD after the last Elune gate');
  assert(S.some(s=>s.state==='running'&&s.body==='azeroth'&&s.next>=2),'racing on Azeroth after the jump');
  assert(!S.some(s=>s.state==='cancelled'));
  console.log(JSON.stringify({swaps:res.swaps-swaps0,splits:res.splits,time:res.time,samples:S.length}));
}catch(error){
  if(page)await writeFile(new URL('failure.json',out),JSON.stringify(await page.evaluate(()=>({state:worldEvidence.state,errors:worldEvidence.errors,status:document.getElementById('te-status')?.textContent,race:worldTest.raceObj()&&{s:worldTest.raceObj().state,n:worldTest.raceObj().next},samples:window.cb?.samples?.filter((s,i)=>i%3===0).map(s=>({...s,p:s.p.slice(0,4).map(Math.round)}))})).catch(e=>({evalError:e.message}))));
  throw error;
}finally{await browser.close();await new Promise(r=>server.close(r));release();}
