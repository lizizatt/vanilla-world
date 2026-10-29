import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {poleBodySource,poleAdt,POLE_TILES,poleHeightChart} from './pole-source.js';
import * as pkg from './pkg/flats_racer_web.js';

const read=(s,p)=>s.read(p);
test('pole body source serves the 16x16 frame under the Elune map name', async()=>{
  const s=poleBodySource('elune:N');
  assert.match(s.fingerprint,/pole-elune-N/);
  assert.deepEqual(Buffer.from(await read(s,'World\\Maps\\Elune\\Elune_3_5.adt')),Buffer.from(poleAdt('elune','N',3,5)));
  await assert.rejects(read(s,'World\\Maps\\Elune\\Elune_16_0.adt'),{code:'NOT_FOUND'});
  const a=await read(s,'World/Maps/Elune/Elune_3_5.adt'),b=await read(s,'world\\maps\\elune\\elune_3_5.adt');
  assert.notEqual(a.buffer,b.buffer);
});
test('rejects unknown bodies and frames', ()=>{
  assert.throws(()=>poleBodySource('mars:N'));
  assert.throws(()=>poleBodySource('elune:E'));
});
test('the engine manifest builder accepts the frame: one centred region, spawn at the pole', async()=>{
  pkg.initSync({module:readFileSync(new URL('./pkg/flats_racer_web_bg.wasm',import.meta.url))});
  for(const spec of ['elune:N','elune:S','azeroth:N','azeroth:S']) {
    const s=poleBodySource(spec),m=JSON.parse(pkg.moon_manifest(await s.read('World\\Maps\\Elune\\Elune.wdt'),await s.read('World\\Maps\\Elune\\Elune.wdl')));
    assert.equal(m.regions.length,1);assert.deepEqual(m.regions[0].tile_count,[POLE_TILES,POLE_TILES]);
    assert.equal(m.tiles.length,POLE_TILES*POLE_TILES);
    const r=m.regions[0];assert.equal(r.placement[0],-POLE_TILES*1600/3/2);
    assert.deepEqual([m.spawn[0],m.spawn[2]],[0,0]);
  }
  assert.ok(Number.isFinite(poleHeightChart('elune','N',0,0)));
});
