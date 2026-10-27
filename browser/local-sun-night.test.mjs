import test from 'node:test';
import assert from 'node:assert/strict';
import {localNightShadingFor} from './water-shader.js';

test('airless bodies use the local sun at every point with a wide terminator ramp; atmospheric keep the old ramp',()=>{
  const air=localNightShadingFor(5000,true),atm=localNightShadingFor(14260);
  assert.match(air,/select\(clamp\([^)]*\),1\.0,true&&/);
  assert.match(air,/smoothstep\(-\.12,\.7,/);
  assert.match(atm,/,1\.0,false&&/);
  assert.match(atm,/smoothstep\(-\.12,\.25,/);
});
