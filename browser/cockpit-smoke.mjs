import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {craftMatrix} from './world-camera.js';

assert(process.env.WOW_DATA,'Set WOW_DATA to your local Classic Data folder');
const output=new URL('./test-results/cockpit/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,
  args:['--mute-audio'],ignoreDefaultArgs:['--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({viewport:{width:676,height:1315}});
await context.addInitScript(()=>{
  window.testPads=[];
  Object.defineProperty(navigator,'getGamepads',{value:()=>testPads});
  const Native=AudioContext;
  window.audioContexts=[];
  window.AudioContext=new Proxy(Native,{construct(target,args){
    const audio=Reflect.construct(target,args);audioContexts.push(audio);return audio;
  }});
});
const page=await context.newPage(),evidence={poses:{},reverse:{},cameraFrames:[],errors:[]};
page.on('pageerror',error=>evidence.errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')evidence.errors.push(message.text());});
const ready=async()=>{
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.evaluate(async()=>{
    const {WorldRenderer}=await import('./world-renderer.js'),draw=WorldRenderer.prototype.draw;
    const {craftMatrix}=await import('./world-camera.js');
    window.cameraFrames=[];window.cameraPhase='cold';
    WorldRenderer.prototype.draw=function(...args){
      const clip=this.clipCamera;
      if(window.clearanceFixture)this.clipCamera=(pivot)=>{
        this.cameraCollisionReady=clearanceFixture==='geometry';return pivot;
      };
      if(window.jitterFixture){
        args[0]=args[0].slice();
        args[0][1]+=.15*Math.sin((performance.now()-jitterFixture)*Math.PI*16/1000);
        args[0][7]=1;args[0][8]=0;
      }
      let stats;
      try {stats=draw.apply(this,args);} finally {this.clipCamera=clip;}
      window.cockpitProbe={rig:this,state:Array.from(args[0]),stats};
      const p=args[0],record={phase:cameraPhase,t:performance.now(),dt:args[2],mode:this.cameraMode,
        p:Array.from(p),eye:this.camera.slice(),origin:this.origin.slice(),blocked:this.cameraBlocked,
        worldDraws:stats.worldDraws,ready:this.cameraCollisionReady,focus:document.hasFocus(),hidden:document.hidden};
      if(this.cameraMode==='cockpit'){
        const m=craftMatrix(p,this.origin,this.craft.metadata.scale),a=this.craft.anchor;
        record.seatError=Math.hypot(...this.camera.map((n,i)=>n-(m[12+i]+m[i]*a[0]+m[4+i]*a[1]+m[8+i]*a[2])));
      } else if(this.cameraMode==='chase'){
        const heading=p[3]+(args[5]?Math.PI:0)+this.chase[0],pitch=this.chase[1],d=Math.max(0,(args[4].cameraDistance??15)-.15);
        const expected=[p[0]-this.origin[0]+Math.sin(heading)*Math.cos(pitch)*d,
          p[1]+3-Math.sin(pitch)*d+this.chaseBounce,p[2]-this.origin[1]+Math.cos(heading)*Math.cos(pitch)*d];
        record.chaseError=Math.hypot(...this.camera.map((n,i)=>n-expected[i]));
        record.radius=this.chaseDistance;record.bounce=this.chaseBounce;
      }
      if(cameraFrames.length<12000)cameraFrames.push(record);
      return stats;
    };
  });
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  await page.waitForFunction(()=>worldEvidence.render?.craftReady&&worldEvidence.render?.cockpitAvailable
    &&worldEvidence.state.scene.waitingCollision===0,null,{timeout:120000});
};
const retainFrames=async()=>evidence.cameraFrames.push(...await page.evaluate(()=>cameraFrames));
const settled=()=>page.waitForFunction(()=>worldEvidence.state.telemetry[7]===1
  &&worldEvidence.state.telemetry[8]===0&&worldEvidence.state.scene.waitingCollision===0,null,{timeout:20000});
const reset=async()=>{
  await page.locator('#world').focus();await page.keyboard.press('F9');
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Reset. Save unchanged.');
  await settled();
  await page.waitForFunction(()=>worldEvidence.state.telemetry[5]<.01);
};
const cockpit=()=>page.waitForFunction(()=>worldEvidence.cockpit.active&&window.cockpitProbe?.rig.cameraMode==='cockpit');
const capture=async name=>{
  await cockpit();
  const value=await page.evaluate(()=>{
    const {rig,state,stats}=cockpitProbe;
    return {state,eye:rig.camera.slice(),look:rig.cameraLook.slice(),origin:rig.origin.slice(),
      anchor:rig.craft.anchor.slice(),metadata:rig.craft.metadata,stats,
      viewport:[innerWidth,innerHeight],backing:[rig.canvas.width,rig.canvas.height],dpr:devicePixelRatio};
  });
  const matrix=craftMatrix(value.state,value.origin,value.metadata.scale);
  const expected=[0,1,2].map(i=>matrix[12+i]+matrix[i]*value.anchor[0]+matrix[4+i]*value.anchor[1]+matrix[8+i]*value.anchor[2]);
  value.eyeError=Math.hypot(...value.eye.map((n,i)=>n-expected[i]));
  assert(value.eyeError<.0001,`${name}: eye must follow the rendered craft seat, without velocity lag`);
  assert.equal(value.stats.craftDraws,0,'Self geometry is hidden, not a scene-wide clipping workaround');
  assert(value.stats.detailedTiles>0||value.stats.horizonTiles>0||value.stats.sceneDraws>0,'World remains resident');
  evidence.poses[name]=value;
  return value;
};
const reverse=async(name,controllerActive=false)=>{
  await reset();
  const before=await page.evaluate(()=>worldEvidence.state.telemetry.slice());
  await page.keyboard.down('KeyS');
  await page.waitForFunction(()=>worldEvidence.input.throttle===-1&&!(worldEvidence.input.flags&1)
    &&worldEvidence.state.telemetry[14]<-1);
  await page.waitForFunction(p=>{
    const t=worldEvidence.state.telemetry;
    return -(t[0]-p[0])*Math.sin(p[3])-(t[2]-p[2])*Math.cos(p[3])<-1;
  },before);
  const after=await page.evaluate(()=>({state:worldEvidence.state.telemetry.slice(),input:worldEvidence.input}));
  evidence.reverse[name]={before,after,backwardDistance:
    -(after.state[0]-before[0])*Math.sin(before[3])-(after.state[2]-before[2])*Math.cos(before[3])};
  if(await page.evaluate(()=>worldEvidence.cockpit.active))await capture(`reverse-${name}`);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>worldEvidence.input.throttle===0&&!(worldEvidence.input.flags&1));
  await page.keyboard.up('KeyW');await page.keyboard.up('KeyS');
  await page.waitForFunction(active=>active?worldEvidence.input.device==='controller':
    worldEvidence.input.throttle===0,controllerActive);
  await page.keyboard.down('KeyX');
  await page.waitForFunction(()=>worldEvidence.input.flags===1&&worldEvidence.state.telemetry[5]<.3);
  await page.keyboard.up('KeyX');
};
const save=async()=>{
  await page.locator('#save').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Saved.');
};
const padButton=async(index,active)=>{
  await page.evaluate(i=>{testPads[0].buttons[i]={pressed:true,value:1};},index);
  await page.waitForFunction(active=>worldEvidence.cockpit.active===active,active);
  await page.evaluate(i=>{testPads[0].buttons[i]={pressed:false,value:0};},index);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
};
try {
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:4183/');
  await ready();await settled();
  assert.equal(await page.evaluate(()=>typeof worldTest),'undefined','Normal app route, not test-only input controls');
  await page.locator('#world').focus();await page.keyboard.press('KeyF');await cockpit();
  await page.waitForFunction(()=>worldEvidence.render.texturedTerrainTiles>0,null,{timeout:120000});
  await capture('parked');
  await page.screenshot({path:fileURLToPath(new URL('cockpit-raceway.png',output))});
  await reverse('native');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>worldEvidence.state.telemetry[14]>3);await capture('forward');
  for(const reason of ['pending','geometry']){
    await page.evaluate(reason=>{window.clearanceFixture=reason;cameraPhase=`blocked-${reason}`;},reason);
    await page.waitForFunction(reason=>worldEvidence.render.cameraBlocked===reason,reason);
    await page.waitForTimeout(200);
    const blocked=await capture(`blocked-${reason}`);
    assert.equal(blocked.stats.worldDraws,0);
    assert(await page.locator('#camera-blocked').isVisible());
    assert(await page.locator('#fly').isEnabled());
    const png=await page.screenshot({path:fileURLToPath(new URL(`blocked-${reason}.png`,output))});
    assert(await page.evaluate(async encoded=>{
      const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/png'}));
      const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');
      ctx.drawImage(image,0,0);image.close();
      const pixels=ctx.getImageData(Math.floor(canvas.width*.85),Math.floor(canvas.height*.3),1,Math.floor(canvas.height*.45)).data;
      return pixels.every((n,i)=>n===pixels[i%4]);
    },png.toString('base64')),'Blocked frame freshly clears the world');
  }
  await page.evaluate(()=>{window.clearanceFixture=undefined;cameraPhase='recovery';});
  await page.waitForFunction(()=>!worldEvidence.render.cameraBlocked&&worldEvidence.render.worldDraws>0);
  await capture('blocked-recovery');
  await page.keyboard.down('KeyA');
  await page.waitForFunction(()=>Math.abs(worldEvidence.state.telemetry[4])>.01);await capture('turn');
  await page.keyboard.up('KeyA');await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(()=>worldEvidence.input.flags&2);await capture('boost');
  await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');
  await reset();await capture('reset');
  const straight=await capture('straight');
  await page.keyboard.down('KeyV');
  await page.waitForFunction(look=>cockpitProbe.rig.cameraLook.reduce((n,v,i)=>n+v*look[i],0)<-.95,straight.look);
  await capture('look-back');await page.keyboard.up('KeyV');
  await page.keyboard.down('ArrowRight');await page.waitForTimeout(300);
  await capture('orbit');await page.keyboard.up('ArrowRight');
  await page.locator('#sound').check();
  await page.waitForFunction(()=>worldEvidence.audio?.state==='running'&&worldEvidence.audio.voices===3);
  await page.locator('#fly').click();await page.waitForFunction(()=>worldEvidence.mode==='fly');
  await page.locator('#world').focus();await page.keyboard.press('KeyF');await cockpit();
  await capture('return-from-flight');
  await page.evaluate(()=>audioContexts.at(-1).suspend());
  await page.locator('#world').click();
  await page.waitForFunction(()=>worldEvidence.audio.state==='running');
  await page.locator('#sound').uncheck();
  await page.waitForFunction(()=>!worldEvidence.audio.enabled);
  await page.mouse.move(338,1200);await page.mouse.wheel(0,100);
  await page.waitForFunction(()=>!worldEvidence.cockpit.requested&&worldEvidence.render.craftDraws>0);
  await page.locator('#preferences > summary').click();
  await page.locator('#cockpit').click();await cockpit();
  await page.locator('#camera-distance').focus();await page.keyboard.down('KeyS');
  await page.waitForFunction(()=>worldEvidence.input.throttle===0);
  await page.keyboard.up('KeyS');
  await page.locator('#preferences > summary').click();await page.locator('#world').focus();
  await page.evaluate(()=>{testPads=[{connected:true,mapping:'standard',index:0,axes:[0,0,0,0],
    buttons:Array.from({length:17},()=>({pressed:false,value:0}))}];});
  await page.keyboard.down('KeyW');
  await padButton(11,false);
  await padButton(11,true);await cockpit();
  evidence.mixedInputCockpit=await page.evaluate(()=>({...worldEvidence.input}));
  assert.equal(evidence.mixedInputCockpit.throttle,1);
  assert.equal(evidence.mixedInputCockpit.device,'keyboard');
  await page.keyboard.up('KeyW');
  await page.evaluate(()=>{window.padNoise=setInterval(()=>{
    testPads[0].axes[0]=testPads[0].axes[0]>.4?.2:.8;testPads[0].buttons[7].value=.6;
  },50);});
  await reverse('controller-connected',true);
  await page.evaluate(()=>{clearInterval(padNoise);testPads=[];});
  await save();
  await retainFrames();await context.setOffline(true);await page.reload();await ready();await cockpit();
  assert.equal(await page.locator('#control-profile').inputValue(),'native');
  assert(!await page.locator('#sound').isChecked());
  await reverse('native-offline-reload');
  await save();
  await page.evaluate(async()=>{
    const {worldSave}=await import('./world-store.js'),id=worldEvidence.info.id,record=await worldSave(id);
    delete record.settings.controls;await worldSave(id,record);
  });
  await retainFrames();await page.reload();await ready();await cockpit();
  assert.equal(await page.locator('#control-profile').inputValue(),'legacy');
  await reverse('legacy-offline-reload');
  await save();
  await page.evaluate(async()=>{
    const {worldSave}=await import('./world-store.js'),id=worldEvidence.info.id,record=await worldSave(id),m=worldEvidence.info.manifest;
    record.vehicle=[(m.ocean[0]+m.ocean[2])/2,m.sea_level+1.1,(m.ocean[1]+m.ocean[3])/2,0];
    await worldSave(id,record);
  });
  await page.locator('#load').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Loaded.');
  await settled();await cockpit();
  const rebases=await page.evaluate(()=>worldEvidence.state.telemetry[13]);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(count=>worldEvidence.state.telemetry[13]>count,rebases,{timeout:30000});
  await capture('actual-origin-rebase');await page.keyboard.up('KeyW');
  await page.setViewportSize({width:1280,height:800});
  await page.waitForFunction(()=>document.getElementById('world').width===1280&&document.getElementById('world').height===800);
  await capture('landscape-resize');
  await page.screenshot({path:fileURLToPath(new URL('cockpit-ocean.png',output))});
  await page.locator('#preferences > summary').click();await page.locator('#tuning').click();
  for(const [i,value] of [[0,500],[1,500],[2,2000]])await page.locator(`#tune-${i}`).fill(String(value));
  await page.locator('#tuning-form button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('tuning-status').textContent==='Saved.');
  await page.locator('#tuning-close').click();
  await page.locator('#preferences > summary').click();
  await page.locator('#world').focus();await page.keyboard.press('KeyF');
  await page.evaluate(()=>{cameraPhase='chase-500';});
  await page.keyboard.down('KeyW');
  await page.waitForFunction(()=>worldEvidence.state.telemetry[14]>499);
  await page.keyboard.down('KeyA');await page.waitForTimeout(700);
  await page.keyboard.up('KeyA');await page.keyboard.up('KeyW');
  await page.locator('#load').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Loaded.');
  await page.locator('#world').focus();await page.keyboard.press('KeyF');
  await page.evaluate(()=>{cameraPhase='chase-reverse';});
  await page.keyboard.down('KeyS');await page.waitForTimeout(700);await page.keyboard.up('KeyS');
  await page.locator('#load').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Loaded.');
  await page.locator('#world').focus();await page.keyboard.press('KeyF');
  await page.evaluate(()=>{cameraPhase='calibrated-vertical-jitter';window.jitterFixture=performance.now();});
  await page.waitForTimeout(2000);
  await page.evaluate(()=>{window.jitterFixture=undefined;});
  await retainFrames();
  const seats=evidence.cameraFrames.filter(f=>f.mode==='cockpit'),chase=evidence.cameraFrames.filter(f=>f.mode==='chase'&&f.phase.startsWith('chase-'));
  evidence.maxSeatError=Math.max(...seats.map(f=>f.seatError));
  evidence.maxChaseOffsetError=Math.max(...chase.map(f=>f.chaseError));
  assert(evidence.maxSeatError<.0001);
  assert(chase.length>30&&chase.some(f=>f.p[14]>499)&&chase.some(f=>f.p[14]<-5));
  assert(evidence.maxChaseOffsetError<.0001);
  const jitter=evidence.cameraFrames.filter(f=>f.phase==='calibrated-vertical-jitter').slice(30);
  const range=a=>Math.max(...a)-Math.min(...a);
  evidence.jitter={inputRange:range(jitter.map(f=>f.p[1])),cameraRange:range(jitter.map(f=>f.eye[1])),
    fixture:'Render-only +/-0.15-yard 8 Hz grounded displacement; authoritative physics unchanged'};
  assert(jitter.length>30&&evidence.jitter.inputRange>.25&&evidence.jitter.cameraRange<evidence.jitter.inputRange*.35);
  for(const reason of ['pending','geometry']){
    const frames=seats.filter(f=>f.blocked===reason&&f.phase===`blocked-${reason}`);
    assert(frames.length>3&&frames.every(f=>f.worldDraws===0));
    assert(Math.hypot(frames.at(-1).p[0]-frames[0].p[0],frames.at(-1).p[2]-frames[0].p[2])>.1,'Exact blocked seat keeps moving with the craft');
  }
  evidence.blockedFixture='Injected clearance classifications exercise the actual GPU clear/recover policy; not claims of physical obstruction';
  assert.deepEqual(evidence.errors,[]);
  evidence.browser=browser.version();
  evidence.controller='Synthetic standard Gamepad readings through navigator.getGamepads; no physical controller claim';
  await writeFile(new URL('evidence.json',output),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({browser:evidence.browser,poses:Object.keys(evidence.poses),
    reverse:evidence.reverse,errors:evidence.errors},null,2));
} catch(error) {
  evidence.failure=error.stack;
  evidence.final=await page.evaluate(()=>({input:worldEvidence.input,cockpit:worldEvidence.cockpit,
    state:worldEvidence.state,active:document.activeElement?.id,status:document.getElementById('status').textContent}));
  await writeFile(new URL('failure.json',output),JSON.stringify(evidence,null,2));
  await page.screenshot({path:fileURLToPath(new URL('failure.png',output))});
  throw error;
} finally {await browser.close();}
