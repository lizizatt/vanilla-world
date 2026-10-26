import test from 'node:test';
import assert from 'node:assert/strict';
import {AZEROTH,ELUNE,BODIES,toInertial,centreAt,parentOf,altitudeAbove} from './bodies.js';
import {overSite,nearBody} from './elune-pose.js';
import {SITES} from './elune-sites.js';

test('the map landing pose hangs over the Moonglade site inside Elune\'s well, at the requested height', () => {
  for(const t of [0,720,1547.58]) {
    const pose=overSite(ELUNE,250,t),at=toInertial(AZEROTH,pose,t);
    assert.equal(parentOf(at,t),'elune');
    const alt=altitudeAbove(ELUNE,at,t);
    assert.ok(alt>150&&alt<450,`altitude ${alt} at t=${t}`);// ground height varies from the mean sphere by under 100 yd
  }
});

test('a body without a site falls back to the standoff pose', () => {
  const moon={...ELUNE,id:'nowhere'};
  assert.deepEqual(overSite(moon,250,720),nearBody(moon,30000,720));
  assert.ok(SITES.elune.length>0&&BODIES.elune&&centreAt(ELUNE,0));
});
