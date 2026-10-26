import test from 'node:test';
import assert from 'node:assert/strict';
import {bubbleMask,siteCentre,sitesOf} from './elune-sites.js';
import {bubbleSky} from './elune-sky.js';

const site=sitesOf('elune')[0],[cx,cz]=siteCentre(site,30,15);

test('bubble is full at the site, eased to zero at twice the radius, absent on other bodies', () => {
  assert.equal(bubbleMask('elune',cx,cz),1);
  assert.equal(bubbleMask('elune',cx+site.bubble,cz),1);
  assert.equal(bubbleMask('elune',cx+2*site.bubble,cz),0);
  const mid=bubbleMask('elune',cx+1.5*site.bubble,cz);
  assert.ok(mid>0.4&&mid<0.6);
  assert.equal(bubbleMask('azeroth',cx,cz),0);
});

test('bubble sky is black outside, blue by day and dim at night inside', () => {
  assert.deepEqual(bubbleSky(0,1),[0,0,0]);
  const day=bubbleSky(1,1),night=bubbleSky(1,0);
  assert.ok(day[2]>night[2]&&night[2]>0);
});
