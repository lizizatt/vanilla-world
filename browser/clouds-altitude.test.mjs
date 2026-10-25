import test from 'node:test';
import assert from 'node:assert/strict';
import {shellExtent} from './cloud-march.js';
import {shellCurvatureAt} from './clouds.js';


// Horizon cloud coverage must not snap as the eye climbs through the layer base (~1317 yd).
test('far reach of the cloud sheet along near-level rays is continuous with altitude',()=>{
  for(const high of [false,true]) for(const pitch of [-.06,-.04,-.02,-.01,0,.02,.1]) {
    let prev=null,prevS0=0;
    for(let a=1000;a<=1700;a+=2) {
      const x=shellExtent(a,Math.sin(pitch),shellCurvatureAt(a),high);
      const reach=x.live?x.s1:0;
      // The march keeps one of two disjoint pieces (near the eye vs the far horizon bank); the swap changes the reach but never empties the ray.
      const swap=prev!==null&&x.live&&prev>0&&(x.s0===0)!==(prevS0===0);
      if(prev!==null&&!swap)assert.ok(Math.abs(reach-prev)<=.2*Math.max(prev,reach,1000),`snap at alt ${a} pitch ${pitch} high=${high}: ${prev} -> ${reach}`);
      prev=reach;prevS0=x.s0;
    }
  }
});
