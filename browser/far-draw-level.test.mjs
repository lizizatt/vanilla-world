import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AZEROTH,ELUNE,angularRadius,farDrawLevel,FAR_DRAW} from './bodies.js';

test('angular radius shrinks with altitude and is capped at a quarter turn on the surface',()=>{
  assert.ok(Math.abs(angularRadius(ELUNE,0)-Math.PI/2)<1e-9);
  assert.ok(angularRadius(ELUNE,1e5)<angularRadius(ELUNE,1e4));
});

test('far-only bodies: skip when sub-pixel, sphere only when small, full patches when large',()=>{
  // Azeroth seen from Elune's orbit (about 100 kyd away) is large; from far outside the system it is a dot.
  assert.equal(farDrawLevel(AZEROTH,1e5),'full');
  assert.equal(farDrawLevel(AZEROTH,2e6),'sphere');
  assert.equal(farDrawLevel(AZEROTH,2e7),'skip');
  const r=AZEROTH.radius;
  assert.equal(farDrawLevel(AZEROTH,r/Math.sin(FAR_DRAW.patchRadius)-r+1),'sphere');
  assert.equal(farDrawLevel(AZEROTH,r/Math.sin(FAR_DRAW.patchRadius)-r-1),'full');
});

test('drawBodies consults the level for both the sphere and the patch mesh',()=>{
  const src=readFileSync(new URL('./renderer-sky.js',import.meta.url),'utf8');
  assert.match(src,/level==='skip'\)continue/);
  assert.match(src,/pf\.mesh&&level==='full'/);
});
