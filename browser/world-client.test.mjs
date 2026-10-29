import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldClient} from './world-client.js';
import {basis} from './orient.js';

test('orbital mouse deltas accumulate behind an in-flight frame while hold and stick keep latest state',()=>{
  const sent=[],client=new WorldClient(()=>true,()=>{});
  client.worker={postMessage:m=>sent.push(m)};client.inFlight=true;
  const frame=c=>client.frame(.005,0,0,0,undefined,true,undefined,0,720,true,c);
  frame({active:true,mouse:[.1,.2],stick:[1,0]});
  frame({active:true,mouse:[.2,-.1],stick:[0,1]});
  frame({active:false,mouse:[0,0],stick:[0,0]});
  client.inFlight=false;client.flushFrame();
  assert(Math.abs(sent[0].podControl.mouse[0]-.3)<1e-10);assert.equal(sent[0].podControl.mouse[1],.1);
  assert.equal(sent[0].podControl.active,false);assert.deepEqual(sent[0].podControl.stick,[0,0]);
  client.discardFrame();frame({active:false,mouse:[0,0],stick:[0,0]});
  assert.deepEqual(client.pendingFrame.podControl.mouse,[0,0]);
});
test('confirmed orbital attitude interpolates shortest quaternion arc and preserves roll',()=>{
  const client=new WorldClient(()=>true,()=>{}),q=[.2,.3,.4,.7].map(v=>v/Math.sqrt(.78));
  for(const [poseTime,sign] of [[100,1],[120,-1]]){
    const telemetry=[...Array(18).fill(0),...q.map(v=>v*sign)];
    client.recordPose({poseTime,telemetry});
  }
  const presented=client.presentation(140).slice(18),look=basis(presented).look;
  assert(Math.abs(Math.hypot(...presented)-1)<1e-12);
  assert(Math.hypot(...look.map((v,i)=>v-basis(q).look[i]))<1e-12);
  assert.throws(()=>client.recordPose({poseTime:130,telemetry:[...Array(18).fill(0),0,0,0,0]}),/Invalid confirmed vehicle pose/);
});

test('pitch coalesces with continuous inputs, is neutral in flight and uses confirmed pose interpolation',()=>{
  const sent=[],client=new WorldClient(()=>true,()=>{});
  client.worker={postMessage:m=>sent.push(m)};
  client.inFlight=true;
  client.frame(.01,1,0,0,undefined,true,undefined,1);
  client.frame(.01,-1,0,0,undefined,true,undefined,-.5);
  client.inFlight=false;client.flushFrame();
  assert.equal(sent[0].pitch,-.5);assert.equal(sent[0].throttle,-1);assert.equal(sent[0].dt,.02);
  client.frame(.01,1,0,0,[0,100,0],true,undefined,1);
  assert.equal(client.pendingFrame.pitch,0);
  client.discardFrame();assert.equal(client.pendingFrame,undefined);
  client.poseFlying=false;
  for(const [poseTime,pitch] of [[100,-.2],[120,.2]]){
    const telemetry=Array(18).fill(0);telemetry[17]=pitch;
    client.recordPose({poseTime,telemetry});
  }
  assert(Math.abs(client.presentation(140)[17])<1e-12);
  assert.equal(client.state.telemetry[17],.2,'Presentation must not predict or mutate authoritative pitch');
});

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
