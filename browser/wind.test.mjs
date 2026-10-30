import test from 'node:test';
import assert from 'node:assert/strict';
import {WIND as W} from './wind-config.js';
import {windAt,packWind,windTime,zoneCharacter,beltVector,windSeaK,windWaveHint,sprayK,dustK,snowK,WindRuntime,gustOmega} from './wind.js';
import {windWGSL} from './wind-wgsl.js';
import {sprayShader,groundShader,windParticleUniform,WIND_UNIFORM_BYTES} from './wind-particles.js';
import {seaState,seaWindK} from './sea-state.js';
import {resolveWeatherTier} from './renderer-weather.js';
import {WAVE_PERIOD,WAVE_TICKS_PER_SECOND} from './wave-config.js';

const zone=(name,extra={})=>({base:beltVector(.8),...W.zones[name],storm:0,...extra});
const P=(name,extra)=>packWind(zone(name,extra));
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
  assert(Math.abs(w.drift[0])<W.box.ground&&Math.abs(w.drift[1])<W.box.ground);
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
test('particle uniform packs into its 160 byte block',()=>{
  const view={eye:[1,2,3],right:[1,0,0],up:[0,1,0],look:[0,0,1],aspect:1.5},u=windParticleUniform(view,.2,[10,20],5,6,7,.8,100,.5,1,.9,[1,2],P('desert'));
  assert.equal(u.length*4,WIND_UNIFORM_BYTES);
  assert.deepEqual([...u.slice(12,16)],[1,2,3,5]);assert.deepEqual([...u.slice(16,20)].map(x=>+x.toFixed(4)),[10,20,7,.8]);
  assert.equal(u[20],100);assert.equal(u[26],6);assert.equal(u[27],0);
});
