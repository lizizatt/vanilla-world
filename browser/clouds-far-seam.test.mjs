import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudShader,cloudShaderHigh} from './clouds.js';
import {PLANET_RADIUS as R} from './space.js';

// JS twin of stormOffset (chart difference wrapped to one turn) and stormOffsetSphere (great-circle offset in the storm's tangent plane).
const turn=2*Math.PI*R;
const up=(lat,lon)=>[Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
function chart(lat,lon,s){const dx=R*(lon-s.lon),dz=-R*(lat-s.lat);return [dx-turn*Math.round(dx/turn),dz];}
function sphere(lat,lon,s){
  const p=up(lat,lon),q=up(s.lat,s.lon),cg=Math.min(1,Math.max(-1,dot(p,q))),v=p.map((x,i)=>x-q[i]*cg);
  const e=[-Math.sin(s.lon),0,Math.cos(s.lon)],n=[-Math.sin(s.lat)*Math.cos(s.lon),Math.cos(s.lat),-Math.sin(s.lat)*Math.sin(s.lon)];
  const h=[dot(v,e),dot(v,n)],l=Math.hypot(...h),d=l>1e-6?[h[0]/l,h[1]/l]:[1,0];
  return [d[0]*Math.acos(cg)*R,-d[1]*Math.acos(cg)*R];
}
// The storm term the clouds see (arm phase, as in sheetDensity) must not jump when the sample crosses the meridian opposite the storm.
const arm=d=>Math.cos(5*(Math.atan2(-d[1],d[0])+.4*Math.log(Math.max(Math.hypot(...d),1)/1000)));
const storm={lat:-.1,lon:2.4};

test('chart storm offset jumps across the antipodal meridian, the sphere offset does not',()=>{
  const anti=storm.lon-Math.PI,lat=.9,eps=1e-3;
  const a=chart(lat,anti+eps,storm),b=chart(lat,anti-eps,storm);
  assert.ok(Math.abs(a[0]-b[0])>turn*.9,'the old chart offset jumps by a whole turn there');
  const c=sphere(lat,anti+eps,storm),d=sphere(lat,anti-eps,storm);
  assert.ok(Math.hypot(c[0]-d[0],c[1]-d[1])<R*.01,'sphere offsets of neighbouring points are neighbours '+JSON.stringify([c,d]));
});

test('sphere storm offset matches the chart near the storm and is a great-circle distance',()=>{
  for(const [dlat,dlon] of [[.02,.03],[-.03,.01],[0,-.04]]) {
    const a=chart(storm.lat+dlat,storm.lon+dlon,storm),b=sphere(storm.lat+dlat,storm.lon+dlon,storm);
    assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<.03*Math.hypot(...a)+5);
  }
  assert.ok(Math.abs(Math.hypot(...sphere(-.1,storm.lon+Math.PI,storm))-Math.PI*R+2*.1*R)<=2*.1*R+1);
});

test('the far sphere offset is used only when the far boost is set',()=>{
  for(const code of [cloudShader,cloudShaderHigh]) {
    assert.match(code,/fn stormOffsetSphere\(p:Sph\)->vec2f/);
    assert.match(code,/var d=stormOffset\(pos\.xz\);if\(c\.sunCol\.w>0\.0\)\{d=stormOffsetSphere\(sp\);\}/);
  }
});
