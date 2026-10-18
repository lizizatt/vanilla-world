import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const out=new URL('./test-results/audio/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
try {
  const page=await browser.newPage();
  await page.goto(`${process.env.BASE_URL || 'http://127.0.0.1:4173'}/world-audio.js`);
  await page.evaluate(()=>navigator.serviceWorker.register('./sw.js').then(()=>{}));
  await page.waitForFunction(()=>navigator.serviceWorker.controller,{},{timeout:30000});
  const offlineShell=await page.evaluate(async()=>(await caches.keys()).filter(key=>key.startsWith('racer-shell-')));
  assert.equal(offlineShell.length,1);
  await page.context().setOffline(true);
  const result=await page.evaluate(async()=>{
    const {WorldAudio}=await import('./world-audio.js');
    const rate=24000,seconds=28,context=new OfflineAudioContext(2,rate*seconds,rate);
    let now=0;
    const original=globalThis.AudioContext;
    globalThis.AudioContext=function(){
      return {get currentTime(){return now;},state:'running',destination:context.destination,
        createGain:()=>context.createGain(),createAnalyser:()=>context.createAnalyser(),
        createBuffer:(...args)=>context.createBuffer(...args),createBufferSource:()=>context.createBufferSource(),
        createBiquadFilter:()=>context.createBiquadFilter(),resume:async()=>{},suspend:async()=>{}};
    };
    const audio=new WorldAudio(),started=performance.now();
    await audio.enable();
    const setupMs=performance.now()-started,voices=audio.voices.slice();
    const telemetry=new Float64Array(15),state={telemetry,scene:{waitingCollision:0}},input={throttle:0,flags:0};
    const updateMs=[],envelopes=[];
    for(let frame=0;frame<seconds*60;frame++) {
      now=frame/60;input.throttle=0;input.flags=0;
      telemetry[5]=0;telemetry[6]=1;telemetry[7]=1;telemetry[8]=0;telemetry[9]=0;
      if(now>=2 && now<5){input.throttle=1;telemetry[5]=(now-2)*20;}
      if(now>=5 && now<8){input.throttle=.4;telemetry[5]=60;}
      if(now>=8 && now<11){input.throttle=1;input.flags=2;telemetry[5]=90;}
      if(now>=11 && now<13){telemetry[5]=80;telemetry[9]=1;}
      if(now>=13 && now<14){telemetry[5]=60;telemetry[7]=0;}
      if(now>=14 && now<16)telemetry[5]=50;
      if(now>=16 && now<18){input.flags=1;telemetry[5]=(18-now)*25;}
      if(now>=18 && now<20){input.throttle=1;input.flags=2;telemetry[5]=60;telemetry[8]=1;}
      if(now>=24 && now<26){input.throttle=1;telemetry[5]=40;}
      if(frame===26*60){audio.mute();clearTimeout(audio.release);}
      const start=performance.now();
      audio.update(state,input,1/60,!(now>=20 && now<22));
      updateMs.push(performance.now()-start);
      if(frame%60===0)envelopes.push({time:now,layers:audio.envelope.layers.map(layer=>layer.slice())});
    }
    const reused=audio.voices.every((voice,i)=>voice===voices[i]);
    globalThis.AudioContext=original;
    const rendered=await context.startRendering(),left=rendered.getChannelData(0),right=rendered.getChannelData(1);
    const windows=[];
    for(let second=0;second<seconds;second++) {
      let sum=0,peak=0,step=0,stereo=0;
      for(let i=second*rate;i<(second+1)*rate;i++){
        sum+=left[i]*left[i]+right[i]*right[i];
        peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));
        if(i)step=Math.max(step,Math.abs(left[i]-left[i-1]),Math.abs(right[i]-right[i-1]));
        stereo+=(left[i]-right[i])**2;
      }
      windows.push({second,rms:Math.sqrt(sum/(2*rate)),peak,maxStep:step,stereoRms:Math.sqrt(stereo/rate)});
    }
    // Windowed DFT: report energy by band and the strongest tonal bin, not perceived quality.
    const spectra=[];
    for(const second of [1,7,10,12,13,15,19]) {
      let total=0,low=0,high=0,largest=0,frequency=0;
      const size=4096,start=second*rate;
      for(let bin=1;bin<=size/2;bin++){
        let re=0,im=0;
        for(let i=0;i<size;i++){
          const sample=left[start+i]*(.5-.5*Math.cos(2*Math.PI*i/(size-1))),angle=2*Math.PI*bin*i/size;
          re+=sample*Math.cos(angle);im-=sample*Math.sin(angle);
        }
        const energy=re*re+im*im,hz=bin*rate/size;
        total+=energy;if(hz<250)low+=energy;if(hz>4000)high+=energy;
        if(energy>largest){largest=energy;frequency=hz;}
      }
      spectra.push({second,lowFraction:low/total,above4kFraction:high/total,strongestHz:frequency});
    }
    const wav=new ArrayBuffer(44+left.length*4),view=new DataView(wav);
    const text=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
    text(0,'RIFF');view.setUint32(4,wav.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);
    view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);view.setUint16(32,4,true);
    view.setUint16(34,16,true);text(36,'data');view.setUint32(40,left.length*4,true);
    for(let i=0;i<left.length;i++){
      view.setInt16(44+i*4,Math.round(left[i]*32767),true);
      view.setInt16(46+i*4,Math.round(right[i]*32767),true);
    }
    let encoded='';
    const bytes=new Uint8Array(wav);
    for(let i=0;i<bytes.length;i+=8192)encoded+=String.fromCharCode(...bytes.subarray(i,i+8192));
    updateMs.sort((a,b)=>a-b);
    return {wav:btoa(encoded),setupMs,updateP99Ms:updateMs[Math.floor(updateMs.length*.99)],
      updateMaxMs:updateMs.at(-1),voices:audio.voices.length,reused,windows,spectra,envelopes};
  });
  await page.mouse.click(40,40);
  await page.evaluate(async()=>{
    const {WorldAudio}=await import('./world-audio.js');
    window.audioProbe=new WorldAudio();window.audioProbeActive=true;
    const telemetry=new Float64Array(15);telemetry[5]=60;telemetry[6]=1;telemetry[7]=1;
    const state={telemetry,scene:{waitingCollision:0}},input={throttle:1,flags:2};
    await audioProbe.enable();
    window.originalVoices=audioProbe.voices.slice();
    window.audioUpdates=[];
    let last=performance.now();
    window.audioTick=setInterval(()=>{
      const now=performance.now();
      audioProbe.update(state,input,(now-last)/1000,audioProbeActive);
      audioUpdates.push(performance.now()-now);last=now;
    },16);
    window.audioSample=()=>{
      const samples=new Float32Array(audioProbe.analyser.fftSize);
      audioProbe.analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);
    };
  });
  await page.waitForFunction(()=>audioProbe.context.state==='running' && audioSample()>.005);
  const runningRms=await page.evaluate(()=>audioSample());
  await page.evaluate(()=>{audioProbeActive=false;});
  await page.waitForFunction(()=>audioSample()<.00001);
  await page.evaluate(()=>{audioProbeActive=true;});
  await page.waitForFunction(()=>audioSample()>.005);
  await page.evaluate(()=>audioProbe.mute());
  await page.waitForFunction(()=>!audioProbe.enabled && audioProbe.context.state==='suspended');
  await page.mouse.click(40,40);
  await page.evaluate(()=>audioProbe.enable());
  await page.waitForFunction(()=>audioProbe.enabled && audioProbe.context.state==='running' && audioSample()>.005);
  result.realTime=await page.evaluate(async()=>{
    const reused=audioProbe.voices.length===3 && audioProbe.voices.every((voice,i)=>voice===originalVoices[i]);
    const rms=audioSample(),updates=audioUpdates.sort((a,b)=>a-b);
    clearInterval(audioTick);audioProbe.mute();clearTimeout(audioProbe.release);
    await audioProbe.context.close();
    return {reused,resumedRms:rms,updates:updates.length,updateP99Ms:updates[Math.floor(updates.length*.99)],
      updateMaxMs:updates.at(-1),closed:audioProbe.context.state==='closed'};
  });
  result.realTime.runningRms=runningRms;
  await writeFile(new URL('hover-racer.wav',out),Buffer.from(result.wav,'base64'));
  delete result.wav;
  result.offlineShell=offlineShell[0];
  await writeFile(new URL('evidence.json',out),JSON.stringify(result,null,2));
  assert.equal(result.voices,3);assert(result.reused);
  assert(result.realTime.reused && result.realTime.closed);
  assert(result.realTime.runningRms>.005 && result.realTime.resumedRms>.005);
  assert(result.realTime.updateP99Ms<1);
  assert(result.windows.every(w=>Number.isFinite(w.rms) && w.peak<.3 && w.maxStep<.06));
  assert(result.windows[1].rms>.005);
  assert(result.windows[10].rms>result.windows[7].rms);
  assert(result.windows[19].rms<result.windows[10].rms*.8);
  assert(result.windows[21].rms<.00001 && result.windows[27].rms<.00001);
  assert(result.windows[7].stereoRms>.001);
  assert(result.spectra.every(s=>s.above4kFraction<.01 && s.strongestHz<150));
  assert(result.updateP99Ms<1);
  console.log(JSON.stringify({setupMs:result.setupMs,updateP99Ms:result.updateP99Ms,
    updateMaxMs:result.updateMaxMs,peak:Math.max(...result.windows.map(w=>w.peak)),
    idleRms:result.windows[1].rms,cruiseRms:result.windows[7].rms,boostRms:result.windows[10].rms,
    heldRms:result.windows[19].rms,offlineShell:result.offlineShell,realTime:result.realTime,
    audition:'Captured only; not listened to'},null,2));
} finally {await browser.close();}
