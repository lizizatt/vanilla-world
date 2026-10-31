import test from 'node:test';
import assert from 'node:assert/strict';
import {oceanMesh,dipDepth,OCEAN_CELL} from './ocean-mesh.js';
import {maelstromCentre,WHIRLPOOL_DIP,FUNNEL} from './clouds.js';

const manifest={ocean:[-30000,-30000,30000,30000],sea_level:0,
  world_bounds:[[0,0,63,63],[0,0,63,63]],regions:[{placement:[-20000,-15000]},{placement:[20000,-15000]}]};

test('dip profile is zero at and beyond the rim and deepest at the centre',()=>{
  const {radius,depth}=WHIRLPOOL_DIP;
  assert.equal(dipDepth(0),depth);assert.equal(dipDepth(radius),0);assert.equal(dipDepth(radius*2),0);
  assert.ok(dipDepth(radius-1)<1e-3);
  assert.equal(FUNNEL.seaLevel,-depth);
});
test('ocean mesh dips to the profile bottom and stays flat elsewhere',()=>{
  const [cx,cz]=maelstromCentre(manifest),m=oceanMesh(manifest,16);
  let lowest=0,highest=-1e9;
  for(let i=0;i<m.length;i+=7){lowest=Math.min(lowest,m[i+1]);highest=Math.max(highest,m[i+1]);}
  assert.equal(highest,0);assert.equal(lowest,-WHIRLPOOL_DIP.depth);
  assert.equal(m.length%21,0);
  assert.ok(cx>-30000&&cz>-30000);
});
test('an explicit whirlpool centre wins over the one derived from a padded ocean',()=>{
  const centre=maelstromCentre(manifest),padded={...manifest,ocean:[-130000,-130000,130000,130000],whirlpool:centre},m=oceanMesh(padded,16);
  let at;for(let i=0;i<m.length;i+=7)if(m[i+1]===-WHIRLPOOL_DIP.depth)at=[m[i]+padded.ocean[0],m[i+2]+padded.ocean[1]];
  assert.ok(Math.hypot(at[0]-centre[0],at[1]-centre[1])<1e-6*Math.max(1,Math.abs(centre[0])));
});
test('without world bounds the ocean is a flat grid of bendable cells',()=>{
  const m=oceanMesh({...manifest,world_bounds:undefined});
  assert.equal(m.length,42*Math.ceil(60000/OCEAN_CELL)**2);assert.ok(m.every((v,i)=>i%7!==1||v===0));
});

test('the whirlpool patch and surrounding quads share edge vertices (no T-junction cracks once bent)',()=>{
  const [cx,cz]=maelstromCentre(manifest),m=oceanMesh({...manifest,ocean:[cx-9000,cz-7300,cx+8000,cz+9100],whirlpool:[cx,cz]},16);
  const pts=new Set(),edges=[];
  for(let t=0;t<m.length;t+=21){const v=[0,1,2].map(k=>[m[t+k*7],m[t+k*7+2]]);v.forEach(p=>pts.add(p.join()));for(let k=0;k<3;k++)edges.push([v[k],v[(k+1)%3]]);}
  let bad=0;
  for(const key of pts){const [px,pz]=key.split(',').map(Number);
    for(const [a,b] of edges){const dx=b[0]-a[0],dz=b[1]-a[1],l2=dx*dx+dz*dz,s=((px-a[0])*dx+(pz-a[1])*dz)/l2;
      if(s>1e-6&&s<1-1e-6&&Math.abs((px-a[0])*dz-(pz-a[1])*dx)/Math.sqrt(l2)<1e-6){bad++;break;}}}
  assert.equal(bad,0);
});

test('no water over a below-sea land tile (racetrack basin); bays outside land rects stay flooded',()=>{
  const track=[-100,-100,100,100],verts=oceanMesh(manifest,96,[track]);
  const inside=[],outside=[];
  for(let i=0;i<verts.length;i+=21){const x=(verts[i]+verts[i+7]+verts[i+14])/3,z=(verts[i+2]+verts[i+9]+verts[i+16])/3;(x>=-100&&x<100&&z>=-100&&z<100?inside:outside).push(1);}
  assert.equal(inside.length,0);assert.ok(outside.length>0);
});

test('land carve is exact: fill area equals ocean minus the (lattice-misaligned) land rects',()=>{
  const T=1600/3,land=[[3*T,2*T,4*T,3*T],[4*T,2*T,5*T,3*T],[-2*T,-5*T,-T,-4*T]],ocean=[-3000,-3000,3000,3000];
  const m=oceanMesh({ocean,sea_level:0},96,land);let area=0;
  for(let i=0;i<m.length;i+=21){const [ax,az,bx,bz,cx,cz]=[m[i],m[i+2],m[i+7],m[i+9],m[i+14],m[i+16]];area+=Math.abs((bx-ax)*(cz-az)-(cx-ax)*(bz-az))/2;}
  const want=6000*6000-land.reduce((s,r)=>s+(r[2]-r[0])*(r[3]-r[1]),0);
  assert.ok(Math.abs(area-want)<1,`area ${area} vs ${want}`);
});
