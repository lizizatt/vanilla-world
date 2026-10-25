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

import {landMask} from './land-rect.js';
test('a land rect with a bay is cut only where the ground is above sea level',()=>{
  const verts=[];for(let r=0;r<=16;r++)for(let c=0;c<=16;c++)verts.push(c*33,c<8?200:-30,r*33,0,1,0,0);
  const mask=landMask(new Float32Array(verts),[0,0]);
  const area=(m)=>{let s=0;for(let i=0;i<m.length;i+=21){const v=(k)=>[m[i+k*7],m[i+k*7+2]];const [a,b,c]=[v(0),v(1),v(2)];s+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/2;}return s;};
  const man={ocean:[-1000,-1000,2000,2000],sea_level:0};
  const full=area(oceanMesh(man,16,[[0,0,528,528]])),masked=area(oceanMesh(man,16,[[0,0,528,528,mask]]));
  assert.ok(masked>full+528*528/2*.8,`${masked} ${full}`);
});
