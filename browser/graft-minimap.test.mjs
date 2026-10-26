import test from 'node:test';
import assert from 'node:assert/strict';
import {graftMinimapRows,REGOLITH_HASH} from './graft-source.js';
import {regolithBlp} from './moon-source.js';
import {sitesOf} from './elune-sites.js';

test('minimap rows alias each grafted tile to its source tile minimap', () => {
  const hash='0123456789abcdef0123456789abcdef.blp',trs=new TextEncoder().encode(`dir: Kalimdor\nKalimdor\\map35_16.blp\t${hash}\nKalimdor\\map99_99.blp\tffffffffffffffffffffffffffffffff.blp\n`);
  const out=new TextDecoder().decode(graftMinimapRows(trs,sitesOf('elune'),'Elune'));
  assert.ok(out.includes(`Elune\\map29_14.blp\t${hash}\n`));
  assert.ok(!out.includes('Elune\\map29_15'),'tiles without a source minimap get no row');
  assert.ok(out.includes('Kalimdor\\map99_99.blp'),'original rows are kept');
  assert.ok(out.includes(`Elune\\map28_15.blp\t${REGOLITH_HASH}\n`),'apron tiles get the regolith minimap');
    assert.ok(!out.includes(`Elune\\map30_15.blp\t${REGOLITH_HASH}`),'grafted tiles are not apron');
  assert.equal(regolithBlp().length,148+1024+64*64);
});
