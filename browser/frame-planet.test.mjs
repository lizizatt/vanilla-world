import test from 'node:test';
import assert from 'node:assert/strict';
import {frameCentre,chartToDir,POLE_ANCHORS} from './frames.js';
import {toPlanet,fromPlanet,localAxes} from './planet-frame.js';
import {planetFrame,subPoint,bodyPoint,WORLD_CENTRE,PLANET_RADIUS} from './space.js';

const close=(a,b,e=1e-9)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<e,`${a} vs ${b}`));
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

test('E is untouched: no q on the chart centre, bodyPoint equals subPoint', () => {
  assert.equal(frameCentre('E',WORLD_CENTRE),WORLD_CENTRE);
  assert.equal(WORLD_CENTRE.q,undefined);
  assert.deepEqual(bodyPoint(3000,-2000),subPoint(3000,-2000));
});

for(const id of ['N','S']) {
  const fc=frameCentre(id,WORLD_CENTRE),[ax,az]=POLE_ANCHORS[id];
  test(`${id} pole chart: planet position is the rotated chart direction`, () => {
    for(const [x,z,h] of [[0,0,0],[1200,-800,35],[-3000,2500,5]]) {
      const v=toPlanet([ax+x,h,az+z],fc,PLANET_RADIUS),d=chartToDir(id,x,z,WORLD_CENTRE,PLANET_RADIUS);
      close(v,d.map(c=>c*(PLANET_RADIUS+h)),1e-6);
    }
  });
  test(`${id} pole chart: fromPlanet inverts toPlanet`, () => {
    const pose=[ax+900,12,az-1500],back=fromPlanet(toPlanet(pose,fc,PLANET_RADIUS),pose[0],fc,PLANET_RADIUS);
    close(back,pose,1e-6);
  });
  test(`${id} pole chart: local axes are orthonormal with up = radial`, () => {
    const pose=[ax-700,0,az+400],f=planetFrame(pose[0],pose[2],fc,PLANET_RADIUS),p=toPlanet(pose,fc,PLANET_RADIUS);
    for(const a of [f.east,f.up,f.south])assert.ok(Math.abs(Math.hypot(...a)-1)<1e-12);
    assert.ok(Math.abs(dot(f.east,f.up))<1e-12&&Math.abs(dot(f.up,f.south))<1e-12&&Math.abs(dot(f.east,f.south))<1e-12);
    close(f.up,p.map(c=>c/PLANET_RADIUS),1e-12);
    assert.deepEqual(localAxes(pose,fc,PLANET_RADIUS),f);
  });
  test(`${id} pole chart: the body point under the pole origin is the body pole`, () => {
    const {lat}=bodyPoint(ax,az,fc,PLANET_RADIUS);
    assert.ok(Math.abs(Math.abs(lat)-Math.PI/2)<1e-12);
    assert.ok(id==='N'?lat>0:lat<0);
  });
}
