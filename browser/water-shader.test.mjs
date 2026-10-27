import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WATER_NORMAL_SIZE,waterNormalMips,waterShading} from './water-shader.js';
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