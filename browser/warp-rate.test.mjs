import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('flight carry uses the scale the renderer will apply this frame, so a warp change does not fling the camera off the ground (doodads stay in range)', () => {
  const src=fs.readFileSync(new URL('./app-frame.js',import.meta.url),'utf8');
  assert.match(src,/2\*Math\.min\(sanitiseScale\(settings\.timeScale\),app\.renderer\.warpCap\?\?Infinity\)/);
  assert.doesNotMatch(src,/renderer\.clock\?\.scale\?\?1/);
});
