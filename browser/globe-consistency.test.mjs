import test from 'node:test';
import assert from 'node:assert/strict';
import {PLANET_RADIUS,WORLD_CENTRE,FALLBACK_RECTS,subPoint,planetFrame,bendRel} from './space.js';

// The globe, patches and clouds map a flat world point through subPoint (equirect); the terrain bend must land it on the same sphere point from any camera.
const globePoint=(eye,x,z,h)=>{
  const {lat,lon}=subPoint(x,z),f=planetFrame(eye[0],eye[2]),pv=[Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)];
  const n=[f.east,f.up,f.south].map(a=>a[0]*pv[0]+a[1]*pv[1]+a[2]*pv[2]),r=PLANET_RADIUS+h;
  return [n[0]*r,n[1]*r-(PLANET_RADIUS+eye[1]),n[2]*r];
};
const landmarks=[...FALLBACK_RECTS.flatMap(([a,b,c,d])=>[[a,b],[c,b],[a,d],[c,d],[(a+c)/2,(b+d)/2]]),[8855,3507]];
const cameras=[[3100,36900,1342],[11500,36900,-3000],[-13000,20000,7000],[1429,10000,WORLD_CENTRE[1]],[-33000,66000,-6000]];

test('bend at full strength places every landmark at the globe sphere point from any camera',()=>{
  for(const eye of cameras)for(const [x,z] of landmarks)for(const h of [0,500]){
    const got=bendRel([x-eye[0],h-eye[1],z-eye[2]],eye,1),want=globePoint(eye,x,z,h);
    for(let i=0;i<3;i++)assert.ok(Math.abs(got[i]-want[i])<0.05,`eye ${eye} point ${x},${z} h ${h} axis ${i}: ${got[i]} vs ${want[i]}`);
  }
});

test('bend is the identity at k=0 and leaves the point below the camera on the vertical',()=>{
  assert.deepEqual(bendRel([100,5,-200],[0,50,0],0),[100,5,-200]);
  const g=bendRel([0,-1000,0.5],[5000,1000,3000],1);
  assert.ok(Math.abs(g[0])<1e-6&&Math.abs(g[2])<2);
});

test('land latitude is invariant under east-west camera motion (bent terrain recovers the registry lat/lon)',()=>{
  for(const z of [-6000,0,WORLD_CENTRE[1],14000])for(let x=-40000;x<=40000;x+=5000)for(const [lx,lz] of landmarks){
    const eye=[x,19300,z],r=bendRel([lx-x,-19300,lz-z],eye,1),f=planetFrame(x,z),m=Math.hypot(r[0],r[1]+PLANET_RADIUS+eye[1],r[2]),n=[r[0],r[1]+PLANET_RADIUS+eye[1],r[2]].map(v=>v/m);
    const pv=[0,1,2].map(i=>f.east[i]*n[0]+f.up[i]*n[1]+f.south[i]*n[2]),{lat}=subPoint(lx,lz);
    assert.ok(Math.abs(Math.asin(pv[1])-lat)<1e-6,`eye ${x},${z} landmark ${lx},${lz}`);
  }
});
