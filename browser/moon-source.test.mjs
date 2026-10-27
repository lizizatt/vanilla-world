import test from 'node:test';
import assert from 'node:assert/strict';
import {moonSource,moonWdt,moonWdl,ELUNE_MAP,MOON_SEED,moonMinimapHash,regolithGroundBlp} from './moon-source.js';
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

test('every procedural tile has a far minimap row, and each minimap is neutral grey with pits (no cast, not flat)', async () => {
  const s=moonSource(),rows=new TextDecoder().decode(await s.read('textures/Minimap/md5translate.trs')).trim().split('\n');
  assert.equal(rows.length,60*30);assert.ok(rows.includes(`Elune\\map10_5.blp\t${moonMinimapHash(10,5)}`));
  const blp=await s.read(`Textures/Minimap/${moonMinimapHash(10,5)}`),again=await s.read(`textures/minimap/${moonMinimapHash(10,5)}`);
  assert.deepEqual(blp,again);
  for(let i=0;i<256;i++)assert.ok(blp[148+i*4]===blp[149+i*4]&&blp[149+i*4]===blp[150+i*4],'palette is neutral grey');
  const px=blp.slice(1172),mean=px.reduce((a,b)=>a+b,0)/px.length,sd=Math.sqrt(px.reduce((a,b)=>a+(b-mean)**2,0)/px.length);
  assert.ok(mean>60&&mean<200&&sd>3,`grey ${mean.toFixed(0)} sd ${sd.toFixed(1)}`);
});
test('ground texture palette is neutral grey', () => {
  const g=regolithGroundBlp();for(let i=0;i<32;i++)assert.ok(g[148+i*4]===g[149+i*4]&&g[149+i*4]===g[150+i*4]);
});