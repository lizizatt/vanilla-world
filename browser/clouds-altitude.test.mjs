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
      const reach=x.live?(x.b1>x.b0?x.b1:x.s1):0;
      // Both disjoint pieces (near the eye, far horizon bank) are marched; the reach is the farther end.
      const swap=prev!==null&&x.live&&prev>0&&(x.s0===0)!==(prevS0===0);
      if(prev!==null&&!swap)assert.ok(Math.abs(reach-prev)<=.2*Math.max(prev,reach,1000),`snap at alt ${a} pitch ${pitch} high=${high}: ${prev} -> ${reach}`);
      prev=reach;prevS0=x.s0;
    }
  }
});

test('rays that cross the near sheet and the far horizon bank march both pieces (no see-through gap between them)', () => {
  const e=16273,k=shellCurvatureAt(e),hz=-Math.sqrt(1-(1/(1+e*k))**2);
  for(const high of [false,true]) {
    let both=0;
    for(let i=-20;i<=20;i++) {
      const x=shellExtent(e,hz+i*.0004,k,high);
      if(x.live&&x.b1>x.b0){both++;assert.ok(x.b0>x.s1,'far piece follows the near one');}
    }
    assert.ok(both>0,'some grazing rays cross both pieces');
  }
});
