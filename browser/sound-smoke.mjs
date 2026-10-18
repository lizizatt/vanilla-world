import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

assert(process.env.WOW_DATA,'Set WOW_DATA to your local Classic Data folder');
const baseline=process.env.EXPECT_SUSPEND_BUG==='1';
const output=new URL(`./test-results/sound-onboarding/${baseline?'before':'after'}/`,import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,
  ignoreDefaultArgs:['--mute-audio','--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({viewport:{width:1280,height:800}});
await context.addInitScript(()=>{
  const Native=AudioContext;
  window.soundProbe={contexts:[],sources:0,analysers:[],connections:[]};
  window.AudioContext=new Proxy(Native,{construct(target,args){
    const audio=Reflect.construct(target,args);
    soundProbe.contexts.push(audio);
    const source=audio.createBufferSource.bind(audio),analyse=audio.createAnalyser.bind(audio);
    audio.createBufferSource=()=>{soundProbe.sources++;return source();};
    audio.createAnalyser=()=>{const node=analyse();soundProbe.analysers.push(node);return node;};
    return audio;
  }});
  const connect=AudioNode.prototype.connect;
  AudioNode.prototype.connect=function(destination,...args){
    soundProbe.connections.push([this.constructor.name,destination.constructor.name]);
    return connect.call(this,destination,...args);
  };
  window.readSound=()=>{
    const analyser=soundProbe.analysers.at(-1),samples=new Float32Array(analyser?.fftSize||0);
    analyser?.getFloatTimeDomainData(samples);
    return {audio:window.worldEvidence?.audio,contexts:soundProbe.contexts.length,sources:soundProbe.sources,
      state:soundProbe.contexts.at(-1)?.state||'off',samples:Array.from(samples),
      rms:samples.length?Math.sqrt(samples.reduce((n,x)=>n+x*x,0)/samples.length):0,
      visible:document.visibilityState,focused:document.hasFocus(),activeElement:document.activeElement?.id,
      userActivated:navigator.userActivation.hasBeenActive,connections:soundProbe.connections};
  };
});
const page=await context.newPage(),captures={},errors=[],consoleErrors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
const ready=async()=>{
  await page.waitForFunction(()=>!document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:180000});
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
};
const signal=()=>page.waitForFunction(()=>readSound().state==='running'&&readSound().rms>.001,null,{timeout:10000});
try {
  const session=await browser.newBrowserCDPSession();
  const {arguments:launchArguments}=await session.send('Browser.getBrowserCommandLine');await session.detach();
  assert(!launchArguments.includes('--mute-audio'));
  assert(!launchArguments.includes('--autoplay-policy=no-user-gesture-required'));
  await page.goto(process.env.BASE_URL||'http://127.0.0.1:4183/');
  await ready();
  captures.before=await page.evaluate(()=>readSound());
  assert.equal(captures.before.contexts,0);
  if(!await page.locator('#sound').isVisible())await page.locator('#preferences > summary').click();
  await page.locator('#sound').check();await signal();
  captures.enabled=await page.evaluate(()=>readSound());
  assert.equal(captures.enabled.sources,3);
  assert(captures.enabled.userActivated);
  assert(captures.enabled.connections.some(([from,to])=>from==='AnalyserNode'&&to==='AudioDestinationNode'));
  await page.locator('#preferences > summary').click();await page.waitForTimeout(700);
  captures.settings=await page.evaluate(()=>readSound());
  if(baseline)assert(captures.settings.rms<.001,'Baseline loses sound on ordinary settings focus');
  else assert(captures.settings.rms>.001,'Settings focus must not silence the foreground engine');
  await page.locator('#world').click();await signal();
  // Induce a real context suspension, but recovery must use the application's trusted-click path.
  await page.evaluate(()=>soundProbe.contexts.at(-1).suspend());
  captures.suspended=await page.evaluate(()=>readSound());
  await page.locator('#world').click();await page.waitForTimeout(700);
  captures.recovered=await page.evaluate(()=>readSound());
  if(baseline)assert.equal(captures.recovered.state,'suspended','Baseline refuses resume while enabled remains true');
  else {
    await signal();captures.recovered=await page.evaluate(()=>readSound());
    assert.equal(captures.recovered.sources,3);
    await page.evaluate(()=>soundProbe.contexts.at(-1).suspend());
    await page.locator('#resume-sound').click();await signal();
    await page.evaluate(async()=>{
      const audio=soundProbe.contexts.at(-1);await audio.suspend();
      const resume=audio.resume.bind(audio);
      audio.resume=()=>{audio.resume=resume;return Promise.reject(new Error('Injected resume failure'));};
    });
    await page.locator('#resume-sound').click();
    await page.waitForFunction(()=>document.getElementById('sound-status').textContent.includes('Injected resume failure'));
    assert(await page.locator('#sound').isChecked(),'A failed resume must preserve sound intent');
    captures.failedResume=await page.evaluate(()=>readSound());
    await page.locator('#resume-sound').click();await signal();
    await page.evaluate(async()=>{
      const audio=soundProbe.contexts.at(-1);await audio.suspend();
      const resume=audio.resume.bind(audio);
      audio.resume=()=>{audio.resume=resume;return new Promise((resolve,reject)=>{soundProbe.rejectPending=reject;});};
    });
    await page.locator('#resume-sound').click();
    await page.locator('#world').click();await signal();
    await page.evaluate(()=>soundProbe.rejectPending(new Error('Stale resume failure')));
    await page.waitForTimeout(400);
    captures.retriedPending=await page.evaluate(()=>readSound());
    assert.equal(captures.retriedPending.audio.error,'');
    assert.equal(captures.retriedPending.sources,3);
    assert(await page.locator('#sound').isChecked());
    const other=await context.newPage();
    await other.bringToFront();await page.waitForTimeout(700);
    captures.tabSwitch=await page.evaluate(()=>readSound());
    const syntheticFocus=captures.tabSwitch.focused && captures.tabSwitch.visible!=='hidden';
    if(syntheticFocus)await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await page.waitForFunction(()=>readSound().state==='suspended');
    captures.backgrounded=await page.evaluate(()=>readSound());
    assert.equal(captures.backgrounded.state,'suspended');
    await page.bringToFront();
    if(syntheticFocus)await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await signal();await other.close();
    captures.focusReturn=await page.evaluate(()=>readSound());
    captures.focusReturn.method=syntheticFocus?'Injected window blur/focus: headless tabs remained focused/visible':'Actual tab activation';
    assert.equal(captures.focusReturn.sources,3);
    await page.locator('#fly').click();await page.waitForTimeout(700);
    captures.flight=await page.evaluate(()=>readSound());
    assert(captures.flight.rms<.001);
    await page.locator('#drive').click();await signal();
    await page.locator('#sound').uncheck();
    await page.waitForFunction(()=>readSound().state==='suspended');
    await page.locator('#world').click();await page.waitForTimeout(300);
    captures.muted=await page.evaluate(()=>readSound());
    assert.equal(captures.muted.state,'suspended');
    await page.locator('#save').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Saved'));
    await page.locator('#sound').check();await signal();
    await page.locator('#load').click();
    await page.waitForFunction(()=>readSound().state==='suspended');
    assert(!await page.locator('#sound').isChecked());
    captures.loadedMute=await page.evaluate(()=>readSound());
    await page.reload();await ready();
    await page.locator('#world').click();await page.waitForTimeout(300);
    captures.savedMute=await page.evaluate(()=>readSound());
    assert.equal(captures.savedMute.contexts,0);assert(!await page.locator('#sound').isChecked());
    await page.locator('#sound').check();await signal();
    await page.locator('#save').click();
    await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Saved'));
    await page.reload();await ready();
    assert(await page.locator('#sound').isChecked());
    await page.locator('#resume-sound').click();await signal();
    captures.savedEnabled=await page.evaluate(()=>readSound());
    assert.equal(captures.savedEnabled.sources,3);
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(consoleErrors.filter(message=>!message.includes('Injected resume failure')),[]);
  assert.equal(consoleErrors.length,baseline?0:1);
  await page.screenshot({path:fileURLToPath(new URL('view.png',output))});
  await writeFile(new URL('evidence.json',output),JSON.stringify({baseline,launchArguments,captures,errors,consoleErrors},null,2));
  console.log(JSON.stringify({baseline,captures:Object.fromEntries(Object.entries(captures).map(([k,v])=>[k,{...v,samples:undefined,connections:undefined}])),errors},null,2));
} catch(error) {
  await writeFile(new URL('failure.json',output),JSON.stringify({message:error.message,captures,errors,consoleErrors},null,2));
  throw error;
} finally {await context.close();await browser.close();}
