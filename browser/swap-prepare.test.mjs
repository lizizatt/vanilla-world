import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bodyPrepared} from './renderer-init.js';

const read=f=>readFileSync(new URL(f,import.meta.url),'utf8');

test('a body counts as prepared only with both its surface and planet sets',()=>{
  assert.equal(bodyPrepared({surfaceSets:{elune:{}},planetSets:{}},'elune'),false);
  assert.equal(bodyPrepared({surfaceSets:{},planetSets:{elune:{}}},'elune'),false);
  assert.equal(bodyPrepared({surfaceSets:{elune:{}},planetSets:{elune:{}}},'elune'),true);
  assert.equal(bodyPrepared(undefined,'elune'),false);
});

test('prepareBody shares one build per body so a swap joins the background warm-up instead of compiling again',()=>{
  const src=read('./renderer-init.js');
  assert.match(src,/r\.preparing\[body\.id\]\?\?=prepareBodyNow/);
});

test('map teleport waits for the target body pipelines, not just its engine, before swapping',()=>{
  assert.match(read('./world-app.js'),/e\.info&&app\.renderer\?\.bodyPrepared\?\.\(plan\.body\)/);
});
