import test from 'node:test';
import assert from 'node:assert/strict';
import {curtainShader} from './weather-curtain.js';
import {WeatherRuntime,POLAR_CELLS,ringDistance} from './weather.js';
import {WEATHER as W} from './weather-config.js';
import {MAELSTROM as M} from './cloud-config.js';
import {bakeLandMask} from './cloud-flow.js';
import {createRegistry,defaultManifest} from './tile-registry.js';

const mask=bakeLandMask(createRegistry(defaultManifest(undefined,undefined)));
const ctx=(o={})=>({dt:.05,eye:[0,300,0],time:500,centre:[1e6,1e6],mask,flow:undefined,enabled:true,regime:'ground',body:'azeroth',area:{name:'Elwynn Forest',cold:false},...o});
const warm=(rt,c,frames=80)=>{for(let i=0;i<frames;i++)rt.step({...c,time:c.time+i*.05});return rt;};
const wetSpot=(t=500)=>{const rt=new WeatherRuntime();rt.on=1;for(let x=-40000;x<=40000;x+=1000)for(let z=-40000;z<=40000;z+=1000)if(rt.sample(x,z,ctx({time:t}))>.9)return [x,z];throw new Error('no wet spot');};

test('polar grid is time-sliced, log-spaced, and refreshed within one sweep',()=>{
  const rt=new WeatherRuntime();
  assert.equal(rt.polar.length,POLAR_CELLS);
  assert(ringDistance(0)===W.polar.near&&Math.abs(ringDistance(W.polar.rings-1)-W.polar.far)<1e-6);
  const [x,z]=wetSpot();
  warm(rt,ctx({eye:[x,300,z]}),W.polar.azimuth/4);
  assert(rt.polar.some(v=>v>0)&&rt.polar.every(v=>v>=0&&v<=1));
});
test('a decent share of the surrounding sky is wet cell',()=>{
  let wet=0,n=0;
  for(let s=0;s<30;s++){const rt=new WeatherRuntime();warm(rt,ctx({eye:[-30000+s*2000,300,-20000+s*1300],time:2000+s*911}),16);for(const v of rt.polar){n++;if(v>=W.on)wet++;}}
  assert(wet/n>.01&&wet/n<.6,`wet fraction ${wet/n}`);
});
test('under a wet cell rain raises; dry zones never rain, snow zones report snow, orbit and Elune are silent',()=>{
  const [x,z]=wetSpot(),at=o=>ctx({eye:[x,300,z],...o});
  const rain=warm(new WeatherRuntime(),at({}));
  assert(rain.state.raining&&rain.state.kind==='rain'&&rain.local>.9,`${rain.state.kind} ${rain.local}`);
  const dry=warm(new WeatherRuntime(),at({area:{name:'Tanaris'}}));
  assert.equal(dry.local,0);assert(!dry.state.raining);assert(dry.polar.every(v=>v===0));
  const snow=warm(new WeatherRuntime(),at({area:{name:'Winterspring',cold:true}}));
  assert.equal(snow.state.kind,'snow');
  for(const o of [{regime:'orbit'},{body:'elune'},{enabled:false}]){
    const rt=warm(new WeatherRuntime(),at(o));
    assert.equal(rt.on,0);assert.equal(rt.state.intensity,0);assert(rt.polar.every(v=>v===0));assert(!rt.anyWet);
  }
});
test('from-altitude cloud look: orbit shows every cell (climate-free), Elune and off never do',()=>{
  const [x,z]=wetSpot(),at=o=>ctx({eye:[x,300,z],...o});
  assert.deepEqual(warm(new WeatherRuntime(),at({regime:'orbit'})).look,{wet:1,on:1});
  assert.deepEqual(warm(new WeatherRuntime(),at({regime:'orbit',area:{name:'Tanaris'}})).look,{wet:1,on:1});
  assert.deepEqual(warm(new WeatherRuntime(),at({regime:'atmosphere',area:{name:'Tanaris'}})).look,{wet:0,on:1});
  for(const o of [{body:'elune',regime:'orbit'},{enabled:false,regime:'orbit'}])assert.deepEqual(warm(new WeatherRuntime(),at(o)).look,{wet:0,on:0});
});
test('Maelstrom wall is heavy rain even in a dry zone, the eye is calm',()=>{
  const wall=warm(new WeatherRuntime(),ctx({centre:[0,0],eye:[M.wallRadius,300,0],  area:{name:'Tanaris'}}),300);
  assert(wall.local>=W.heavy&&wall.state.heavy,`wall ${wall.local}`);
  const eye=warm(new WeatherRuntime(),ctx({centre:[0,0],eye:[20,300,0]}));
  assert.equal(eye.local,0);assert(!eye.state.raining);
});
test('nearest wet cell is reported with distance and bearing, and the step is cheap',()=>{
  const rt=warm(new WeatherRuntime(),ctx({centre:[0,0],eye:[-9000,300,0]}),32);
  assert(rt.anyWet);assert(rt.nearest.distance<=W.polar.far&&rt.nearest.intensity>=W.on);
  const t0=performance.now();for(let i=0;i<200;i++)rt.step(ctx({centre:[0,0],eye:[-9000,300,0],time:3000+i*.05}));
  assert((performance.now()-t0)/200<3,'weather step under 3 ms');
});


test('distant rain reaches 48 kyd with log rings no coarser than ~1.6x and a soft far edge',()=>{
  assert(W.polar.far>=48000&&ringDistance(1)/ringDistance(0)<1.7);
  assert(curtainShader.includes('smoothstep(.8*R_FAR,R_FAR,r)'));
});
