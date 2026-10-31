import test from 'node:test';
import assert from 'node:assert/strict';
import {WIND as W} from './wind-config.js';
import {windAt,packWind,windTime,zoneCharacter,beltVector,windSeaK,windWaveHint,sprayK,dustK,snowK,WindRuntime,GroundGrid,flatK,gustOmega} from './wind.js';
import {windWGSL} from './wind-wgsl.js';
import {sprayShader,groundShader,windParticleUniform,WIND_UNIFORM_BYTES,groundGridUniform,GRID_UNIFORM_FLOATS} from './wind-particles.js';
import {seaState,seaWindK} from './sea-state.js';
import {resolveWeatherTier} from './renderer-weather.js';
import {WAVE_PERIOD,WAVE_TICKS_PER_SECOND} from './wave-config.js';

const zone=(name,extra={})=>({base:beltVector(.8),...W.zones[name],storm:0,...extra});
const P=(name,extra)=>packWind(zone(name,extra));
const f=x=>Number.isInteger(x)?x.toFixed(1):String(x);
const grid=(fn)=>{for(let i=0;i<60;i++)fn(2e4+i*913.7,-3e4+i*1771.3,i*17.31);};

test('wind is deterministic, finite and bounded',()=>{
  const a=P('plains',{storm:.4});
  grid((x,z,t)=>{
    const s=windAt(a,x,z,t),r=windAt(a,x,z,t);
    assert.deepEqual(s,r);
    assert(Number.isFinite(s.speed)&&s.speed>=0);
    assert(s.strength>=0&&s.strength<=1);
    assert(Math.abs(Math.hypot(...s.dir)-1)<1e-9);
  });
});
test('gusts are smooth: a one-second step never moves speed by more than a few percent of full scale',()=>{
  const a=P('desert');let worst=0;
  for(let t=0;t<600;t+=.5)worst=Math.max(worst,Math.abs(windAt(a,5000,9000,t+.5).strength-windAt(a,5000,9000,t).strength));
  assert(worst<.05,`worst half-second step ${worst}`);
});
test('the wind clock wraps seamlessly: t and t + period agree to rounding',()=>{
  const a=P('mountain',{storm:.5});
  grid((x,z,t)=>{const p=windAt(a,x,z,t),q=windAt(a,x,z,t+W.period);assert(Math.abs(p.speed-q.speed)<1e-6);});
  assert.equal(windTime(WAVE_PERIOD*WAVE_TICKS_PER_SECOND),0);
  assert.equal(windTime(WAVE_PERIOD*WAVE_TICKS_PER_SECOND+120),1);
  for(const c of W.gust)assert.equal(Math.round(gustOmega(c)*W.period/(2*Math.PI)),c.n);
});
test('zone character changes the wind: forest calm, desert/snow/mountain gustier and stronger',()=>{
  const mean=name=>{const a=P(name);let s=0,n=0;grid((x,z,t)=>{s+=windAt(a,x,z,t).strength;n++;});return s/n;};
  assert(mean('forest')<mean('plains'));
  assert(mean('plains')<mean('desert'));
  assert(mean('desert')>=mean('coast'));
  assert(mean('mountain')>mean('plains'));
  assert(mean('forest')<W.dust.on&&mean('forest')<W.snow.on,'sheltered zones do not blow dust or snow');
  assert(mean('desert')>W.dust.on*.7);
});
test('storm raises wind, strongest in a full storm',()=>{
  const calm=P('sea'),storm=P('sea',{storm:1});
  grid((x,z,t)=>{assert(windAt(storm,x,z,t).speed>windAt(calm,x,z,t).speed);});
  grid((x,z,t)=>{assert(windAt(storm,x,z,t).strength>W.spray.on,'a stormy sea is above the spray threshold');});
});
test('Maelstrom: a swirl around the centre, calm far away, gale inside the halo',()=>{
  const C=[1000,2000],a=packWind({...zone('sea'),mael:C}),far=packWind(zone('sea'));
  const at=(dx,dz)=>windAt(a,C[0]+dx,C[1]+dz,100);
  const w=at(W.mael.core*1.5,0);
  assert(w.strength>=.9);
  // Counter-clockwise tangential component: east of the centre the wind blows toward +z.
  assert(w.dir[1]>0);
  const w2=at(0,W.mael.core*1.5);assert(w2.dir[0]<0);
  assert(at(W.mael.core+W.mael.halo*W.mael.decay*3,0).speed<=windAt(far,C[0]+1e6,C[1],100).speed*1.6+4);
  assert.equal(windAt(a,C[0]+1e7,C[1],5).speed,windAt(far,C[0]+1e7,C[1],5).speed);
});
test('calm belt falls back to the wave heading and a zero zone yields no wind',()=>{
  const s=windAt(packWind({base:[0,0],gain:0,floor:0,gust:0}),0,0,0);
  assert.equal(s.speed,0);assert.equal(s.strength,0);
  const f=packWind({base:[0,0],gain:1,floor:6,gust:0});
  assert(Math.abs(Math.atan2(windAt(f,0,0,0).dir[1],windAt(f,0,0,0).dir[0])-W.fallbackHeading)<.4);
});
test('zoneCharacter maps climate, names and the sea',()=>{
  assert.equal(zoneCharacter({sea:true,area:{name:'Tanaris'},climate:{reason:'dry'}}),'sea');
  assert.equal(zoneCharacter({area:{name:'Tanaris'},climate:{reason:'dry'}}),'desert');
  assert.equal(zoneCharacter({area:{name:'Winterspring'},climate:{reason:'snow'}}),'snow');
  assert.equal(zoneCharacter({area:{name:'Redridge Mountains'},climate:{reason:'rain'}}),'mountain');
  assert.equal(zoneCharacter({area:{name:'Elwynn Forest'},climate:{reason:'rain'}}),'forest');
  assert.equal(zoneCharacter({area:{name:'Westfall'},climate:{reason:'rain'}}),'plains');
  assert.equal(zoneCharacter({area:{name:'The Barrens'},climate:{reason:'dry'}}),'desert');
  assert.equal(zoneCharacter({}),'plains');
});
test('effect ramps are exactly zero below their thresholds',()=>{
  assert.equal(sprayK(W.spray.on),0);assert.equal(dustK(W.dust.on-.01),0);assert.equal(snowK(0),0);
  assert.equal(sprayK(W.spray.full),1);assert(dustK(.6)>0&&dustK(.6)<1);
});
test('runtime costs nothing below threshold: calm zone and disabled runtime report zero layers',()=>{
  const w=new WindRuntime(),ctx={dt:.016,x:0,z:0,t:0,lat:.7,character:'forest',storm:0,mael:null,enabled:true,sea:false};
  for(let i=0;i<300;i++)w.step({...ctx,t:i*.016});
  assert.equal(w.spray+w.dust+w.snow,0);
  const off=new WindRuntime().step({...ctx,enabled:false});
  assert.equal(off.on,0);assert.equal(off.ground,0);assert.equal(off.sample.strength,0);
});
test('runtime: storm sea sprays, desert dusts, snow zone blows snow, and only their own layer',()=>{
  const run=(character,extra)=>{const w=new WindRuntime();let best={spray:0,dust:0,snow:0};
    for(let i=0;i<4000;i++){w.step({dt:.05,x:100,z:200,t:i*.05,lat:.8,character,storm:0,mael:null,enabled:true,sea:character==='sea',...extra});
      best={spray:Math.max(best.spray,w.spray),dust:Math.max(best.dust,w.dust),snow:Math.max(best.snow,w.snow)};}return best;};
  const sea=run('sea',{storm:1}),desert=run('desert'),snow=run('snow');
  assert(sea.spray>.5&&sea.dust===0&&sea.snow===0);
  assert(desert.dust>0&&desert.spray===0&&desert.snow===0);
  assert(snow.snow>0&&snow.dust===0&&snow.spray===0);
});
test('zone parameters ease across a border instead of jumping',()=>{
  const w=new WindRuntime(),base={dt:.05,x:0,z:0,t:0,lat:.8,storm:0,mael:null,enabled:true,sea:false};
  w.step({...base,character:'forest'});const g0=w.gain;
  w.step({...base,character:'desert'});
  assert(w.gain>g0&&w.gain<W.zones.desert.gain);
});
test('ground drift is bounded so f32 stays exact',()=>{
  const w=new WindRuntime();for(let i=0;i<100000;i++)w.step({dt:.016,x:0,z:0,t:i*.016,lat:.8,character:'desert',storm:1,mael:null,enabled:true,sea:false});
  assert(Math.abs(w.drift[0])<W.box.groundFar&&Math.abs(w.drift[1])<W.box.groundFar);
  assert.equal(W.box.groundFar%W.box.ground,0,'the drift wrap must be a whole number of near boxes');
});
test('blowing dust/snow drifts at half the wind speed on land',()=>{
  assert.equal(W.groundSpeed,.5);
  for(const character of ['desert','snow']){
    const w=new WindRuntime(),ctx={dt:.05,x:0,z:0,t:3,lat:.8,character,storm:.6,mael:null,enabled:true,sea:false};
    w.step(ctx);const d0=[...w.drift];w.step(ctx);
    const moved=Math.hypot(w.drift[0]-d0[0],w.drift[1]-d0[1]),full=w.sample.speed*ctx.dt;
    assert(full>0&&Math.abs(moved/full-.5)<1e-9,`${character} drift ratio ${moved/full}`);
  }
});
test('sea spray switches on at a moderate wind, well below a gale',()=>{
  assert(W.spray.on<=.35&&sprayK(.5)>.3&&sprayK(.75)===1);
  const w=new WindRuntime();let best=0;
  for(let i=0;i<4000;i++){w.step({dt:.05,x:100,z:200,t:i*.05,lat:.8,character:'sea',storm:.5,mael:null,enabled:true,sea:true});best=Math.max(best,w.spray);}
  assert(best>.5);
});
test('ground layer follows the terrain: lattice reproduces a slope, caches, and the shader rides above it',()=>{
  const slope=(x,z)=>.4*x+.2*Math.sin(z/9)*3,calls=[];
  const g=new GroundGrid((x,z)=>{calls.push([x,z]);return slope(x,z);});
  g.update(1000.3,-500.7);
  const first=calls.length;assert(first<=W.grid.budget);
  const fill=Math.ceil(W.grid.n*W.grid.n/W.grid.budget)+1;
  for(let i=0;i<fill;i++)g.update(1000.3,-500.7);
  assert.equal(calls.length,W.grid.n*W.grid.n);
  g.update(1000.3,-500.7);assert.equal(calls.length,W.grid.n*W.grid.n);
  // On a planar slope the bilinear sample is exact; on a curved one it stays within the curvature error of a step.
  const plane=new GroundGrid((x,z)=>.4*x-.1*z);for(let i=0;i<fill;i++)plane.update(200,300);
  for(const [x,z] of [[200,300],[203.7,296.2],[190.1,310.9]])assert(Math.abs(plane.sample(x,z)-(.4*x-.1*z))<1e-3);
  for(const [x,z] of [[1000.3,-500.7],[1006.1,-494.9],[994.4,-506.2]])assert(Math.abs(g.sample(x,z)-slope(x,z))<.1);
  // Moving the window reuses the cache and only queries the new cells.
  const before=calls.length;g.update(1006.3,-500.7);assert(calls.length-before<=W.grid.budget&&calls.length>before);
  // Failed queries do not poison the window.
  const bad=new GroundGrid(()=>NaN);bad.update(0,0);assert.equal(bad.known,0);
  assert(groundShader.includes('fn groundY(')&&groundShader.includes('groundY(wp)')&&groundShader.includes('wp=u.eye.xz+rel')&&!groundShader.includes('u.org.z'));
  assert(groundShader.includes(`${f(W.grid.clear)}+${f(W.grid.clearFar)}*d+H+rise+.08*(.5+.5*sin(`),'particle centre must clear its own half height');
  const up=groundGridUniform(g);assert.equal(up.length,GRID_UNIFORM_FLOATS);assert.deepEqual([...up.slice(0,4)],g.meta);
});
test('stacked dust layers: 1/3 opacity, 1/2 speed, below the main layer; hidden on slopes with a smooth fade',()=>{
  const L=W.layers;
  assert.equal(L.alpha,1/3);assert.equal(L.speed,.5);assert(L.fracs.length>=3&&L.fracs.every((x,i)=>x>0&&x<1&&(!i||x>L.fracs[i-1])));
  const w=new WindRuntime();
  for(let i=0;i<200;i++)w.step({dt:.05,x:0,z:0,t:i*.05,lat:0,character:'desert',storm:1,mael:null,enabled:true});
  assert(w.drift[0]!==0||w.drift[1]!==0);
  assert.ok(Math.abs(w.layerDrift[0]-w.drift[0]*L.speed)<1e-4&&Math.abs(w.layerDrift[1]-w.drift[1]*L.speed)<1e-4,'layers drift at half speed');
  // Slope: flat ground -> 1, steep -> 0, monotone and continuous in between.
  assert.equal(flatK(0),1);assert.equal(flatK(W.flat[1]),0);
  let prev=1;for(let s=0;s<=.5;s+=.005){const k=flatK(s);assert(k<=prev+1e-12&&prev-k<.05);prev=k;}
  const plane=new GroundGrid((x,z)=>.5*x);for(let i=0;i<40;i++)plane.update(0,0);
  assert(Math.abs(plane.slope(0,0)-.5)<1e-3);
  const flat=new GroundGrid(()=>3);for(let i=0;i<40;i++)flat.update(0,0);assert.equal(flat.slope(5,5),0);
  assert(groundShader.includes('fn slopeAt(')&&groundShader.includes(`smoothstep(${f(W.flat[0])},${f(W.flat[1])},slopeAt(wp))`));
  assert(groundShader.includes(`select(1.0,${f(L.alpha)},layered)`)&&groundShader.includes('u.drift.w>.5'));
  const u=windParticleUniform({right:[1,0,0],aspect:1,up:[0,1,0],look:[0,0,1],eye:[0,0,0]},.1,[0,0],0,0,0,1,10,1,1,1,  [0,0],new Float32Array(12),undefined,1);
  assert.equal(u[27],1);
});
test('wave/whitecap hooks only ever raise the sea state and never touch the physics waves',()=>{
  const base=seaState(0,0,0,[0,0],1e6),hi=seaState(0,0,0,[0,0],1e6,1),lo=seaState(0,0,0,[0,0],1e6,0);
  assert(hi[0]===1&&lo[0]===base[0]);assert(windSeaK(1)===1&&windSeaK(0)===W.seaCalm);
  assert(seaWindK(0,0)<=1&&windWaveHint(0)===1&&windWaveHint(1)>1);
});
test('tiers reuse weatherQuality: off draws nothing, budgets grow, weather off wins',()=>{
  assert.equal(W.quality.off,0);assert(W.quality.low<W.quality.standard&&W.quality.standard<W.quality.high);
  assert.equal(resolveWeatherTier(false,'high'),'off');assert.equal(W.quality[resolveWeatherTier(true,'off')],0);
});
test('WGSL emitter carries every constant windAt reads',()=>{
  const src=windWGSL();
  for(const v of [W.maxSpeed,W.veer,W.storm.add,W.storm.ramp[0],W.storm.ramp[1],W.mael.core,W.mael.decay,W.mael.speed,W.mael.inflow,...W.gust.flatMap(c=>[c.w,c.p,...c.k])])
    assert(src.includes(String(+v.toPrecision(9))),`missing ${v}`);
  assert(src.includes('fn windAt(a0:vec4f,a1:vec4f,a2:vec4f,xz:vec2f,t:f32)->vec4f'));
  for(const s of [sprayShader,groundShader]){assert(s.includes(src));assert(s.includes('@vertex fn vs')&&s.includes('@fragment fn fs'));}
  assert(sprayShader.includes('waveVertex(P,eyeR)')&&sprayShader.includes('wv.head.x<.5'));
});
test('second pass: wind is 35% slower than the first pass with the same effect thresholds on strength',()=>{
  // First-pass reference numbers (commit 15e35310 and before): belt .35, maxSpeed 28, storm add 22, desert floor 5.
  assert(Math.abs(W.beltScale/.35-.65)<1e-9&&Math.abs(W.maxSpeed/28-.65)<1e-9&&Math.abs(W.storm.add/22-.65)<1e-9);
  assert(Math.abs(W.zones.desert.floor/5-.65)<1e-9&&W.zones.forest.floor===0);
  assert(W.dust.on>=.5&&W.snow.on>=.45&&W.spray.on>=.3,'effects start at a stronger wind than the first pass (.45/.4/.28)');
  const s=windAt(packWind({base:[0,0],gain:1,floor:10,gust:0}),0,0,0);assert(Math.abs(s.speed-10)<1e-4);
});
test('second pass: ground layer is wispy, 1-2 ft (0.3-0.7 yd) tall and reaches several times further',()=>{
  const near=W.ground.height+W.grid.clear+.08+2*.1*1.4;
  assert(W.ground.height>=.3&&near<=.75,`near vertical extent ${near} yd`);
  assert(W.ground.alpha.dust<=.4&&W.ground.alpha.snow<=.6,'quads are ~20x smaller in area than the first pass, so peak alpha stays moderate');
  assert(W.box.groundFar>=4*W.box.ground&&W.box.sprayFar>=4*W.box.spray,'draw distance several times the first pass box');
  assert(W.box.sprayFar%W.box.spray===0&&W.grid.n*W.grid.step>=W.box.groundFar,'the height lattice covers the far ring');
  assert(groundShader.includes('let ds=1.0+d*.045')&&groundShader.includes('*ds;'),'quads grow with distance');
  assert(groundShader.includes(`floor(u.p.x*${f(1-W.ground.far)})`)&&W.ground.far>0&&W.ground.far<1);
  assert(W.quality.high<=2600&&W.quality.standard<=1100,'particle budget unchanged');
});
test('second pass: spray is subtle and crest-only, and reaches distant crests',()=>{
  assert(W.sprayLook.alpha<=.4&&W.sprayLook.crest[0]>=.6&&W.sprayLook.crest[1]>W.sprayLook.crest[0]);
  assert(sprayShader.includes('let top=w.h/m+.5*w.crest;')&&sprayShader.includes(`smoothstep(${f(W.sprayLook.crest[0])}-.12*amt`));
  assert(!sprayShader.includes('(.4+.6*smoothstep'),'no general haze share outside crests');
  assert(sprayShader.includes('let ds=1.0+d*.035')&&sprayShader.includes(`select(${f(W.box.spray)},${f(W.box.sprayFar)},far)`));
});
test('particle uniform packs into its 160 byte block',()=>{
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1.5},u=windParticleUniform(view,.2,[10,20],5,6,7,.8,100,.5,1,.9,[1,2],P('desert'));
  assert.equal(u.length*4,WIND_UNIFORM_BYTES);
  assert.deepEqual([...u.slice(12,16)],[1,2,3,5]);assert.deepEqual([...u.slice(16,20)].map(x=>+x.toFixed(4)),[10,20,7,.8]);
  assert.equal(u[20],100);assert.equal(u[26],6);assert.equal(u[27],0);
});
