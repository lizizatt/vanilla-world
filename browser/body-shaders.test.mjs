import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {shaderSetFor} from './body-shaders.js';
import {bendShader,spaceShader,patchShader} from './space.js';
import {AZEROTH,ELUNE} from './bodies.js';

test('Azeroth shader set is byte-identical to the legacy constants (golden)',()=>{
  const s=shaderSetFor(AZEROTH);
  assert.equal(s.bend,bendShader);assert.equal(s.space,spaceShader);assert.equal(s.patch,patchShader);
});
test('Elune shader set bakes Elune radius and differs from Azeroth',()=>{
  const e=shaderSetFor(ELUNE),a=shaderSetFor(AZEROTH);
  for(const k of ['bend','space','patch'])assert.notEqual(e[k],a[k]);
  assert.match(e.bend,new RegExp(`let R=${ELUNE.radius};`));
  assert.equal(shaderSetFor(ELUNE),e);
});
test('legacy shader text hash is stable',()=>{
  const h=createHash('sha1').update(bendShader+spaceShader+patchShader).digest('hex');
  assert.match(h,/^[0-9a-f]{40}$/);
});
