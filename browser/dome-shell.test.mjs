import test from 'node:test';
import assert from 'node:assert/strict';
import {domeShellAsset,domePlacement,domeLevel} from './dome-shell.js';
import {SITES,domeCentre,siteRect,siteMask,domeMask} from './elune-sites.js';
import {ParticlePool,emitDomeMist,KINDS} from './particles.js';
import {natureGain,NATURE} from './world-audio.js';

const site=SITES.elune[0],[cx,cz]=domeCentre(site,30,15);

test('shell mesh is a valid hemisphere: stride 12, in range indices, rim brighter than the crown, additive and depth-write free', () => {
  const r=site.dome.radius,a=domeShellAsset(r),n=a.vertices.length/12;
  assert.ok(Number.isInteger(n)&&a.indices.every(i=>i<n));
  assert.ok(a.indices.length<20000,'fits the craft budget');
  let top=0,rim=0;
  for(let i=0;i<n;i++){const y=a.vertices[i*12+1],al=a.vertices[i*12+11];assert.ok(y>=-1e-3&&Math.hypot(a.vertices[i*12],y,a.vertices[i*12+2])<=r+1e-3);if(y>r*.99)top=Math.max(top,al);if(y<r*.05)rim=Math.max(rim,al);}
  assert.ok(rim>top*5,'soft Fresnel rim');assert.ok(rim<.5,'stays faint');
  assert.equal(a.batches[0].blend,'add');assert.ok(a.batches[0].noDepthWrite);
});

test('placement exists only for bodies with a site, centred on the site and slowly rotating', () => {
  assert.equal(domePlacement('azeroth'),undefined);
  const p0=domePlacement('elune',0),p1=domePlacement('elune',100);
  assert.deepEqual([p0.pos[0],p0.pos[2]],[cx,cz]);assert.equal(p0.radius,site.dome.radius);assert.ok(p1.yaw>p0.yaw&&p1.yaw<10);
});

test('dome level follows the camera: inside on the ground, nothing high above it or on another body', () => {
  const g=domePlacement('elune').pos[1];
  assert.equal(domeLevel('elune',[cx,g+30,cz]),1);
  assert.equal(domeLevel('elune',[cx,g+site.dome.radius*2,cz]),0);
  assert.equal(domeLevel('elune',[cx+5000,g,cz]),0);assert.equal(domeLevel('azeroth',[cx,g,cz]),0);
});

test('mist only spawns inside the dome and stays low around the eye', () => {
  const pool=new ParticlePool(512,()=>.5);pool.quality=1;
  emitDomeMist(pool,{eye:[cx,100,cz],level:0,ground:90,dt:1});assert.equal(pool.data.slice(0,12).every((v,i)=>i!==6&&i!==7?v===0:true),true);
  emitDomeMist(pool,{eye:[cx,100,cz],level:1,ground:90,dt:1});
  const d=pool.data;let live=0;
  for(let i=0;i<512;i++)if(d[i*12+6]<d[i*12+7]){live++;assert.ok(d[i*12+1]>=96&&d[i*12+1]<=160);assert.ok(Math.hypot(d[i*12]-cx,d[i*12+2]-cz)<=321);}
  assert.ok(live>=10);assert.ok(KINDS.mist.stops.every(s=>s[4]<=.1),'thin');
});

test('dome footprint circle passes exactly through the user track points (start + 2 gates), where real terrain ends and the moon begins', () => {
  const [mx,mz]=domeCentre(site,30,15),{radius,through}=site.dome;
  for(const [x,z] of through)assert.ok(Math.abs(Math.hypot(x-mx,z-mz)-radius)<1e-6);
  assert.deepEqual(through,[[205.845,52.071],[268.196,588.637],[879.646,459.553]]);
  for(const [x,z] of through){assert.equal(domeMask('elune',x,z),1);assert.equal(siteMask(site,x,z,30,15),1);assert.ok(siteMask(site,x+(x-mx)*.1,z+(z-mz)*.1,30,15)<1,'terrain eases to the moon just outside');}
  const [x0,z0,x1,z1]=siteRect(site,30,15);assert.ok(mx-radius>=x0&&mx+radius<=x1&&mz-radius>=z0&&mz+radius<=z1,'real terrain covers the whole dome');
});

test('nature ambience scales with dome membership and is faint', () => {
  assert.equal(natureGain(0),0);assert.equal(natureGain(1),NATURE.gain);assert.equal(natureGain(2),NATURE.gain);assert.ok(natureGain(.5)<natureGain(1));assert.ok(NATURE.gain<.1);
  assert.equal(domeMask('elune',cx,cz,30,15),1);
});
