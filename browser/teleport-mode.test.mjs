import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {teleportModePlan,seatPose,flyFromDrive,SEAT_LADDER,POLE_STANDOFF} from './teleport-mode.js';
import {POLE_ANCHORS} from './frames.js';

test('pole teleports: both bodies, drive seats the pod short of the pole, fly carries the frame',()=>{
  for(const body of ['azeroth','elune'])for(const pole of ['N','S']) {
    const active=body==='azeroth'?'azeroth':'azeroth',a=POLE_ANCHORS[pole];
    const drive=teleportModePlan({body,pole},active,true),fly=teleportModePlan({body,pole},active,false);
    assert.equal(drive.mode,'drive');assert.equal(fly.mode,'fly');
    assert.equal(drive.frame,pole);assert.equal(fly.frame,pole);
    assert.equal(drive.swap,body!==active);
    assert.deepEqual(drive.seat,[a[0],0,a[1]-POLE_STANDOFF,Math.PI]);
    assert.equal(fly.flight[3],Math.PI,'fly arrival faces the pole');
    assert.deepEqual(fly.pose,fly.flight);assert.equal(fly.flight[2],a[1]-POLE_STANDOFF);
  }
  assert.throws(()=>teleportModePlan({body:'azeroth',pole:'X'},'azeroth',true));
});
import {podGravityFor,podGravityScale} from './bodies.js';

test('driving to Elune seats the pod on the site ground, flying stays flying',()=>{
  const drive=teleportModePlan({body:'elune'},'azeroth',true);
  assert.equal(drive.mode,'drive');assert.equal(drive.swap,true);
  assert.equal(drive.seat.length,4);assert.ok(drive.seat[1]<drive.flight[1]);
  const fly=teleportModePlan({body:'elune'},'azeroth',false);
  assert.equal(fly.mode,'fly');assert.equal(fly.seat,undefined);assert.equal(fly.flight.length,5);
});
test('Azeroth icons keep the current vehicle mode, also coming back from Elune',()=>{
  assert.equal(teleportModePlan({pose:[0,0,0,0]},'elune',true).mode,'drive');
  const f=teleportModePlan({pose:[0,0,0,0]},'azeroth',false);
  assert.equal(f.mode,'fly');assert.ok(f.lift>0);
  assert.equal(teleportModePlan({body:'azeroth'},'elune',true).swap,true);
});
test('seat ladder rises with attempts and clamps',()=>{
  const seat=[1,100,2,0.5];
  assert.equal(seatPose(seat,0)[1],100+SEAT_LADDER[0]);
  assert.equal(seatPose(seat,99)[1],100+SEAT_LADDER.at(-1));
  assert.deepEqual(flyFromDrive([1,2,3,4],10),[1,12,3,4,0]);
});
test('pod gravity is 0.5x on Elune and round-trips across swaps',()=>{
  assert.equal(podGravityScale('elune'),0.5);
  assert.equal(podGravityFor(48,'azeroth','elune'),24);
  assert.equal(podGravityFor(24,'elune','azeroth'),48);
  assert.equal(podGravityFor(48,'azeroth','azeroth'),48);
});
test('app wiring uses the mode plan and per-body gravity',()=>{
  assert.match(readFileSync(new URL('./world-app.js',import.meta.url),'utf8'),/teleportModePlan\(icon,activeBody\(\)\.id,!app\.flight\)/);
  const l=readFileSync(new URL('./app-loading.js',import.meta.url),'utf8');
  assert.match(l,/podGravityFor\(values\[14\],prev\.id,parentId\)/);
});

test('the Elune seat faces the site spawnYaw (a heading clear of the grove), not a hard-coded 0',async()=>{
  const {sitesOf}=await import('./elune-sites.js');const yaw=sitesOf('elune')[0].spawnYaw;
  assert.ok(Number.isFinite(yaw)&&yaw!==0);
  assert.equal(teleportModePlan({body:'elune'},'azeroth',true).seat[3],yaw);
});
