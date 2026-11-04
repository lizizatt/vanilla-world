import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Keymap} from './keymap.js';
import {keyboardModel,padModel,isDismissKey,tutorialSeen,markTutorialSeen,TUTORIAL_KEY} from './tutorial.js';

const keyOf=(model,code)=>model.flat().find(k=>k.code===code);
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};};

test('keyboard diagram follows the keymap, including rebinds', () => {
  const km=new Keymap();
  assert.ok(keyOf(keyboardModel(km),'KeyR').actions.some(a=>a.text==='Start race / race again'));
  assert.ok(keyOf(keyboardModel(km),'KeyR').actions.some(a=>a.text==='Shift+Radio'));
  assert.ok(keyOf(keyboardModel(km),'F4').actions.some(a=>a.text==='Fly / Drive'));
  assert.equal(keyOf(keyboardModel(km),'Tab'),undefined);
  km.bind('ui.garage',0,'KeyB');
  assert.ok(keyOf(keyboardModel(km),'KeyB').actions.some(a=>a.text==='Garage'));
  assert.ok(!keyOf(keyboardModel(km),'KeyG').actions.some(a=>a.text==='Garage'));
});

test('gamepad diagram comes from the registry pad labels', () => {
  const pad=Object.fromEntries(padModel().map(s=>[s.id,s.actions.map(a=>a.text)]));
  assert.ok(pad.rt.includes('Throttle'));
  assert.ok(pad.start.includes('Fly / Drive'));
  assert.ok(pad.back.includes('Menu / back one layer'));
});

test('R dismisses the tutorial but Shift+R (radio) does not; the seen flag persists', () => {
  assert.ok(isDismissKey({code:'KeyR'}));
  assert.ok(!isDismissKey({code:'KeyR',shiftKey:true}));
  assert.ok(!isDismissKey({code:'KeyG'}));
  const s=store();
  assert.equal(tutorialSeen(s),false);
  markTutorialSeen(s);
  assert.equal(s.getItem(TUTORIAL_KEY),'1');
  assert.equal(tutorialSeen(s),true);
});

test('markup has the tutorial dialog and the Controls page offers the diagram', () => {
  assert.match(readFileSync(new URL('./index.html',import.meta.url),'utf8'),/id="tutorial"[^>]*hidden/);
  assert.match(readFileSync(new URL('./keys-ui.js',import.meta.url),'utf8'),/id:'diagram'/);
});