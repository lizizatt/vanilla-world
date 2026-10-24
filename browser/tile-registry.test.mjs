import test from 'node:test';
import assert from 'node:assert/strict';
import {createRegistry,defaultManifest,proceduralProvider,rectBounds,OCEAN} from './tile-registry.js';
import {FALLBACK_RECTS,globeToFlat,PLANET_RADIUS} from './space.js';

test('uncovered bins are open ocean',() => {
  const r=createRegistry(defaultManifest());
  assert.deepEqual(r.sample(0,Math.PI),{...OCEAN,land:0});
  assert.equal(r.cover(0,Math.PI).length,0);
});

test('continent interior is land, edge feathers to ocean',() => {
  const r=createRegistry(defaultManifest()),[a0,a1,o0,o1]=rectBounds(FALLBACK_RECTS[0]);
  const mid=r.sample((a0+a1)/2,(o0+o1)/2),edge=r.sample(a0+1e-9,(o0+o1)/2);
  assert.equal(mid.water,false);
  assert(Math.abs(edge.h-OCEAN.h)<1,'edge height meets ocean (no step)');
  assert(edge.rgb.every((v,i)=>Math.abs(v-OCEAN.rgb[i])<.01),'edge colour meets ocean');
});

test('custom irregular chunk added later, higher priority wins in overlap',() => {
  const r=createRegistry(defaultManifest()),[a0,a1,o0,o1]=rectBounds(FALLBACK_RECTS[0]);
  const lat=(a0+a1)/2,lon=(o0+o1)/2,w=3000/PLANET_RADIUS;
  r.add({id:'maelstrom',kind:'poi',priority:5,blend:0,bounds:[lat-w,lat+w,lon-w,lon+w],provider:proceduralProvider({height:500,rgb:[1,0,0]})});
  assert.deepEqual(r.sample(lat,lon).rgb,[1,0,0]);
  assert.equal(r.chunks.at(-1).id,'maelstrom');
});

test('flat rect bounds round-trip through globeToFlat',() => {
  const [a0,,o0]=rectBounds(FALLBACK_RECTS[1]),[x,z]=globeToFlat(a0,o0);
  assert(Math.abs(x-FALLBACK_RECTS[1][0])<1e-6&&Math.abs(z-FALLBACK_RECTS[1][3])<1e-6);
});
