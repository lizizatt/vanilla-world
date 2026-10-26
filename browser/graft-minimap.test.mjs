import test from 'node:test';
import assert from 'node:assert/strict';
import {graftMinimapRows,REGOLITH_HASH} from './graft-source.js';
import {regolithBlp} from './moon-source.js';
import {sitesOf,tilesOf} from './elune-sites.js';

test('minimap rows alias, regolith-fill or mask each grafted tile by where the dome circle falls', () => {
  const site=sitesOf('elune')[0],tiles=tilesOf(site),skipped=tiles[0],hash='0123456789abcdef0123456789abcdef.blp';
  const trs=new TextEncoder().encode(`dir: Kalimdor\n${tiles.slice(1).map(t=>`Kalimdor\\map${t.sx}_${t.sy}.blp\t${hash}\n`).join('')}Kalimdor\\map99_99.blp\tffffffffffffffffffffffffffffffff.blp\n`);
  const out=new TextDecoder().decode(graftMinimapRows(trs,[site],'Elune'));
  const hashes=tiles.map(t=>out.split('\n').find(l=>l.startsWith(`Elune\\map${t.dx}_${t.dy}.blp`))?.split('\t')[1]);
  assert.ok(hashes.includes(REGOLITH_HASH)||hashes.some(h=>h?.endsWith('e1.blp')),'no tile keeps the unmasked minimap unless wholly inside the circle');
  assert.ok(hashes.includes(REGOLITH_HASH),'tiles wholly outside get regolith');
  assert.ok(hashes.some(h=>h?.endsWith('e1.blp')&&h!==REGOLITH_HASH),'tiles the circle cuts get a masked minimap');
  assert.equal(hashes[0],undefined,'tiles without a source minimap get no row');
  assert.ok(skipped&&out.includes('Kalimdor\\map99_99.blp'),'original rows are kept');
  assert.equal(regolithBlp().length,148+1024+64*64);
});
