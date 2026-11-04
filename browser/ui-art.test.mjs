import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {UiArtService,UI_ART,NINE_SLICE} from './ui-art.js';
import {CSP} from './shell-manifest.mjs';

class FakeTexture {
  constructor(bytes) {this.size=bytes.byteLength;}
  metadata() {return JSON.stringify({width:this.size,height:32});}
  rgba() {return new Uint8Array(this.size*32*4);}
  free() {}
}

test('service posts decoded art and fonts once, and survives missing files',async()=>{
  const reads=[];
  const source={read:async path=>{reads.push(path);if(path.includes('Header')||path.includes('MORPHEUS'))throw new Error('missing');return new Uint8Array(path.endsWith('.TTF')?10:8).buffer.slice(0);}};
  const sent=[];
  const service=new UiArtService(source,(data,transfers)=>sent.push({data,transfers}),{SceneTexture:FakeTexture});
  await service.request();await service.request();
  assert.equal(sent.length,1);
  assert.deepEqual(Object.keys(sent[0].data.images).sort(),['background','border']);
  assert.deepEqual(Object.keys(sent[0].data.fonts),['friz']);
  assert.ok(reads.includes(UI_ART.border));
});

test('nine-slice covers every cell of the border strip exactly once',()=>{
  assert.deepEqual(NINE_SLICE.map(c=>c[0]).sort(),[0,1,2,3,4,5,6,7]);
});

test('CSP allows blob: images and fonts everywhere it is declared',async()=>{
  const places=[CSP(false),await readFile(new URL('./index.html',import.meta.url),'utf8'),await readFile(new URL('./hosting/_headers',import.meta.url),'utf8')];
  for(const text of places){assert.match(text,/img-src 'self' blob:/);assert.match(text,/font-src 'self' blob:/);}
});

test('no WoW art is committed next to the loader',async()=>{
  const {readdir}=await import('node:fs/promises');
  const files=await readdir(new URL('./',import.meta.url));
  assert.ok(!files.some(f=>/\.(blp|ttf)$/i.test(f)));
});
