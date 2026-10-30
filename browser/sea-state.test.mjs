import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seaWindK,seaState} from './sea-state.js';

test('sea wind follows the belts: westerlies roughen more than the doldrums, rain adds, always 0..1',()=>{
  const lat=d=>d*Math.PI/180;
  assert(seaWindK(lat(-45))>seaWindK(lat(0)));
  assert(seaWindK(lat(45),1)>seaWindK(lat(45),0));
  for(let d=-90;d<=90;d+=5)for(const r of [0,.5,1,2]){const k=seaWindK(lat(d),r);assert(k>=0&&k<=1);}
  assert.equal(seaWindK(lat(0),-1),seaWindK(lat(0),0));
});
test('seaState returns [windK, rain] and is hemisphere-symmetric in latitude',()=>{
  const [k,r]=seaState(0,0,.4);assert(k>0&&k<=1);assert.equal(r,.4);
  assert.equal(seaState(0,0,5)[1],1);
});
