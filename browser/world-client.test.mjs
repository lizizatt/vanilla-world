import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldClient} from './world-client.js';

test('a far-only client marks flying frames so its engine skips near streaming', () => {
  const sent=[],client=new WorldClient(()=>true,()=>{});
  client.worker={postMessage:m=>sent.push(m)};client.farOnly=true;
  client.frame(.016,0,0,0,[1,2,3]);
  const frame=sent.find(m=>m.action==='frame');
  assert.ok(frame,'frame posted');assert.equal(frame.farOnly,true);
});
test('a normal client never sets farOnly', () => {
  const sent=[],client=new WorldClient(()=>true,()=>{});
  client.worker={postMessage:m=>sent.push(m)};
  client.frame(.016,0,0,0,[1,2,3]);
  assert.equal(sent.find(m=>m.action==='frame')?.farOnly,undefined);
});
