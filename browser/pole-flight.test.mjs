import test from 'node:test';
import assert from 'node:assert/strict';
import {moveFlight} from './flight.js';
import {fromEuler,basis,turnAround} from './orient.js';
import {planetFrame,PLANET_RADIUS,WORLD_CENTRE} from './space.js';
import {toPlanet} from './planet-frame.js';

const planetDir=(pose,look)=>{const f=planetFrame(pose[0],pose[2]);
  return [0,1,2].map(i=>f.east[i]*look[0]+f.up[i]*look[1]+f.south[i]*look[2]);};

function fly(start,yaw,pitch,steps,keys=new Set(['KeyW','ShiftLeft'])) {
  let pose=[...start,0,0],q=fromEuler(yaw,pitch),prev,worst={pos:0,dir:0},crossed=0;
  for(let i=0;i<steps;i++) {
    pose=moveFlight(pose,keys,.05,basis(q));
    if(pose.poleFlip){q=turnAround(q);crossed++;}
    const p=toPlanet(pose),d=planetDir(pose,basis(q).look);
    assert.ok([...p,...d].every(Number.isFinite),'finite');
    if(prev){worst.pos=Math.max(worst.pos,Math.hypot(...p.map((v,k)=>v-prev.p[k])));
      worst.dir=Math.max(worst.dir,Math.hypot(...d.map((v,k)=>v-prev.d[k])));}
    prev={p,d};
  }
  return {worst,crossed};
}

test('flying over the north and south pole keeps position and heading continuous',() => {
  for(const [z,yaw] of [[-40000,0],[40000,Math.PI]]) {
    const {worst,crossed}=fly([WORLD_CENTRE[0],300,z],yaw,0,4000);
    assert.ok(crossed>=1,'crossed the pole');
    assert.ok(worst.pos<450,`position step ${worst.pos}`);
    assert.ok(worst.dir<.05,`heading step ${worst.dir}`);
  }
});

test('random flights near the poles never jump or produce NaN',() => {
  let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  for(let n=0;n<20;n++) {
    const {worst}=fly([WORLD_CENTRE[0]+(rnd()-.5)*PLANET_RADIUS*6,200+rnd()*700,(rnd()<.5?-1:1)*PLANET_RADIUS*(1.2+rnd()*.3)],(rnd()-.5)*6.28,0,1500);
    assert.ok(worst.pos<450&&worst.dir<.1,`n=${n} pos ${worst.pos} dir ${worst.dir}`);
  }
});