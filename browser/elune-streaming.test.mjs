import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyTileCap,residentTileCap,nearRadius,MOON_TILE_CAP,TILE_CAP_MAX} from './memory-budget.js';
import {sitesOf,siteCentre,siteRect} from './elune-sites.js';

test('moon near engines keep a radius that covers a whole grafted site; Azeroth policy is unchanged', () => {
  for(const budget of [0,192*2**20,512*2**20]) {
    assert.equal(bodyTileCap(budget,false),residentTileCap(budget));
    assert.ok(bodyTileCap(budget,true)>=MOON_TILE_CAP&&bodyTileCap(budget,true)<=TILE_CAP_MAX);
  }
  const site=sitesOf('elune')[0],r=siteRect(site,30,15),corner=Math.hypot((r[2]-r[0])/2,(r[3]-r[1])/2);
  assert.ok(nearRadius(bodyTileCap(0,true))>=corner);
});

test('Moonglade sits at the sub-Azeroth point so Azeroth is near the zenith', () => {
  const [x,z]=siteCentre(sitesOf('elune')[0],30,15);
  assert.ok(Math.hypot(x,z)<600);
});
