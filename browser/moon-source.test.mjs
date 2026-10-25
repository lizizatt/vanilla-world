import test from 'node:test';
import assert from 'node:assert/strict';
import {moonSource,moonWdt,moonWdl,ELUNE_MAP,MOON_SEED} from './moon-source.js';
import {demoSource} from './demo-source.js';
import {moonAdt} from './moon-terrain.js';

test('serves WDT with 60x30 present tiles', async () => {
  const s=moonSource(),wdt=await s.read('World/Maps/Elune/Elune.wdt');
  const main=wdt.slice(wdt.length-4096*8);let n=0;for(let i=0;i<4096;i++)if(main[i*8])n++;
  assert.equal(n,1800);
  assert.equal(ELUNE_MAP,'Elune');
});

test('serves ADTs matching moonAdt, caches, rejects outside the chart', async () => {
  const s=moonSource(),a=await s.read('world/maps/elune/elune_30_15.adt');
  assert.deepEqual(a,moonAdt(MOON_SEED,30,15));
  assert.equal(await s.read('world/maps/elune/elune_30_15.adt'),a);
  for(const p of ['world/maps/elune/elune_60_0.adt','world/maps/elune/elune_0_30.adt','world/maps/azeroth/azeroth_1_1.adt'])
    await assert.rejects(s.read(p),{code:'NOT_FOUND'});
});

test('WDL has a MARE per tile and any texture resolves', async () => {
  const wdl=moonWdl(),s=moonSource();
  assert.ok(wdl.length>1800*(545*2+8));
  assert.equal((await s.read('Tileset/Elune/Regolith.blp'))[0],0x42);
  assert.equal(moonWdt().length,moonWdt().length);
});

test('demo source still works after helper exports', async () => {
  assert.ok((await demoSource().read('world/maps/kalimdor/kalimdor.wdt')).length>0);
});
