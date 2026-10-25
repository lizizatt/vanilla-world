import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {terrainShader,splatShader} from './renderer-shaders.js';
import {localNightShading} from './water-shader.js';

test('terrain and horizon fragments add the globe limb glow so chunked sea matches the globe from orbit',()=>{
  assert.match(localNightShading,/fn limbGlow/);
  assert.match(terrainShader,/limbGlow\(v\.p\)/);
  assert.match(splatShader,/limbGlow\(v\.p\)/);
});

test('flat ocean mesh stays until the whirlpool fade ends so the Maelstrom arms persist',()=>{
  const m=/OCEAN_MESH_CEILING=(\d+)/.exec(readFileSync(new URL('./world-renderer.js',import.meta.url),'utf8'));
  assert.ok(Number(m[1])>=90000);
});
