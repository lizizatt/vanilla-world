import test from 'node:test';
import assert from 'node:assert/strict';
import {BODIES,fromInertial,centreAt,axesAt} from './bodies.js';
import {chartAxes} from './shared-flight.js';
import {frameCentre} from './frames.js';
import {poleAngle,flightInstruments,OVERHEAD} from './compass.js';

const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],rt=cross;
const near=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
const framed=(body,id)=>id==='E'?body:{...body,centre:frameCentre(id,body.centre)};
const chartView=(body,eye,t,look,up)=>({look,up,right:look[2]===-1?[1,0,0]:[0,0,1]});

test('pole bearing on a local horizon: north is up when heading north, left when heading east', () => {
  const r=[0,0,1],pole=[0,1,0];
  near(poleAngle(r,pole,[0,1,0],r,rt([0,1,0],r)).angle,0);
  near(poleAngle(r,pole,[1,0,0],r,rt([1,0,0],r)).angle,-Math.PI/2);
  near(Math.abs(poleAngle(r,pole,[0,-1,0],r,rt([0,-1,0],r)).angle),Math.PI);
  near(poleAngle(r,pole,[-1,0,0],r,rt([-1,0,0],r)).angle,Math.PI/2);
});

test('looking straight down or up keeps the heading continuous through the camera up vector', () => {
  const r=[0,0,1],pole=[0,1,0];
  near(poleAngle(r,pole,[0,0,-1],[0,1,0],rt([0,0,-1],[0,1,0])).angle,0);
  near(poleAngle(r,pole,[0,0,1],[0,-1,0],rt([0,0,1],[0,-1,0])).angle,0);
  near(poleAngle(r,pole,[0,0,-1],[1,0,0],rt([0,0,-1],[1,0,0])).angle,-Math.PI/2);
});

test('the pole directly overhead has no bearing', () => {
  assert.equal(poleAngle([0,1,0],[0,1,0],[0,0,-1],[0,1,0],[1,0,0]).overhead,true);
  assert.equal(poleAngle([Math.sin(OVERHEAD*2),Math.cos(OVERHEAD*2),0],[0,1,0],[0,0,-1],[0,1,0],[1,0,0]).overhead,false);
});

test('Azeroth ground view: heading north points at the pole, altitude and body come from the nearest surface', () => {
  const b=BODIES.azeroth,eye=[b.centre[0],300,b.centre[1]],v=chartView(b,eye,0,[0,0,-1],[0,1,0]);
  const r=flightInstruments(b,eye,v,0);
  assert.equal(r.body,'azeroth');near(r.altitude,300,1e-3);near(r.angle,0,1e-6);
  const e=chartView(b,eye,0,[1,0,0],[0,1,0]);
  near(flightInstruments(b,eye,e,0).angle,-Math.PI/2,1e-6);
});

test('orbit near Elune reports Elune and its pole (orbit normal) rather than Azeroth', () => {
  const az=BODIES.azeroth,el=BODIES.elune,t=123;
  const c=centreAt(el,t),pos=[c[0],c[1]+el.radius+2000,c[2]];
  const eye=fromInertial(az,pos,t);
  const r=flightInstruments(az,eye,chartView(az,eye,t,[1,0,0],[0,1,0]),t);
  assert.equal(r.body,'elune');near(r.altitude,2000,1e-2);
});

test('the bearing is identical in every pole chart for the same physical position and attitude', () => {
  const b=BODIES.azeroth,t=77,ax=axesAt(b,t),R=b.radius,lat=.9,lon=.4;
  const dir=[Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)];
  const pos=dir.map((x,i)=>x*(R+800)+centreAt(b,t)[i]);
  const look=[.3,-.2,.9].map((v,i,a)=>v/Math.hypot(...a)),up=[0,1,0];
  const out=[];
  for(const id of['E','N','S']) {
    const fb=framed(b,id),eye=fromInertial(fb,pos,t),ca=chartAxes(fb,eye,t);
    const d=v=>ca.map(a=>a[0]*v[0]+a[1]*v[1]+a[2]*v[2]);
    out.push(flightInstruments(fb,eye,{look:d(look),up:d(up),right:d(cross(look,up))},t));
  }
  for(const r of out.slice(1)){near(r.angle,out[0].angle,1e-6);near(r.altitude,out[0].altitude,1e-6);}
  assert.equal(out[0].body,'azeroth');void ax;
});
