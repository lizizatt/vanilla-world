import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {acquireHeavyLock} from './heavy-lock.mjs';

// On-demand, real WoW data: fly the craft through a real creature near Stormwind and check the death clip, its hold, the spatial sound, respawn and handler p99.
// Run: $env:WOW_DATA='...\Data'; node creature-death-smoke.mjs   (free port, muted, takes the machine-wide heavy lock, ~4 min because respawn is real time)
assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
const release=await acquireHeavyLock('creature-death-real-data'),root=new URL('./',import.meta.url),out=new URL('./test-results/creature-death/',root);
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
// Test-only patches of the served text (the repo is untouched): handler time per frame and a log of worker creature events.
const patches={
  '/world-worker-protocol.js':s=>s.replace('const result=await handle(data),start=performance.now();',
    "const began=performance.now(),result=await handle(data),start=performance.now();if(data.action==='frame')result.testHandlerMs=start-began;"),
  '/world-engine.js':s=>s.replace('actors.collide(sceneState.instances,sceneState.assets,actorCraft[0],actorCraft[1],actorCraft[2],npcDisplayOf);}','actors.collide(sceneState.instances,sceneState.assets,actorCraft[0],actorCraft[1],actorCraft[2],npcDisplayOf);if(performance.now()-(globalThis.__dt||0)>400){globalThis.__dt=performance.now();const near=[];for(const i of sceneState.instances){if(!i.id.includes(":npc:"))continue;const d=Math.hypot(i.matrix[12]-actorCraft[0],i.matrix[13]-actorCraft[1]);if(d<25)near.push({id:i.id,d,cls:actors.classOf(i),size:actors.sizeOf(i)?.slice(),dur:actors.durationOf(i),z:i.matrix[14]});}const durs={};for(const i of sceneState.instances){if(i.id.includes(":npc:"))durs[i.path.slice(-28)]=actors.durationOf(i);}if(near.length)postMessage({durs,event:"cc-diag",stats:actors.cc.stats,speed:actors.cc.lastSpeed,en:actors.cc.enabled,craft:actorCraft.slice(0,4),near:near.slice(0,4)});}}'),
  '/actors.js':s=>s.replace('actor.duration(1)','actor.duration(1)||actor.duration(0)').replace('model.actor.pose(1,','model.actor.pose(model.death===model.duration?0:1,').replace('if (!displayId) return;','this.post({event:"cc-diag",sd:{displayId:displayId??null,id:e.id}},[]);if (!displayId) return;').replace('if (!r || this.closed) return;','this.post({event:"cc-diag",sdr:r?{path:r.path,len:r.bytes?.length}:null},[]);if (!r || this.closed) return;'),
  '/world-app.js':s=>s.replace('const client=new WorldClient(data=>{',
    "const client=new WorldClient(data=>{if(data.event==='creature-sound'||data.event==='npc-fx'||data.event==='cc-diag'){(globalThis.__cc??=[]).push({t:performance.now(),event:data.event,path:data.path,bytes:data.bytes?.length,diag:data.event==='cc-diag'?data:undefined,dead:data.dead,hidden:data.hidden,x:data.x,y:data.y,z:data.z});}"),
};
const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,file=new URL(name==='/'?'index.html':name==='/npc-pack.json'?'npc-pack.public.json':'.'+name,root);
  if(name==='/favicon.ico'){res.writeHead(204).end();return;}
  if(!file.href.startsWith(root.href)){res.writeHead(403).end();return;}
  try{
    let bytes=await readFile(file);
    if(patches[name]){const before=bytes.toString(),after=patches[name](before);assert.notEqual(after,before,`patch for ${name} no longer applies`);bytes=after;}
    res.setHeader('content-type',mime[extname(file.pathname)]||'application/octet-stream');res.end(bytes);
  }catch{res.writeHead(404).end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),errors=[],result={errors,attempts:[]};
