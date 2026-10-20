import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WATER_NORMAL_SIZE,waterNormalMips} from './water-shader.js';
import {WorldRenderer} from './world-renderer.js';

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
