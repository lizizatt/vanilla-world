import test from 'node:test';
import assert from 'node:assert/strict';
import {graftMinimapRows} from './graft-source.js';
import {sitesOf} from './elune-sites.js';

test('minimap rows alias each grafted tile to its source tile minimap', () => {
  const hash='0123456789abcdef0123456789abcdef.blp',trs=new TextEncoder().encode(`dir: Kalimdor\nKalimdor\\map35_16.blp\t${hash}\nKalimdor\\map99_99.blp\tffffffffffffffffffffffffffffffff.blp\n`);
  const out=new TextDecoder().decode(graftMinimapRows(trs,sitesOf('elune'),'Elune'));
  assert.ok(out.includes(`Elune\\map29_10.blp\t${hash}\n`));
  assert.ok(!out.includes('Elune\\map29_11'),'tiles without a source minimap get no row');
  assert.ok(out.includes('Kalimdor\\map99_99.blp'),'original rows are kept');
});
