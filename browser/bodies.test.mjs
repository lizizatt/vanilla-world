import test from 'node:test';
import assert from 'node:assert/strict';
import {AZEROTH,ELUNE,ELUNE_RADIUS,ELUNE_SOI,SOI_ENTER,SOI_EXIT,regimeOf,planetFactorsFor,gravityFor,densityFor,centreAt,axesAt,toInertial,fromInertial,parentOf,orbitSpeed,nearestSurface,horizonDistance,bodyOf} from './bodies.js';
import {planetFactors} from './terrain-transition.js';
import {regimeOf as azRegime} from './regime.js';
import {gravityAt,densityAt} from './planet-physics.js';

test('Elune is exactly 60 tiles around', () => {
  assert.ok(Math.abs(2*Math.PI*ELUNE_RADIUS-32000)<1e-9);
  assert.ok(Math.abs(ELUNE_RADIUS-5092.96)<.01);
});

test('Azeroth through the body API equals the existing functions', () => {
  for(const h of [0,10,100,150,800,1500,2000,5000,9000,20000]) {
    assert.deepEqual(planetFactorsFor(AZEROTH,h),planetFactors(h));
    assert.equal(regimeOf(h,AZEROTH),azRegime(h));
    assert.equal(gravityFor(AZEROTH,h),gravityAt(h));
    assert.ok(Math.abs(densityFor(AZEROTH,h)-densityAt(h))<1e-12);
  }
});

test('Elune ranges scale by sqrt(R), no atmosphere, low gravity', () => {
  assert.ok(Math.abs(ELUNE.rangeScale-.5976)<.001);
  assert.ok(Math.abs(ELUNE.ranges.bend[0]-52)<.5&&Math.abs(ELUNE.ranges.bend[1]-517.5)<1);
  assert.equal(densityFor(ELUNE,0),0);
  assert.equal(planetFactorsFor(ELUNE,5000).space,1);
  assert.ok(Math.abs(gravityFor(ELUNE,0)/gravityFor(AZEROTH,0)-.25)<1e-12);
  assert.equal(regimeOf(0,ELUNE),'ground');
  assert.equal(regimeOf(3200,ELUNE),'orbit');
  assert.ok(Math.abs(horizonDistance(ELUNE,100)-1010)<10);
});

test('Elune rail: 5-day period, ~87 yd/s, constant distance', () => {
  assert.ok(Math.abs(orbitSpeed()-87.3)<.5);
  const t0=1000,period=5*2880,a=centreAt(ELUNE,t0),b=centreAt(ELUNE,t0+period);
  assert.ok(Math.hypot(...a.map((v,i)=>v-b[i]))<1e-6);
  const q=centreAt(ELUNE,t0+period/4);
  assert.ok(Math.abs(Math.hypot(...q)-100000)<1e-6);
  const speed=Math.hypot(...centreAt(ELUNE,t0+.5).map((v,i)=>v-centreAt(ELUNE,t0-.5)[i]))/(1/2); // per second
  assert.ok(Math.abs(speed-87.3)<.5);
});

test('tidal lock: local +X faces Azeroth, frame is right-handed and orthonormal', () => {
  for(const t of [0,333,2880,9999]) {
    const [x,y,z]=axesAt(ELUNE,t),p=centreAt(ELUNE,t),d=Math.hypot(...p);
    assert.ok(Math.abs(x[0]+p[0]/d)+Math.abs(x[1]+p[1]/d)+Math.abs(x[2]+p[2]/d)<1e-9);
    assert.ok(Math.abs(Math.hypot(...y)-1)<1e-9&&Math.abs(x[0]*y[0]+x[1]*y[1]+x[2]*y[2])<1e-9);
    const c=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
    assert.ok(Math.abs(c[0]-z[0])+Math.abs(c[1]-z[1])+Math.abs(c[2]-z[2])<1e-9);
  }
  // the sub-Azeroth point stays the same chart point as time advances
  const site=[0,200,-1600];
  const rel=t=>{const q=toInertial(ELUNE,site,t),c=centreAt(ELUNE,t),a=axesAt(ELUNE,t);return [0,1,2].map(i=>a[i][0]*(q[0]-c[0])+a[i][1]*(q[1]-c[1])+a[i][2]*(q[2]-c[2]));};
  const r0=rel(0),r1=rel(7777);
  assert.ok(Math.hypot(...r0.map((v,i)=>v-r1[i]))<1e-6);
});

test('chart <-> inertial round trip below 1e-6 yd on both bodies', () => {
  for(const [body,pose] of [[AZEROTH,[3000,120,5000]],[AZEROTH,[-9000,-5,-2000]],[ELUNE,[1200,40,-900]],[ELUNE,[-6000,900,2500]]]) {
    for(const t of [0,4321]) {
      const back=fromInertial(body,toInertial(body,pose,t),t,pose[0]);
      assert.ok(Math.hypot(back[0]-pose[0],back[1]-pose[1],back[2]-pose[2])<1e-6,`${body.id} ${t}`);
    }
  }
});

test('SOI radius and hysteresis', () => {
  assert.ok(ELUNE_SOI>23000&&ELUNE_SOI<27000);
  const t=0,c=centreAt(ELUNE,t),at=d=>[c[0]+d,c[1],c[2]];
  const out=ELUNE_SOI*SOI_ENTER,back=ELUNE_SOI*SOI_EXIT;
  assert.equal(parentOf(at(out*1.01),t,'azeroth'),'azeroth');
  assert.equal(parentOf(at(out*.99),t,'azeroth'),'elune');
  // between the thresholds the current parent is kept, both ways
  const mid=ELUNE_SOI;
  assert.equal(parentOf(at(mid),t,'azeroth'),'azeroth');
  assert.equal(parentOf(at(mid),t,'elune'),'elune');
  assert.equal(parentOf(at(back*1.01),t,'elune'),'azeroth');
});

test('parent swap is refused while a chart is active', () => {
  const t=0,onAzeroth=toInertial(AZEROTH,[0,500,0],t);
  assert.equal(parentOf(onAzeroth,t,'azeroth'),'azeroth');
  const c=centreAt(ELUNE,t),nearElune=[c[0]+ELUNE_RADIUS+300,c[1],c[2]];
  assert.equal(parentOf(nearElune,t,'elune'),'elune');
});

test('nearest surface picks the closer body', () => {
  const t=0,c=centreAt(ELUNE,t);
  assert.equal(nearestSurface([c[0]+ELUNE_RADIUS+50,c[1],c[2]],t).id,'elune');
  assert.equal(nearestSurface(toInertial(AZEROTH,[0,1000,0],t),t).id,'azeroth');
  assert.throws(()=>bodyOf('mars'),RangeError);
});
