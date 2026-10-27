import test from 'node:test';
import assert from 'node:assert/strict';
import {skyShader,skyDomeShader} from './sky.js';

// The starfield dome is drawn after the sky pass, so it must mask the moon discs itself.
const orbit=src=>[...src.matchAll(/(?:moon|moonCover)\(d,([^;]*?),\.(\d+)(?:,|\))/g)].map(m=>m[1].replace(/\s/g,'')+'|'+m[2]);

test('star dome masks the same moon discs the sky pass draws', () => {
  const sky=orbit(skyShader.replace(/fn moon\(.*/,'')),dome=orbit(skyDomeShader.replace(/fn moonCover\(.*/,''));
  assert.equal(sky.length,2);
  assert.deepEqual(dome,sky.map(s=>s.replace('t*','q*').replace('cos(t','cos(q').replace('h1','cos(q)')));
});

test('star dome fades alpha by moon coverage', () => {
  assert.match(skyDomeShader,/fn moonCover/);
  assert.match(skyDomeShader,/\(1\.0-cover\)/);
});
