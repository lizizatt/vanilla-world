import test from 'node:test';
import assert from 'node:assert/strict';
import {AZEROTH,ELUNE,centreAt,axesAt,toInertial} from './bodies.js';
import {otherView} from './body-sky.js';
import {planetFrame} from './space.js';
import {frameAtLatLon} from './equirect.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],sub=(a,b)=>a.map((v,i)=>v-b[i]),unit=v=>{const l=Math.hypot(...v);return v.map(x=>x/l);};
const comb=(f,v)=>[0,1,2].map(i=>f[0][i]*v[0]+f[1][i]*v[1]+f[2][i]*v[2]);
const hit=(eye,dir,R)=>{const b=dot(eye,dir),c=dot(eye,eye)-R*R,d=b*b-c;if(d<0)return null;const t=-b-Math.sqrt(d);return eye.map((e,i)=>e+dir[i]*t);};

// Azeroth's continents are body-fixed: the far renderer's view of a ray must hit the same body point as the inertial truth at every Elune orbit phase.
test('other-body view over Azeroth hits the same surface point as the inertial ray at all orbit phases',()=>{
  const day=ELUNE.orbitDays*1440/ELUNE.orbitDays;
  for(let k=0;k<9;k++) {
    const t=1643+k*(ELUNE.orbitDays*1440)/9*1.37;
    const eyeChart=[10,30,-20],fa=planetFrame(eyeChart[0],eyeChart[2],ELUNE.centre,ELUNE.radius),local=[fa.east,fa.up,fa.south];
    const axE=axesAt(ELUNE,t),cE=centreAt(ELUNE,t);
    const eyeInertial=cE.map((c,i)=>c+comb(axE,comb(local,[0,1,0]).map(v=>v*(ELUNE.radius+eyeChart[1])))[i]*1);
    // Aim at a point 3 degrees off Azeroth's centre as seen from the eye (all in Elune eye-local components).
    const toAz=unit(sub([0,0,0],eyeInertial)),aimLocalPlanet=axE.map(a=>dot(a,toAz)),aimLocal=local.map(a=>dot(a,aimLocalPlanet));
    const tilt=.05,look=unit([aimLocal[0]+tilt,aimLocal[1],aimLocal[2]]);
    const view={eye:eyeChart,look,right:[0,0,1],up:[0,1,0],aspect:1.7};
    const o=otherView(view,ELUNE,AZEROTH,t);
    assert.ok(o,'camera is outside Azeroth');
    const dirInertial=unit(comb(axE,comb(local,look))),truth=hit(eyeInertial,dirInertial,AZEROTH.radius);
    assert.ok(truth,'ray hits Azeroth');
    const R=AZEROTH.radius,lat=(AZEROTH.centre[1]-o.view.eye[2])/R,lon=(o.view.eye[0]-AZEROTH.centre[0])/R,fb=frameAtLatLon(lat,lon),lb=[fb.east,fb.up,fb.south];
    const eyeB=comb(lb,[0,1,0]).map(v=>v*(R+o.view.eye[1])),dirB=unit(comb(lb,o.view.look)),mine=hit(eyeB,dirB,R);
    assert.ok(mine,'other view ray hits');
    assert.ok(Math.hypot(...sub(mine,truth))<1,`phase ${k}: hit differs by ${Math.hypot(...sub(mine,truth))} yd`);
    assert.ok(Math.abs(o.altitude-(Math.hypot(...eyeInertial)-R))<1e-3);
  }
});

test('Azeroth frame is time-invariant (continents cannot move with orbital position)',()=>{
  for(const t of [0,500,12345,987654])assert.deepEqual(axesAt(AZEROTH,t),[[1,0,0],[0,1,0],[0,0,1]]);
  assert.deepEqual(centreAt(AZEROTH,777),[0,0,0]);
  assert.ok(toInertial);
});
