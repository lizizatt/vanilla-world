import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WATER_NORMAL_SIZE,waterNormalMips,waterShading,WATER_LOOK,waterBody,LAKE_LOOK,lakeAlpha} from './water-shader.js';
import {WorldRenderer} from './world-renderer.js';
import {patchShader} from './space.js';

test('original water normals are deterministic, bounded and fully mip-filtered',()=>{
  const a=waterNormalMips(),b=waterNormalMips();
  assert.deepEqual(a,b);assert.equal(a.length,8);
  assert.equal(a.reduce((n,m)=>n+m.byteLength,0),87380);
  let previous=Infinity;
  for(let level=0;level<a.length;level++){
    const size=WATER_NORMAL_SIZE>>level,mip=a[level];
    assert.equal(mip.length,size*size*4);
    let energy=0;
    for(let i=0;i<mip.length;i+=4){
      assert.equal(mip[i+3],255);
      energy+=(mip[i]-128)**2+(mip[i+1]-128)**2;
    }
    energy/=size*size;
    assert(energy<=previous+1,'Distant mip levels must not amplify fine normal detail');
    previous=energy;
  }
  assert(previous<3,'The far mip approaches a flat surface');
  const mip=a[0],size=WATER_NORMAL_SIZE;
  for(let i=0;i<size;i++)for(const channel of [0,1]){
    assert(Math.abs(mip[(i*size)*4+channel]-mip[(i*size+size-1)*4+channel])<48);
    assert(Math.abs(mip[i*4+channel]-mip[((size-1)*size+i)*4+channel])<48);
  }
});

test('WMO water flags survive batch preparation without introducing texture dependencies',()=>{
  const renderer={scenePipeline:()=>({})};
  const [batch]=WorldRenderer.prototype.prepareBatches.call(renderer,[{water:true,blend:'opaque',texture:null}]);
  assert.equal(batch.water,true);assert.equal(batch.transparent,false);assert.equal(batch.texture,null);
  assert.throws(()=>WorldRenderer.prototype.prepareBatches.call(renderer,[{water:'yes'}]),/water flag/);
});

test('water follows the bent globe: normal and view use the sphere, supplied per shader by waterBendK',()=>{
  assert(waterShading.includes('waterBendK()'));assert(waterShading.includes('smoothstep(0.85,1.0,wbk)')&&!waterShading.includes('wbk*'),'sphere fresnel only at full bend (k is a 0..1 blend, not curvature): low/ground views keep the flat look');assert(waterShading.includes('normalize(up+vec3f(slope.x'));
  assert(!/reflection\.y/.test(waterShading),'sky reflection must use the sphere up, not world y');
  const shaders=readFileSync(new URL('./renderer-shaders.js',import.meta.url),'utf8');
  assert(shaders.includes('fn waterBendK()->f32 {return u.pad[0].x;}')&&shaders.includes('fn waterBendK()->f32 {return u.bend.x;}'));
});
test('patch far-hemisphere discard altitude scales with the planet radius (no pre-shrink 20000 yd constant)',()=>{
  assert(patchShader.includes('s.p.x>R*.4675')&&!patchShader.includes('s.p.x>20000.0'));
});
test('phase 1 water: real sun hook, slope-variance roughness, Beer-Lambert body, subsurface, crest foam and a pluggable wave field',()=>{
  assert(!waterShading.includes('vec3f(-.3,1.0,.4)'),'no hard-coded sun in the water shader');
  for(const hook of ['waterSun()','seaState()','waveField(world,wt,windK)','rainRipples('])assert(waterShading.includes(hook),hook);
  assert(/struct Wave \{h:f32,slope:vec2f,crest:f32\}/.test(waterShading));
  assert(waterShading.includes('alpha2')&&waterShading.includes('meanLen'),'GGX lobe widened by slope variance and Toksvig loss');
  assert(waterShading.includes('whitecap')&&waterShading.includes('dot(view,-sun)'));
  const shaders=readFileSync(new URL('./renderer-shaders.js',import.meta.url),'utf8');
  assert(shaders.includes('u.pad[1].xyz')&&shaders.includes('u.pad[2].xy'),'terrain water reads the real sun and sea state');
  assert.equal(shaders.split('fn waterSun()').length,3,'terrain and scene both define the hooks');
});
test('Beer-Lambert body colour: shore keeps the shallow colour, deep reaches the old deep blue, red is absorbed first',()=>{
  const shore=waterBody(0),deep=waterBody(1),mid=waterBody(.1);
  shore.forEach((c,i)=>assert(Math.abs(c-WATER_LOOK.shallow[i])<1e-9));
  deep.forEach((c,i)=>assert(Math.abs(c-WATER_LOOK.deep[i])<.012));
  const lost=i=>(shore[i]-mid[i])/(shore[i]-deep[i]);
  assert(lost(0)>lost(1)&&lost(1)>lost(2)&&lost(0)>.6,[0,1,2].map(lost).join());
  let last=waterBody(0);for(let d=.05;d<=1;d+=.05){const c=waterBody(d);assert(c[0]<=last[0]+1e-9);last=c;}
});
test('far-field slope variance stays below what the normal map actually holds',()=>{
  const mip=waterNormalMips()[0];let energy=0;
  for(let i=0;i<mip.length;i+=4){const z=mip[i+2]/255,x=(1-2*mip[i]/255),y=(1-2*mip[i+1]/255);energy+=(x*x+y*y)/(z*z)/2;}
  energy/=mip.length/4;
  assert(WATER_LOOK.farVariance<energy&&WATER_LOOK.farVariance>energy/6,`${energy}`);
});

test('lake alpha is translucent in the shallows, deepens with depth and stays inside the lake bounds',()=>{
  assert.equal(lakeAlpha(0),0);assert.equal(lakeAlpha(0,1),0);assert(lakeAlpha(LAKE_LOOK.edgeFade)>=LAKE_LOOK.minAlpha);
  assert(lakeAlpha(1)<=LAKE_LOOK.maxAlpha&&lakeAlpha(1)<1);
  let previous=0;
  for(let d=0;d<=1;d+=.05){const a=lakeAlpha(d);assert(a>=previous);previous=a;}
  assert.equal(lakeAlpha(-3),lakeAlpha(0));assert.equal(lakeAlpha(9),lakeAlpha(1));
  assert(lakeAlpha(.5,1)>lakeAlpha(.5)&&lakeAlpha(.5,1)<=1);
  assert(lakeAlpha(.1,.5)>lakeAlpha(.1));
});

test('lake variant shares the ocean shader: ocean path is lake=0, lakes calm waves and drop whitecaps',()=>{
  assert(LAKE_LOOK.slope<1&&LAKE_LOOK.slope>0);
  assert(waterShading.includes('fn waterShade(')&&waterShading.includes('lake:f32'));
  assert(waterShading.includes('waterShade(p,ramp,rampWidth,dx,dy,0.0).rgb'));
  assert(waterShading.includes('fn waterColorLake(')&&waterShading.includes('waterShade(p,ramp,rampWidth,dx,dy,1.0)'));
  assert(waterShading.includes('*(1.0-lake)'));
  assert(waterShading.includes(`mix(1.0,${LAKE_LOOK.slope.toFixed(2)},lake)`));
  assert(waterShading.includes('mix(1.0,lakeAlpha*edgeFade,lake)'));
  assert(waterShading.includes(`lake*${LAKE_LOOK.skyCalm.toFixed(2)}`));
  assert(waterShading.includes(`mix(1.0,${LAKE_LOOK.foam.toFixed(2)},lake)`));
});