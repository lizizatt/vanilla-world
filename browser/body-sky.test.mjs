import test from 'node:test';
import assert from 'node:assert/strict';
import {relativeCentre,viewFrom} from './body-sky.js';
import {spaceUniform} from './space.js';
import {AZEROTH,ELUNE,centreAt} from './bodies.js';

const view={eye:[1429,1000,-3000],look:[0,0,-1],right:[1,0,0],up:[0,1,0],aspect:1.6};
const pf={space:1,globe:1,mesh:false,registry:false},sun=[0,1,0];

test('without a body option the uniform is unchanged (Azeroth golden)',()=>{
  const a=spaceUniform(view,sun,pf,[],700,.5,200000),b=spaceUniform(view,sun,pf,[],700,.5,200000,undefined,undefined);
  assert.deepEqual([...a],[...b]);
});
test('Elune seen from Azeroth sits at its real distance and size',()=>{
  const t=700,r=relativeCentre(AZEROTH,ELUNE,t);
  assert.ok(Math.abs(Math.hypot(...r)-100000)<1e-6);
  const u=spaceUniform(view,sun,pf,[],t,.5,200000,undefined,viewFrom(AZEROTH,t));
  assert.equal(u[51],Math.fround(ELUNE.radius));
});
test('Azeroth from Elune is 100000 yd away at the tidal-lock zenith direction',()=>{
  const t=900,r=relativeCentre(ELUNE,AZEROTH,t);
  assert.ok(Math.abs(Math.hypot(...r)-100000)<1e-6);
  assert.ok(r[0]/100000>.999999,'+X faces Azeroth');
  const u=spaceUniform({...view,eye:[0,500,0]},sun,pf,[],t,.5,200000,undefined,viewFrom(ELUNE,t));
  assert.equal(u[51],Math.fround(AZEROTH.radius));assert.equal(u[15],Math.fround(ELUNE.radius));
});
