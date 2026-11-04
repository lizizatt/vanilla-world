import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTIONS,Keymap,presetKeymap,cheatsheet} from './keymap.js';
import {pressHandlers,EXTERNAL_PRESS} from './app-input.js';

test('default chords do not collide within overlapping contexts',()=>{
  const k=presetKeymap('native');
  for(const a of ACTIONS)for(const c of k.keys(a.id))
    assert.deepEqual(k.conflicts(a.id,c).map(x=>x.id),[],`${a.id} ${c}`);
});

test('legacy profile brakes on Space, native drifts on Space',()=>{
  assert.ok(presetKeymap('legacy').canonical(new Set(['Space']),'drive').has('KeyX'));
  assert.ok(presetKeymap('native').canonical(new Set(['Space']),'drive').has('KeyC'));
});

test('rebinding swaps, persists sparsely and resets',()=>{
  const k=presetKeymap('native');
  k.bind('cam.cockpit',0,'KeyP');
  assert.ok(k.keys('cam.cockpit').includes('KeyP'));
  assert.ok(k.modified('cam.cockpit'));
  const back=Keymap.parse(JSON.stringify(k));
  assert.ok(back.keys('cam.cockpit').includes('KeyP'));
  k.reset();
  assert.ok(!k.modified('cam.cockpit'));
});

test('every press action has a handler or an external owner',()=>{
  const handlers=pressHandlers({settings:{},mapPanel:{}});
  for(const a of ACTIONS.filter(a=>a.kind==='press'))
    assert.ok(handlers[a.id]||EXTERNAL_PRESS.includes(a.id),a.id);
});

test('cheatsheet lists actions',()=>{assert.ok(JSON.stringify(cheatsheet(presetKeymap('native'),'all')).length>100);});

test('menu markup carries no hard-coded key hints; help is generated',async()=>{
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  for(const stale of ['(F9)','(U)','(M)','(G)','(T)','id="keyboard-guide"','N night'])assert.ok(!html.includes(stale),stale);
  assert.ok(html.includes('id="bindings"')&&html.includes('id="cheatsheet"'));
});

test('new defaults: race start R, cockpit H, fly/drive Tab, F unbound',()=>{
  const k=presetKeymap('native');
  assert.equal(k.label('race.start'),'R');assert.equal(k.label('cam.cockpit'),'H');assert.equal(k.label('ui.flyDrive'),'Tab');
  for(const a of ACTIONS)assert.ok(!k.keys(a.id).includes('KeyF'),a.id);
});

test('menu has a page and a main-menu entry for every sub-page, plus a back bar',async()=>{
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  for(const page of ['options','keys','controls','diagnostics','data']){
    assert.ok(html.includes(`data-page="${page}"`),page);assert.ok(html.includes(`<button type="button" data-tab="${page}">`),page);
  }
  assert.ok(html.includes('id="menu-back"'));
});
