import test from 'node:test';
import assert from 'node:assert/strict';
import {tracksFor,vehicleOf} from './vehicles.js';

const az={id:'a',gates:[]},moon={id:'m',body:'elune',gates:[]};

test('tracks without a body belong to Azeroth; only the active body\'s tracks are listed', () => {
  const v=vehicleOf(az),all=[az,moon];
  assert.deepEqual(tracksFor(all,v).map(t=>t.id),['a']);
  assert.deepEqual(tracksFor(all,v,'azeroth').map(t=>t.id),['a']);
  assert.deepEqual(tracksFor(all,vehicleOf(moon),'elune').map(t=>t.id),['m']);
  assert.deepEqual(tracksFor([az],v,'elune'),[]);
});
