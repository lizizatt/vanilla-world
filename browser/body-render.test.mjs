import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bendShader,spaceShader,patchShader,bendShaderFor,spaceShaderFor,patchShaderFor,PLANET_RADIUS,WORLD_CENTRE} from './space.js';
import {bodyDrawList,depthRange,depthLayers,angularRadius} from './body-render.js';
import {ELUNE,AZEROTH,centreAt,toInertial} from './bodies.js';

const sha=s=>createHash('sha1').update(s).digest('hex').slice(0,12);

test('Azeroth shaders are byte-identical to the current radius-baked strings', () => {
  assert.equal(sha(bendShader),'41571a04c875');
  assert.equal(sha(spaceShader),'98a3383f7338');
  assert.equal(sha(patchShader),'0707783600e1');
  assert.equal(bendShader,bendShaderFor(PLANET_RADIUS,WORLD_CENTRE));
  assert.equal(patchShader,patchShaderFor(PLANET_RADIUS));
});

test('per-body shaders bake that body radius only', () => {
  const s=spaceShaderFor(ELUNE.radius),b=bendShaderFor(ELUNE.radius,ELUNE.centre);
  assert.ok(s.includes(`const R=${ELUNE.radius};`)&&!s.includes('42785'));
  assert.ok(b.includes(`let R=${ELUNE.radius};`));
  assert.ok(!patchShaderFor(ELUNE.radius).includes('@fragment fn fs'));
});

test('draw list is far to near and impostors only when small', () => {
  const t=0,onAz=toInertial(AZEROTH,[0,100,0],t),l=bodyDrawList(onAz,t);
  assert.deepEqual(l.map(x=>x.id),['elune','azeroth']);
  assert.equal(l[0].mode,'patches');assert.equal(bodyDrawList([4e7,0,0],t)[0].mode,'impostor');assert.equal(l[1].mode,'patches');
  const c=centreAt(ELUNE,t),nearMoon=[c[0]+ELUNE.radius+200,c[1],c[2]];
  const m=bodyDrawList(nearMoon,t);
  assert.equal(m[1].id,'elune');assert.equal(m[1].mode,'patches');
  assert.ok(angularRadius(ELUNE,nearMoon,t)>1);
});

test('depth range adapts and layers split only at extreme ratios', () => {
  const t=0,ground=depthRange(toInertial(AZEROTH,[0,2,0],t),t);
  assert.equal(ground.near,.25);
  const c=centreAt(ELUNE,t),mid=[c[0]+1e5*0+ELUNE.radius+20000,c[1],c[2]],r=depthRange(mid,t);
  assert.ok(r.near>=.25&&r.far>1e5);
  assert.equal(depthLayers(mid,t).length,1);
  assert.equal(depthLayers(toInertial(AZEROTH,[0,2,0],t),t).length,1);
  const ls=depthLayers(toInertial(AZEROTH,[0,.1,0],t),t,{minNear:.01});
  assert.equal(ls.length,2);
  for(const l of ls)assert.ok(l.far/l.near<=1e7);
});
