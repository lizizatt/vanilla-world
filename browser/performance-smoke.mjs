import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';

assert(process.env.WOW_DATA, 'Set WOW_DATA to your read-only Classic Data folder');
const seconds = Number(process.env.DRIVE_SECONDS || 40);
assert(Number.isFinite(seconds) && seconds >= 40, 'Sample at least 40 seconds to verify 30 seconds of sustained driving');
const url = process.env.WORLD_URL || 'http://127.0.0.1:4173/?test';
const out = new URL(`./test-results/performance/${process.env.RUN_LABEL || 'run'}.json`, import.meta.url);
await mkdir(new URL('.', out), {recursive: true});
const browser = await chromium.launch({channel: 'msedge', headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [], results = [];
page.on('pageerror', e => errors.push(e.message));
const distribution = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a-b);
  const percentile = p => sorted[Math.min(sorted.length-1, Math.floor(p*sorted.length))];
  return {count: values.length, median: percentile(.5), p95: percentile(.95),
    p99: percentile(.99), max: sorted.at(-1)};
};
const startup = async () => {
  const start = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById('select').disabled);
  await page.locator('#files').setInputFiles(process.env.WOW_DATA);
  await page.waitForFunction(() => worldEvidence.ready || worldEvidence.errors.length, {}, {timeout: 180000});
  const evidence = await page.evaluate(() => worldEvidence);
  assert.deepEqual(evidence.errors, []);
  return {ms: Date.now()-start, holds: evidence.state.holds, source: evidence.state.source};
};
try {
  const cold = await startup();
  // Same browser/origin, warmed HTTP/OS cache. Directory-file mode still reopens archives.
  const warm = await startup();
  if(await page.evaluate(() => worldEvidence.info.tuning?.length === 17)) {
    await page.evaluate(async () => {
      const original = await worldTest.request('tuning');
      const changed = original.slice(); changed[2] += 1;
      const canonical = await worldTest.request('tuning', {values: changed, validateOnly: true});
      if(JSON.stringify(await worldTest.request('tuning')) !== JSON.stringify(original)) throw Error('validateOnly mutated tuning');
      let rejected = false;
      try { await worldTest.request('tuning', {values: original.slice(1)}); } catch { rejected = true; }
      if(!rejected) throw Error('Invalid tuning length accepted');
      await worldTest.request('tuning', {values: canonical});
      if(JSON.stringify(await worldTest.request('tuning')) !== JSON.stringify(canonical)) throw Error('Tuning did not round-trip');
      await worldTest.request('tuning', {values: original});
    });
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.evaluate(async () => {
    const {WorldRenderer} = await import('./world-renderer.js');
    const {WorldClient} = await import('./world-client.js');
    const draw = WorldRenderer.prototype.draw;
    const request = WorldClient.prototype.request;
    const submit = GPUQueue.prototype.submit;
    window.profile = {frames: [], movingMs: [], draws: [], submits: [], worker: [], freshStates: [],
      freshPoses: [], movingPoseMs: [], drawnPoses: [], movingDrawnPoseMs: [], inputs: [], tasks: [], samples: [], active: false};
    document.addEventListener('keydown', event => {
      if(!profile.active || event.repeat || !['KeyW','KeyA','KeyD'].includes(event.code))return;
      const p = worldEvidence.state.telemetry;
      profile.inputs.push({code: event.code, at: performance.now(), pose: [p[0],p[2],p[3]], visibleMs: null});
    });
    GPUQueue.prototype.submit = function(...args) {
      const start = performance.now(), result = submit.apply(this,args);
      if(profile.active)profile.submits.push(performance.now()-start);
      return result;
    };
    WorldClient.prototype.request = function(action, ...args) {
      const start = performance.now();
      return request.call(this, action, ...args).then(result => {
        if(profile.active && action === 'frame') {
          const now = performance.now(), p = result.telemetry;
          profile.worker.push(now-start);profile.freshStates.push(now);
          const pose = [p[0],p[2],p[3]];
          const moved = profile.lastPose && pose.some((v,i)=>v!==profile.lastPose[i]);
          const moving = p[5]>1 && !p[8] && !result.scene.waitingCollision;
          if(moved) {
            profile.freshPoses.push(now);
            if(moving && profile.previousMoving && profile.lastPoseAt!==undefined)profile.movingPoseMs.push(now-profile.lastPoseAt);
            profile.lastPoseAt = now;
          }
          if(!moving)profile.lastPoseAt = undefined;
          profile.previousMoving = moving;profile.lastPose = pose;
        }
        return result;
      });
    };
    WorldRenderer.prototype.draw = function(...args) {
      const start = performance.now();
      const result = draw.apply(this, args);
      if (profile.active) {
        const p = args[0];
        for(const input of profile.inputs) if(input.visibleMs===null &&
          (input.code==='KeyW' ? p[0]!==input.pose[0] || p[2]!==input.pose[1] : p[3]!==input.pose[2])) {
          input.visibleMs = performance.now()-input.at;
        }
        profile.draws.push(performance.now()-start);
        const state = worldEvidence.state;
        const moving = p[5]>1 && !p[8] && !state.scene.waitingCollision;
        const pose = [p[0],p[2],p[3]], changed = profile.lastDrawnPose && pose.some((v,i)=>v!==profile.lastDrawnPose[i]);
        if(changed) {
          profile.drawnPoses.push(start);
          if(moving && profile.previousDrawnMoving && profile.lastDrawnAt!==undefined)
            profile.movingDrawnPoseMs.push(start-profile.lastDrawnAt);
          profile.lastDrawnAt=start;
        }
        if(!moving)profile.lastDrawnAt=undefined;
        profile.previousDrawnMoving=moving;profile.lastDrawnPose=pose;
        if(moving && profile.wasMoving && profile.frames.length)profile.movingMs.push(start-profile.frames.at(-1));
        profile.wasMoving = moving;
        profile.frames.push(start);
      }
      return result;
    };
    new PerformanceObserver(list => {
      if (profile.active) profile.tasks.push(...list.getEntries().map(e => e.duration));
    }).observe({type: 'longtask', buffered: false});
    setInterval(() => {
      if (profile.active) profile.samples.push({time: performance.now(),
        telemetry: [...worldEvidence.state.telemetry], holds: structuredClone(worldEvidence.state.holds),
        freshStates: profile.freshStates.length, freshPoses: profile.freshPoses.length,
        timings: {...worldEvidence.state.timings}, collision: worldEvidence.state.collision,
        pending: worldEvidence.state.scene.pending, waitingCollision: worldEvidence.state.scene.waitingCollision,
        sceneBytes: worldEvidence.state.scene.bytes, render: {...worldEvidence.render}});
    }, 1000);
  });
  const manifest = await page.evaluate(() => worldEvidence.info.manifest);
  const tile = 1600/3;
  const global = (region, source) => [-source[1]+manifest.regions[region].placement[0]+32*tile,
    source[2], -source[0]+manifest.regions[region].placement[1]+32*tile];
  const routes = [
    {name: 'raceway', pose: manifest.spawn.slice(0,3), yaw: manifest.spawn[3]},
    {name: 'elwynn', pose: global(1, [-9450,-100,100]), yaw: 0},
    {name: 'stormwind', pose: global(1, [-8833,628,160]), yaw: 0},
    {name: 'durotar', pose: global(0, [1600,-4400,120]), yaw: 0},
    {name: 'coastal-boundary', pose: [288,60,160], yaw: -Math.PI/2},
    {name: 'raceway-clear', pose: manifest.spawn.slice(0,3), yaw: 0},
    {name: 'coastal-circuit', pose: [529,60,160], yaw: -Math.PI/2, steer: 'KeyA'},
  ];
  for (const route of routes) {
    await page.evaluate(p => worldTest.focus([...p, 0, -.3]), route.pose);
    await page.waitForTimeout(6000);
    const [x,,z] = route.pose;
    const surface = await page.evaluate(points => worldTest.request('probe', {points}), [[x,z]]);
    const floor = Math.max(...surface[0].slice(1,3).filter(Number.isFinite));
    if (!Number.isFinite(floor) || surface[0][0] !== 0) {
      results.push({name: route.name, blocked: 'No ready support at requested route start', surface});
      continue;
    }
    try {
      await page.evaluate(pose => worldTest.request('restore', {pose}), [x,floor+1.1,z,route.yaw]);
    } catch (error) {
      results.push({name: route.name, blocked: error.message, surface});
      continue;
    }
    await page.locator('#drive').click();
    const before = await page.evaluate(() => structuredClone(worldEvidence.state));
    const cpuBefore = await cdp.send('Performance.getMetrics');
    await page.evaluate(() => {
      Object.assign(profile, {frames: [], movingMs: [], draws: [], submits: [], worker: [], freshStates: [],
        freshPoses: [], movingPoseMs: [], drawnPoses: [], movingDrawnPoseMs: [], inputs: [], tasks: [], samples: [], wasMoving: false,
        previousDrawnMoving: false, lastDrawnPose: undefined, lastDrawnAt: undefined,
        previousMoving: false, lastPose: undefined, lastPoseAt: undefined, active: true});
    });
    await page.locator('#world').focus();
    await page.keyboard.down('KeyW');
    if(route.steer)await page.keyboard.down(route.steer);
    await page.waitForTimeout(seconds*1000);
    await page.keyboard.up('KeyW');
    if(route.steer)await page.keyboard.up(route.steer);
    const data = await page.evaluate(() => {
      profile.active = false;
      return {...profile, after: structuredClone(worldEvidence.state),
        render: worldEvidence.render, adapter: worldEvidence.adapter,
        worldErrors: [...worldEvidence.errors],
        canvas: [document.getElementById('world').width,document.getElementById('world').height],
        devicePixelRatio,
        settings: Object.fromEntries(['horizon','scenery','distant'].map(id=>[id,document.getElementById(id).checked])),
        heap: performance.memory ? {used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize} : null};
    });
    const cpuAfter = await cdp.send('Performance.getMetrics');
    const metricsBefore = Object.fromEntries(cpuBefore.metrics.map(v => [v.name,v.value]));
    const metrics = Object.fromEntries(cpuAfter.metrics.map(v => [v.name,v.value-(metricsBefore[v.name] || 0)]));
    const intervals = data.frames.slice(1).map((v,i) => v-data.frames[i]);
    const rolling = data.frames.filter(t => t >= data.frames[0]+1000)
      .map(t => data.frames.filter(f => f > t-1000 && f <= t).length);
    const after = data.after;
    errors.push(...data.worldErrors.filter(error=>!errors.includes(error)));
    assert.equal(data.adapter.isFallbackAdapter,false,'Hardware WebGPU adapter required');
    assert(Object.values(data.settings).every(Boolean),'Do not hide scenery or horizon to meet the frame target');
    const displacement = Math.hypot(after.telemetry[0]-before.telemetry[0], after.telemetry[2]-before.telemetry[2]);
    const poses = [before.telemetry,...data.samples.map(s=>s.telemetry),after.telemetry];
    const traveled = poses.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-poses[i][0],p[2]-poses[i][2]),0);
    const cells = poses.flatMap(p => {
      const region = p[10], r = manifest.regions[region];
      if(!r)return [];
      const x = Math.floor((p[0]-r.placement[0])/tile)+r.tile_origin[0];
      const y = Math.floor((p[2]-r.placement[1])/tile)+r.tile_origin[1];
      return manifest.tiles.some(t=>t.region===region && t.x===x && t.y===y) ? [`${region}:${x}:${y}`] : [];
    });
    const crossed = new Set(cells).size>1;
    results.push({name: route.name, seconds, displacement, traveled, crossed,
      actualDriving: traveled > 20 && data.movingMs.length>0,
      boundaryPassed: route.name !== 'coastal-boundary' || (crossed && displacement > 250),
      frameMs: distribution(intervals), drawCpuMs: distribution(data.draws), longTasks: distribution(data.tasks),
      submitCpuMs: distribution(data.submits),
      movingFrameMs: distribution(data.movingMs), movingSeconds: data.movingMs.reduce((n,v)=>n+v,0)/1000,
      workerRoundTripMs: distribution(data.worker),
      freshStateHz: data.freshStates.length/seconds, freshPoseHz: data.freshPoses.length/seconds,
      movingPoseUpdateMs: distribution(data.movingPoseMs), inputToVisible: data.inputs,
      freshDrawnPoseHz: data.drawnPoses.length/seconds, movingDrawnPoseMs: distribution(data.movingDrawnPoseMs),
      averageFps: (data.frames.length-1)*1000/(data.frames.at(-1)-data.frames[0]),
      minRollingFps: rolling.length ? Math.min(...rolling) : 0,
      holds: Object.fromEntries(Object.entries(after.holds).map(([k,v]) => [k, {
        episodes: v.episodes-before.holds[k].episodes, ms: v.ms-before.holds[k].ms}])),
      cpu: metrics, adapter: data.adapter, canvas: data.canvas, devicePixelRatio: data.devicePixelRatio,
      settings: data.settings, heap: data.heap, before, after, render: data.render, samples: data.samples});
    console.log(JSON.stringify({...results.at(-1), before: undefined, after: undefined, samples: undefined}));
    await writeFile(out, JSON.stringify({browser: browser.version(), viewport: {width:1440,height:1000},
      background: 'User live4173 browser left untouched; no concurrent agent GPU benchmarks',
      gpuTiming: 'CPU draw encoding only; no GPU timestamp query instrumentation', cold, warm, results, errors}, null, 2));
  }
  assert.deepEqual(errors, []);
  assert(results.some(r => r.name === 'raceway' && r.actualDriving), 'Raceway keyboard displacement failed');
  assert(results.some(r => r.name === 'coastal-boundary' && r.boundaryPassed), 'Coastal ADT boundary crossing failed');
  assert(results.some(r => r.name === 'raceway-clear' && r.movingSeconds>seconds*.75 && r.traveled>250), 'Clear raceway sustained driving failed');
  assert(results.some(r => r.name === 'coastal-circuit' && r.crossed && r.movingSeconds>seconds*.75 && r.traveled>250), 'Coastal circuit sustained crossing failed');
  for(const name of ['raceway-clear','coastal-circuit','stormwind']) {
    const route=results.find(r=>r.name===name);
    assert(route?.movingSeconds>=30 && route.movingSeconds>seconds*.75 && route.traveled>250, `${name}: sustained driving required`);
    assert(route.minRollingFps>=30 && route.movingFrameMs?.p95<=1000/30, `${name}: render cadence below 30 FPS`);
    assert(route.freshPoseHz>=30 && route.movingPoseUpdateMs?.p95<=1000/30,
      `${name}: fresh simulation poses fail the 30 Hz / 33.3 ms p95 gate`);
    assert(route.freshDrawnPoseHz>=30 && route.movingDrawnPoseMs?.p95<=1000/30,
      `${name}: actually drawn poses fail the 30 Hz / 33.3 ms p95 gate`);
  }
} finally { await browser.close(); }