const pct=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))]:NaN;
try{
  await mkdir(out,{recursive:true});
  const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
  await context.addInitScript(()=>{delete Navigator.prototype.serviceWorker;navigator.getGamepads=()=>[];});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?test`);
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.evaluate(async()=>{
    const {WorldAudio}=await import('./world-audio.js'),{WorldRenderer}=await import('./world-renderer.js');
    window.__spatial=[];window.__dpose=[];window.__handlers=[];
    const spatial=WorldAudio.prototype.spatial;
    WorldAudio.prototype.spatial=async function(key,bytes,pos,view){
      const r=await spatial.call(this,key,bytes,pos,view),buf=this.spatialBuffers?.get(key);
      let rms=0,duration=0,peak=0;
      if(buf?.getChannelData){const d=buf.getChannelData(0);duration=buf.duration;for(const v of d){rms+=v*v;peak=Math.max(peak,Math.abs(v));}rms=Math.sqrt(rms/d.length);}
      __spatial.push({key,played:r,duration,rms,peak,ctx:this.ctx?.state,t:performance.now()});return r;
    };
    const pose=WorldRenderer.prototype.pose;
    WorldRenderer.prototype.pose=function(data){
      for(const p of data.poses)if(String(p.phase).startsWith('d:')){let h=0;for(let i=0;i<p.vertices.length;i+=7)h=(h*31+Math.round(p.vertices[i]*1000))|0;__dpose.push({id:p.phase.slice(2),h,t:performance.now()});}
      return pose.call(this,data);
    };
  });
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.evaluate(()=>{document.getElementById('welcome').hidden=true;});
  await page.locator('#world').click();
  await page.evaluate(()=>{worldTest.settings({sound:true,creatureCollision:true});
    const r=worldEvidence.info.manifest.regions.find(r=>r.map==='Azeroth');
    worldTest.focus([-650+r.placement[0]+(32-r.tile_origin[0])*1600/3,130,8850+r.placement[1]+(32-r.tile_origin[1])*1600/3,0,-.3]);});
  if(await page.locator('#drive').evaluate(e=>!e.hidden).catch(()=>false)){await page.locator('#drive').evaluate(e=>e.click());}
  await page.locator('#world').focus();
  await page.waitForFunction(()=>worldTest.renderer().moves?.size>5,null,{timeout:120000});
  await page.waitForTimeout(4000);
  await page.evaluate(()=>{let last;setInterval(()=>{const s=worldEvidence.state;if(s!==last&&Number.isFinite(s?.testHandlerMs))__handlers.push(s.testHandlerMs);last=s;},4);});
  const candidates=()=>page.evaluate(()=>{
    const r=worldTest.renderer(),eye=Array.from(worldEvidence.state.telemetry),reg=r.manifest.regions[r.sceneRegion],T=1600/3,R=m=>[-m[13]+reg.placement[0]+(32-reg.tile_origin[0])*T,m[14],-m[12]+reg.placement[1]+(32-reg.tile_origin[1])*T];
    return r.instances.filter(i=>i.id.includes(':npc:')&&!r.deadNpcs?.has(i.id)&&!r.hiddenNpcs?.has(i.id)).map(i=>({id:i.id,path:i.path,render:R(i.matrix)}))
      .sort((a,b)=>Math.hypot(a.render[0]-eye[0],a.render[2]-eye[2])-Math.hypot(b.render[0]-eye[0],b.render[2]-eye[2])).slice(0,60);
  });  const telemetry=()=>page.evaluate(()=>Array.from(worldEvidence.state.telemetry).slice(0,4));
  const fly=async(pose,ms)=>{
    await page.evaluate(p=>worldTest.restore(p),pose);await page.locator('#world').focus();
    await page.keyboard.down('KeyW');await page.keyboard.down('ShiftLeft');
    await page.waitForTimeout(ms);
    const t=await telemetry();await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');return t;
  };
  // Calibrate the yaw convention: heading angle (atan2 of render x/z displacement) = h0 + sign*yaw.
  const origin=(await telemetry()).slice(0,3),probe=async yaw=>{const t=await fly([origin[0],origin[1]+2,origin[2],yaw],1500);return Math.atan2(t[2]-origin[2],t[0]-origin[0]);};
  const h0=await probe(0),h1=await probe(Math.PI/2),wrap=a=>Math.atan2(Math.sin(a),Math.cos(a)),sign=Math.sign(wrap(h1-h0))||1;
  result.calibration={h0,h1,sign};console.log('calibration',JSON.stringify(result.calibration));
  const killed=[];
  const cc=()=>page.evaluate(()=>({events:__cc??[],sounds:__spatial,hold:__dpose.length}));
  for(const [attempt,c0] of (await candidates()).slice(0,40).entries()){
    const target=c0.render,dist=130,approach=Math.random()*Math.PI*2,start=[target[0]+Math.cos(approach)*dist,target[1]+3,target[2]+Math.sin(approach)*dist];
    const want=Math.atan2(target[2]-start[2],target[0]-start[0]),yaw=wrap((want-h0)/sign);
    try{await page.evaluate(p=>worldTest.restore(p),[...start,yaw]);}catch(e){console.log('restore failed',String(e.message).slice(0,60));continue;}await page.locator('#world').focus();
    await page.keyboard.down('KeyW');await page.keyboard.down('ShiftLeft');
    let hit,closest=1e9,vert=0,speed=0;const t0=Date.now();
    while(Date.now()-t0<6000&&!hit){await page.waitForTimeout(100);
      const s=await page.evaluate(id=>({dead:worldTest.renderer().deadNpcs?.has(id),tel:Array.from(worldEvidence.state.telemetry)}),c0.id);hit=s.dead;
      const d=Math.hypot(s.tel[0]-target[0],s.tel[2]-target[2]);if(d<closest){closest=d;vert=s.tel[1]-target[1];}speed=Math.max(speed,Math.hypot(s.tel[4]||0,s.tel[5]||0,s.tel[6]||0));}
    await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');
    const a={attempt,id:c0.id,path:c0.path,hit,closest,vert,speed,ms:Date.now()-t0};result.attempts.push(a);console.log('attempt',JSON.stringify(a));if(false)console.log('diag',JSON.stringify((await page.evaluate(()=>(globalThis.__cc||[]).filter(e=>e.diag).slice(-2).map(e=>e.diag)))));
    if(hit){killed.push({id:c0.id,at:Date.now()});break;}
  }
  assert(killed.length,'no creature was killed in 40 attempts');
  const kill=killed[0];
  await page.waitForTimeout(1500);
  await page.screenshot({path:fileURLToPath(new URL('kill.png',out))});
  // Death clip: pose uploads under d:<id> while dying, then a held last frame (no further uploads) while the corpse stays.
  await page.waitForTimeout(9000);
  const state1=await page.evaluate(id=>({dpose:__dpose.filter(p=>p.id===id)}),kill.id);
  const n1=state1.dpose.length;await page.waitForTimeout(5000);
  const state2=await page.evaluate(id=>({n:__dpose.filter(p=>p.id===id).length,dead:worldTest.renderer().deadNpcs?.has(id)}),kill.id);
  await page.screenshot({path:fileURLToPath(new URL('corpse.png',out))});
  const snap=await cc();
  result.death={id:kill.id,deathPosesPosted:n1,distinctDeathFrames:new Set(state1.dpose.map(p=>p.h)).size,heldDeadAfter14s:state2.dead,postsDuringHold:state2.n-n1,sounds:snap.sounds,soundEvents:snap.events.filter(e=>e.event==='creature-sound'),soundDiag:snap.events.filter(e=>e.diag&&(e.diag.sd||e.diag.sdr)).map(e=>e.diag)};console.log('soundDiag',JSON.stringify(result.death.soundDiag));
  console.log('death',JSON.stringify(result.death));
  // The corpse goes (hidden) then respawns: wait it out in real time.
  let gone,back;const t1=Date.now();
  while(Date.now()-t1<170000&&!back){await page.waitForTimeout(1000);
    const s=await page.evaluate(id=>({dead:worldTest.renderer().deadNpcs?.has(id),hidden:worldTest.renderer().hiddenNpcs?.has(id)}),kill.id);
    if(s.hidden&&!gone)gone=(Date.now()-kill.at)/1000;
    if(gone&&!s.hidden&&!s.dead)back=(Date.now()-kill.at)/1000;}
  result.respawn={goneAtS:gone,backAtS:back};console.log('respawn',JSON.stringify(result.respawn));
  await page.screenshot({path:fileURLToPath(new URL('respawn.png',out))});
  const h=await page.evaluate(()=>__handlers);
  result.handler={frames:h.length,p50:pct(h,.5),p95:pct(h,.95),p99:pct(h,.99),max:Math.max(...h)};
  result.pageErrors=await page.evaluate(()=>worldEvidence.errors);
  console.log('handler',JSON.stringify(result.handler),'errors',JSON.stringify(errors),JSON.stringify(result.pageErrors));
  assert(n1>1&&result.death.distinctDeathFrames>1,'death clip did not animate');
  assert.equal(result.death.postsDuringHold,0,'corpse pose was re-posted during hold');
  assert(state2.dead,'corpse not held');
  assert(result.death.sounds.some(s=>s.played&&s.duration>0&&s.rms>.003),'no audible spatial death sound');
  assert(gone&&back,'creature did not go and respawn');
  assert(result.handler.p99<=20,`handler p99 ${result.handler.p99}`);
  assert.deepEqual([...errors,...result.pageErrors],[]);
}catch(e){result.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));await browser.close();server.close();release();}
