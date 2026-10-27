import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudShader,cloudShaderHigh,FAR_COVER,FAR_ABSORB} from './clouds.js';

test('far-view cloud boost is scaled by the space factor, so the ground look is untouched',()=>{
  for(const src of [cloudShader,cloudShaderHigh]){
    assert.ok(src.includes(`+${FAR_COVER}*c.bend.y,0.0,.95)`));
    assert.ok(src.includes(`.008*(1.0+${FAR_ABSORB}*c.bend.y)`));
  }
  assert.ok(FAR_COVER>0&&FAR_ABSORB>0);
});
