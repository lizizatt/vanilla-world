import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {bendRel} from './space.js';

const src=f=>fs.readFileSync(new URL(f,import.meta.url),'utf8');

// bend() derives the eye latitude from eye.z, so it must get the absolute chart z, not the origin-local one.
test('every bend() call receives the absolute eye, never u.eye.xyz', () => {
  for (const f of ['./renderer-shaders.js','./water-shader.js']) {
    const calls=src(f).match(/\bbend\([^;]*;/g)||[];
    assert.ok(calls.length>0,f);
    for (const c of calls) assert.ok(!/,u\.eye\.xyz,/.test(c),`${f}: ${c}`);
  }
});

test('writeUniform uploads the absolute eye z into the slots bendEye() reads', () => {
  const w=src('./world-renderer.js');
  assert.match(w,/u\[base\+30\]=u\[base\+62\]=eyeZ/);
  assert.match(w,/eyeZ=this\.view\.eye\[2\]/);
  const s=src('./renderer-shaders.js');
  assert.match(s,/vec3f\(u\.eye\.x,u\.eye\.y,u\.pad\[0\]\.z\)/);
  assert.match(s,/vec3f\(u\.eye\.x,u\.eye\.y,u\.bend\.z\)/);
});

test('a local (origin-relative) eye bends about the wrong latitude', () => {
  const R=14260,centre=[1429,7490],eyeAbs=[-146,15374,3506],rel=[9000,-15374,0];
  const good=bendRel(rel,eyeAbs,1,R,centre);
  const bad=bendRel(rel,[0,15374,0],1,R,centre);
  assert.ok(Math.hypot(good[0]-bad[0],good[2]-bad[2])>100);
});
