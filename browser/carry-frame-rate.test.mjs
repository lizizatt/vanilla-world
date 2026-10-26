import test from 'node:test';
import assert from 'node:assert/strict';
import {stepShared} from './shared-flight.js';
import {ELUNE,centreAt} from './bodies.js';
import {SimClock} from './sim-clock.js';

/** Hover with no input over a fixed Elune ground point, driving the same per-frame loop as app-frame (carry at clock time, then clock.step) at a given real frame time. */
function hover({scale,dt,alt,seconds}) {
  const clock=new SimClock(1000,scale),start=[ELUNE.centre[0]+500,alt,ELUNE.centre[1]+300];
  let flight=start,space,spacePose,aim={look:[0,0,1],right:[1,0,0],up:[0,1,0]},drift=0;
  for(let e=0;e<seconds;e+=dt) {
    if(flight!==spacePose)space=undefined;
    const r=stepShared(space,flight,aim,{forward:0,strafe:0,lift:0,fast:false},dt,clock.now(),2*clock.scale,'elune');
    space=r.space;flight=r.pose;spacePose=r.pose;aim=r.aim??aim;
    clock.step(dt);
    drift=Math.max(drift,Math.hypot(flight[0]-start[0],flight[2]-start[2]));
  }
  return drift;
}

test('hovering over Elune stays over the same ground at any frame time and warp (incl. crossing the daily clock wrap)', () => {
  for(const scale of [1,10,100,1000])for(const dt of [.004,.016,.1,.25])for(const alt of [50,1500])
    assert.ok(hover({scale,dt,alt,seconds:scale>=100?20:60})<.5,`x${scale} dt ${dt} alt ${alt}`);
});

test('Elune rail stays continuous when the sim clock wraps at midnight', () => {
  const clock=new SimClock(2879.99,1),before=centreAt(ELUNE,clock.now());
  clock.step(.01);const after=centreAt(ELUNE,clock.now());
  assert.ok(Math.hypot(...before.map((v,i)=>v-after[i]))<50,'centre jumped at the wrap');
});
