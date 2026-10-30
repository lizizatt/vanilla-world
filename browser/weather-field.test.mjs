import test from 'node:test';
import assert from 'node:assert/strict';
import {WEATHER as W,WEATHER_TIERS,DRY_ZONES,SNOW_ZONES} from './weather-config.js';
import {precipitation,cellIntensity,lifeEnvelope,stormRain,coverageGate,WeatherState} from './weather-field.js';
import {climateOf,ClimateTracker} from './weather-climate.js';
import {MAELSTROM as M} from './cloud-config.js';
import {smoothstep} from './math.js';

const rng=seed=>{let s=seed;return()=>(s=(s*1664525+1013904223)>>>0)/4294967296;};

test('weather config is coherent',()=>{
  assert(W.off<W.on&&W.on<W.heavy&&W.heavy<=1);
  assert(W.coverage[0]<W.coverage[1]&&W.coverage[1]<=.95);
  assert(W.life.build+W.life.decay<1);
  assert(W.quality.low===0&&W.quality.standard<W.quality.high);
  assert.deepEqual([...WEATHER_TIERS],['off','low','standard','high']);
  assert(DRY_ZONES.includes('Tanaris')&&SNOW_ZONES.includes('Winterspring'));
});
test('cell field is deterministic and bounded',()=>{
  const r=rng(7);
  for(let i=0;i<200;i++){const Q=[r()*5e4,r()*5e4,r()*5e4],t=r()*1e5,p=precipitation(Q,t,.9);
    assert.equal(p,precipitation(Q,t,.9));assert(p>=0&&p<=1);}
});
test('about 30% of dense cloud rains, none of thin cloud',()=>{
  const r=rng(12345);let wet=0,thin=0,n=30000;
  for(let i=0;i<n;i++){const Q=[r()*4e4,r()*4e4,r()*4e4],t=r()*4e5;
    if(precipitation(Q,t,.9)>=W.on)wet++;if(precipitation(Q,t,.25)>0)thin++;}
  assert(wet/n>.25&&wet/n<.36,`wet ${wet/n}`);assert.equal(thin,0);
});
test('lifecycle fades in and out and is continuous across the wrap',()=>{
  assert.equal(lifeEnvelope(0),0);assert(lifeEnvelope(.999999)<1e-3);
  assert.equal(lifeEnvelope(.5),1);assert.equal(lifeEnvelope(3.5),1);
  let prev=lifeEnvelope(0);for(let u=.001;u<2;u+=.001){const e=lifeEnvelope(u);assert(Math.abs(e-prev)<.05);prev=e;}
});
test('cells drift with the cloud-advected sample point (same point, shifted time of life, differs)',()=>{
  const Q=[3000,9000,12000];assert.notEqual(cellIntensity(Q,0),cellIntensity(Q,W.life.period*.4));
});
test('Maelstrom is heavy rain except calm at the eye',()=>{
  const wall=Math.exp(-M.wallRadius/M.radius),eyeAt=r=>smoothstep(M.eyeRadius,M.eyeRadius*1.5,r);
  assert(precipitation([0,0,0],0,.2,wall,eyeAt(M.wallRadius))>=W.heavy);
  assert.equal(precipitation([0,0,0],0,.95,1,eyeAt(M.eyeRadius*.5)),0);
  assert.equal(stormRain(0,1),0);
});
test('climate: dry zones, snow zones, Elune and space',()=>{
  assert.equal(climateOf({area:{name:'Tanaris'}}).wet,0);
  assert.equal(climateOf({area:{name:'Durotar'}}).wet,0);
  for(const name of ['Winterspring','Dun Morogh','Alterac Mountains'])assert.deepEqual([climateOf({area:{name}}).wet,climateOf({area:{name}}).snow],[1,1]);
  assert.equal(climateOf({area:{name:'Elwynn Forest',cold:true}}).snow,1);
  assert.deepEqual([climateOf({area:{name:'Elwynn Forest'}}).wet,climateOf({area:{name:'Elwynn Forest'}}).snow],[1,0]);
  assert.equal(climateOf({area:{name:'Elwynn Forest'},body:'elune'}).wet,0);
  assert.equal(climateOf({area:{name:'Elwynn Forest'},regime:'orbit'}).wet,0);
  assert.equal(climateOf({}).wet,1);
});
test('weather state eases, uses hysteresis and picks the kind',()=>{
  const s=new WeatherState();let flips=0,was=false;
  for(let i=0;i<600;i++){s.step(.1,.45+.1*Math.sin(i/9));if(s.raining!==was){flips++;was=s.raining;}}
  assert(flips<=1,`flips ${flips}`);
  const a=new WeatherState();for(let i=0;i<200;i++)a.step(.1,.9,{wet:1,snow:0});assert.equal(a.kind,'rain');assert(a.heavy);
  const b=new WeatherState();for(let i=0;i<200;i++)b.step(.1,.9,{wet:1,snow:1});assert.equal(b.kind,'snow');
  const c=new WeatherState();for(let i=0;i<200;i++)c.step(.1,.9,{wet:0,snow:0});assert.equal(c.kind,'none');assert.equal(c.intensity,0);
  assert.equal(coverageGate(.25),0);assert.equal(coverageGate(.9),1);
});
test('climate tracker asks once per area change and keeps the last answer',()=>{
  let t=0;const sent=[],c=new ClimateTracker(r=>sent.push(r),()=>t);
  c.update(5);c.update(5);assert.equal(sent.length,1);
  c.event({event:'climate',area:5,name:'Dun Morogh',cold:true});assert.deepEqual(c.info,{name:'Dun Morogh',cold:true});
  t=100;c.update(6);assert.equal(sent.length,1);t=900;c.update(6);assert.equal(sent.length,2);assert.equal(c.info.name,'Dun Morogh');
  c.event({event:'climate',area:5,name:'stale',cold:false});assert.equal(c.info.name,'Dun Morogh');
});
