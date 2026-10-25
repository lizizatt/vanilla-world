import test from 'node:test';
import assert from 'node:assert/strict';
import {toPlanet,fromPlanet,localAxes,relative} from './planet-frame.js';
import {PLANET_RADIUS,WORLD_CENTRE} from './space.js';

const rnd=(a,b)=>a+Math.random()*(b-a);

test('flat -> planet -> flat round trip incl. world edges, ocean, 500k altitude', () => {
  const edges=[[-21867,0,-17600],[24725,0,17067],[1429,0,-267],[1429,0,40000],[-30000,0,5000]];
  const poses=[...edges,...Array.from({length:2000},()=>[rnd(-60000,60000),rnd(-40,500000),WORLD_CENTRE[1]+rnd(-60000,60000)])];
  for(const p of poses){const q=fromPlanet(toPlanet(p),p[0]);for(let i=0;i<3;i++)assert.ok(Math.abs(q[i]-p[i])<1e-6*Math.max(1,Math.abs(p[i])),`${p} -> ${q}`);}
});

test('radius of the planet vector is planet radius plus altitude', () => {
  assert.ok(Math.abs(Math.hypot(...toPlanet([0,1234,0]))-(PLANET_RADIUS+1234))<1e-6);
});

test('local up is the radial and the frame is orthonormal', () => {
  for(let i=0;i<200;i++){
    const p=[rnd(-50000,50000),rnd(0,1000),rnd(-40000,40000)],a=localAxes(p),v=toPlanet(p),n=Math.hypot(...v);
    for(let k=0;k<3;k++)assert.ok(Math.abs(a.up[k]-v[k]/n)<1e-9);
    const dot=(u,w)=>u[0]*w[0]+u[1]*w[1]+u[2]*w[2];
    assert.ok(Math.abs(dot(a.east,a.up))<1e-9&&Math.abs(dot(a.east,a.south))<1e-9&&Math.abs(dot(a.up,a.south))<1e-9);
  }
});

test('camera-relative offsets stay f32-safe at 500k yd', () => {
  const eye=toPlanet([100,500000,200]),pt=toPlanet([100,500000,203]),d=relative(pt,eye);
  assert.ok(Math.abs(Math.fround(d[0])-d[0])<1e-3&&Math.hypot(...d)<50);
});

test('descent along the radial keeps lat/lon (deterministic landing)', () => {
  const p=[5000,300000,-8000],down=fromPlanet(toPlanet([p[0],0,p[2]]),p[0]);
  assert.ok(Math.abs(down[0]-p[0])<1e-6&&Math.abs(down[2]-p[2])<1e-6);
});

test('longitude unwraps near the hint across the antimeridian', () => {
  const turn=2*Math.PI*PLANET_RADIUS,p=[1429+turn/2+10,100,0],q=fromPlanet(toPlanet(p),p[0]);
  assert.ok(Math.abs(q[0]-p[0])<1e-6);
});
