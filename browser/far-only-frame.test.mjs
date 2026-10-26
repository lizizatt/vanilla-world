import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldClient} from './world-client.js';

test('a far-only (departed or not-yet-parent) engine never asks its worker for near streaming', () => {
  const client=new WorldClient(()=>false,()=>{});
  client.flushFrame=()=>{};
  client.farOnly=true;
  client.frame(.016,0,0,0,[1,2,3],true);
  assert.equal(client.pendingFrame.farOnly,true);
  const near=new WorldClient(()=>false,()=>{});near.flushFrame=()=>{};
  near.frame(.016,0,0,0,[1,2,3],true);
  assert.notEqual(near.pendingFrame.farOnly,true);
});
