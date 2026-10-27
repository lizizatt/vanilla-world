import test from 'node:test';
import assert from 'node:assert/strict';
import {localSunAt,solarTime} from './local-sun.js';
import {AZEROTH} from './bodies.js';
import {sunDirection} from './clouds.js';
import {daylightAt,DAY_PERIOD} from './sim-clock.js';

const [CX,CZ]=AZEROTH.centre,R=AZEROTH.radius,TURN=2*Math.PI*R;
const near=(a,b,e=1e-9,m='')=>assert.ok(Math.abs(a-b)<e,`${m} ${a} vs ${b}`);

test('at the chart origin the local sun is the legacy clock sun and solar time is the clock',()=>{
  for(const t of [0,300,720,1000,1440,2000,2160,2700]){
    const s=localSunAt(AZEROTH,CX,CZ,t),l=sunDirection(t);
    s.forEach((v,i)=>near(v,l[i],1e-9,`t=${t} axis ${i}`));
    near(((solarTime(s)-t)%DAY_PERIOD+DAY_PERIOD+1e-6)%DAY_PERIOD,1e-6,1e-5,`t=${t}`);
  }
});

test('flying west at a fixed clock moves into earlier local time (the sun climbs), east into later (it sinks)',()=>{
  const t=1440,eps=TURN/8;
  const west=solarTime(localSunAt(AZEROTH,CX-eps,CZ,t)),east=solarTime(localSunAt(AZEROTH,CX+eps,CZ,t));
  near(west,t-DAY_PERIOD/8,1e-6,'1/8 turn west is 1/8 day earlier');
  near(east,t+DAY_PERIOD/8,1e-6,'east is later');
});

test('sun is on the horizon exactly where the clock curve says sunrise/sunset, and night follows the elevation',()=>{
  for(let dx=-TURN/2;dx<TURN/2;dx+=TURN/97){
    const s=localSunAt(AZEROTH,CX+dx,CZ,1000),tau=solarTime(s);
    if(Math.abs(s[1])<1e-3)assert.ok(Math.abs(tau-720)<4||Math.abs(tau-2160)<4,`horizon at ${tau}`);
    assert.equal(s[1]>0,tau>720&&tau<2160,`above horizon iff day half (${tau})`);
    if(s[1]<-.6)assert.equal(daylightAt(tau),0,'deep night');
  }
});

test('shader parity: a fragment own-sun elevation equals the eye-frame sun dotted with its sphere normal',()=>{
  // The WGSL localNight() uses n.sun with n the radial of the fragment in the eye frame; on the equator a fragment dx east has n=(sin,cos,0).
  const t=1700,eye=localSunAt(AZEROTH,CX+3000,CZ,t);
  for(const dx of [-9000,-2500,0,1800,7000,14000]){
    const a=dx/R,n=[Math.sin(a),Math.cos(a),0];
    const own=localSunAt(AZEROTH,CX+3000+dx,CZ,t)[1],viaEye=n[0]*eye[0]+n[1]*eye[1]+n[2]*eye[2];
    near(own,viaEye,1e-9,`dx=${dx}`);
  }
});
