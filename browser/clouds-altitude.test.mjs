import test from 'node:test';
import assert from 'node:assert/strict';
import {shellExtent} from './cloud-march.js';
import {SHELL_CURVATURE} from './clouds.js';


// Horizon cloud coverage must not snap as the eye climbs through the layer base (~1317 yd).
test('far reach of the cloud sheet along near-level rays is continuous with altitude',()=>{
  for(const high of [false,true]) for(const pitch of [-.06,-.04,-.02,-.01,0,.02,.1]) {
    let prev=null;
    for(let a=1000;a<=1700;a+=2) {
      const x=shellExtent(a,Math.sin(pitch),SHELL_CURVATURE,high);
      const reach=x.live?x.s1:0;
      if(prev!==null)assert.ok(Math.abs(reach-prev)<=.2*Math.max(prev,reach,1000),`snap at alt ${a} pitch ${pitch} high=${high}: ${prev} -> ${reach}`);
      prev=reach;
    }
  }
});
