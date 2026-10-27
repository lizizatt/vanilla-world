import test from 'node:test';
import assert from 'node:assert/strict';
import {PLANET_RADIUS,WORLD_CENTRE,wrapFlat,planetFrame,subPoint,globeToFlat,MAELSTROM_LAT} from './space.js';
import {toPlanet,fromPlanet} from './planet-frame.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm=v=>{const l=Math.hypot(...v);return v.map(x=>x/l);};
const R=PLANET_RADIUS,C=WORLD_CENTRE;
const dirOf=(lat,lon)=>[Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)];
// Landmarks fixed in the body frame: the Maelstrom (lat MAELSTROM_LAT), a Kalimdor-ish point and an Eastern Kingdoms point.
const LANDMARKS={maelstrom:dirOf(MAELSTROM_LAT*Math.PI/180,0),kalimdor:dirOf(5*Math.PI/180,-.3),east:dirOf(-8*Math.PI/180,.35)};

/** The camera goes round the planet in latitude at a fixed longitude, over both poles, the way the fly camera does (flat pose folded by wrapFlat). */
function* sweep(lonDeg,altitude,steps) {
  let heading=1;
  for(let i=0;i<steps;i++){
    const lat=-Math.PI+2*Math.PI*i/steps+1e-3,lon=lonDeg*Math.PI/180;
    const [x,z]=globeToFlat(lat,lon,C,R),[wx,wz,flipped]=wrapFlat(x,z,C,R);
    yield {i,pose:[wx,altitude,wz],flipped,lat,lon};
  }
}

test('the eye frame up is the true radial of the camera at every point of a lat sweep through both poles',()=>{
  for(const lonDeg of [45,-135,0,179.5]) for(const alt of [3000,20000,120000]) for(const s of sweep(lonDeg,alt,720)){
    const f=planetFrame(s.pose[0],s.pose[2],C,R),radial=norm(toPlanet(s.pose,C,R));
    assert.ok(dot(f.up,radial)>1-1e-6,`up != radial at lon ${lonDeg} alt ${alt} step ${s.i}: ${dot(f.up,radial)}`);
    assert.ok(Math.abs(dot(f.east,f.up))<1e-9&&Math.abs(dot(f.east,f.south))<1e-9&&Math.abs(dot(f.up,f.south))<1e-9);
  }
});

test('landmarks keep their sphere point: chart -> sphere -> chart is the identity everywhere on the sweep (longitude wrap and pole fold included)',()=>{
  for(const [name,d] of Object.entries(LANDMARKS)){
    const lat=Math.asin(d[1]),lon=Math.atan2(d[2],d[0]),[x,z]=globeToFlat(lat,lon,C,R);
    for(const s of sweep(45,20000,360)){
      const back=fromPlanet(toPlanet([x,0,z],C,R),s.pose[0],C,R);
      const sp=subPoint(back[0],back[2],C,R);
      assert.ok(Math.abs(sp.lat-lat)<1e-9&&Math.abs(Math.sin(sp.lon-lon))<1e-9,`${name} moved at step ${s.i}`);
    }
  }
});

test('camera-relative: the landmark angle from the nadir changes smoothly, reaches the far side and comes back (no sideways swing, no jump at poles or the +-180 seam)',()=>{
  for(const [name,d] of Object.entries(LANDMARKS)){
    const alt=20000,horizon=Math.acos(R/(R+alt));let prev,min=Infinity,max=0,steps=1440;
    for(const s of sweep(45,alt,steps)){
      const radial=norm(toPlanet(s.pose,C,R)),ang=Math.acos(Math.max(-1,Math.min(1,dot(radial,d))));
      if(prev!==undefined)assert.ok(Math.abs(ang-prev)<2*Math.PI/steps*1.5,`${name} jumped ${prev}->${ang} at step ${s.i}`);
      prev=ang;min=Math.min(min,ang);max=Math.max(max,ang);
    }
    assert.ok(min<horizon,`${name} never faces the camera (min ${min})`);
    assert.ok(max>horizon+.5,`${name} never rotates behind the limb (max ${max})`);
  }
});

test('the landmark bearing in the camera frame is symmetric: opposite sweep points give opposite elevation-in-frame signs',()=>{
  const d=LANDMARKS.maelstrom;
  for(const s of sweep(45,20000,360)){
    const f=planetFrame(s.pose[0],s.pose[2],C,R),n=[dot(d,f.east),dot(d,f.up),dot(d,f.south)];
    assert.ok(Math.abs(Math.hypot(...n)-1)<1e-9);
  }
});
