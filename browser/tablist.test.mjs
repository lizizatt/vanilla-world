import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tablist} from './tablist.js';

test('tablist is a real tablist with roving tabindex and WoW styling', () => {
  const src=readFileSync(new URL('./tablist.js',import.meta.url),'utf8');
  for(const k of ["'tablist'","'tab'",'aria-selected','tabIndex','ArrowRight','ArrowLeft','Home','End'])assert.ok(src.includes(k),k);
  assert.equal(typeof tablist,'function');
  const css=readFileSync(new URL('./ui-shell.css',import.meta.url),'utf8');
  assert.match(css,/\.wow-tabs button\[aria-selected=true\]/);
});

test('Options and Controls share the tablist', () => {
  for(const f of ['options-ui.js','keys-ui.js'])assert.match(readFileSync(new URL(`./${f}`,import.meta.url),'utf8'),/from '\.\/tablist\.js'/,f);
});