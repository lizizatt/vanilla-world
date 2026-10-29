import test from 'node:test';
import assert from 'node:assert/strict';
import {capHeight,capAlbedo,edgeColat,CAP} from './pole-cap.js';
import {poleLattice,poleAdt,poleHeightChart,POLE_TILES,poleTileOrigin} from './pole-source.js';
import {polarSun,polarDaylight,polarWeight} from './polar-light.js';
import {POLE_FLAGS,poleFlagPlacement,poleMesh} from './pole-flag.js';
import {PLANET_RADIUS as R} from './space.js';
import {ADT_TILE} from './adt-synth.js';

const deg=Math.PI/180,dirAt=(colat,lon,north=true)=>[Math.sin(colat)*Math.cos(lon),north?Math.cos(colat):-Math.cos(colat),Math.sin(colat)*Math.sin(lon)];

test('cap is deterministic, symmetric in hemisphere function and rounded to 1/64 yd',()=>{
  const d=dirAt(7*deg,1.1);assert.equal(capHeight(d),capHeight(d));
  assert.equal(capHeight(d)*64,Math.round(capHeight(d)*64));
  assert.ok(Math.abs(edgeColat(dirAt(.2,0.3))-CAP.edge)<=CAP.edgeJitter+1e-9);
});

test('ice shelf stands 1..10 m (1.09..10.94 yd) above sea; open ocean beyond the berg belt is flat seabed',()=>{
  let lo=1e9,hi=-1e9,ice=0,n=0;
  for(let i=0;i<4000;i++){const col=(i%40)/40*(CAP.edge-2*deg),lon=i*.7919,h=capHeight(dirAt(col,lon));lo=Math.min(lo,h);hi=Math.max(hi,h);if(h>0)ice++;n++;}
  assert.ok(lo>=CAP.shelfMin-CAP.sastrugi-.02,`lo ${lo}`);assert.ok(hi<=CAP.shelfMax+CAP.sastrugi+.02,`hi ${hi}`);assert.equal(ice,n);
  for(let i=0;i<500;i++)assert.equal(capHeight(dirAt(CAP.edge+CAP.edgeJitter+(CAP.bergBand+80)/R+i*.001,i)),CAP.seabed);
});

test('icebergs only exist inside the 547 yd belt, at a plausible density and size',()=>{
  let bergs=0,total=0,tallest=0;
  const band=CAP.bergBand/R;
  for(let i=0;i<60000;i++){const lon=i*.3711,u=(i%250)/250,col=CAP.edge+CAP.edgeJitter+u*(band+.01),d=dirAt(col,lon);
    const e=edgeColat(d),inBelt=col>e&&col<e+band,h=capHeight(d);
    if(col>e+band)assert.equal(h,CAP.seabed);
    if(inBelt){total++;if(h>0){bergs++;tallest=Math.max(tallest,h);}}}
  const cover=bergs/total;
  assert.ok(cover>.001&&cover<.25,`berg coverage ${cover}`);assert.ok(tallest<=CAP.bergTop[1]+.1);
});

test('shelf edge is a steep ramp that a pod can drive off',()=>{
  const lon=.4,e=edgeColat(dirAt(.17,lon));
  const a=capHeight(dirAt(e-1/R,lon)),b=capHeight(dirAt(e+CAP.rampRun/R,lon));
  assert.ok(a>1&&b<=CAP.seabed+.02);
});

test('albedo is ice white on the shelf, bluer on low faces and dark over seabed',()=>{
  const top=capAlbedo(dirAt(4*deg,.5));assert.ok(top[0]>.8&&top[2]>=top[0]);
  const sea=capAlbedo(dirAt(CAP.edge+CAP.edgeJitter+(CAP.bergBand+80)/R,.2));assert.ok(sea[0]<.4);
});

test('pole tile lattice is continuous across shared tile borders and the grid rim is open ocean (Azeroth)',()=>{
  const a=poleLattice('azeroth','N',8,8),b=poleLattice('azeroth','N',9,8);
  for(let j=0;j<259;j+=17)assert.equal(a.H[j*259+257],b.H[j*259+1]);
  const rim=POLE_TILES/2*ADT_TILE;assert.ok(rim>(CAP.edge+CAP.edgeJitter)*R+CAP.bergBand+500,'cap + berg belt inside the grid');
  for(let t=-rim;t<=rim;t+=ADT_TILE/4){for(const [x,z] of [[t,-rim],[t,rim-1],[-rim,t],[rim-1,t]])assert.equal(poleHeightChart('azeroth','N',x,z),CAP.seabed);}
});

test('the same cap serves the south pole chart (frame S) and the pole sits at the origin shelf',()=>{
  const n=poleHeightChart('azeroth','N',0,0),s=poleHeightChart('azeroth','S',0,0);
  assert.ok(n>1&&s>1);
  const [ox,oz]=poleTileOrigin(8,8);assert.deepEqual([ox,oz],[0,0]);
});

test('pole tile synthesises into ADT bytes for Azeroth and Elune',()=>{
  for(const body of ['azeroth','elune']){const b=poleAdt(body,'N',8,8);assert.ok(b instanceof Uint8Array&&b.length>50000);}
});

test('Elune pole frame samples the existing moon terrain (no cap)',()=>{
  const h=poleHeightChart('elune','N',100,50);assert.ok(Number.isFinite(h)&&Math.abs(h)<600);
  assert.notEqual(h,CAP.seabed);
});

test('polar light: identity below 60 deg, south always lit, north always dark, no pop',()=>{
  const sun=[Math.cos(.3),0,Math.sin(.3)];
  assert.deepEqual(polarSun(sun,59*deg),sun);assert.equal(polarDaylight(.5,-59*deg),.5);assert.equal(polarWeight(60*deg),0);
  for(let a=0;a<6.28;a+=.2){const s=[Math.cos(a),0,Math.sin(a)];
    assert.ok(-polarSun(s,-89*deg)[1]>.1,'south elevation');assert.ok(-polarSun(s,89*deg)[1]<.2&&polarSun(s,89*deg)[1]<-.1,'north below horizon');}
  assert.ok(polarDaylight(0,-89*deg)>.7&&polarDaylight(1,89*deg)<.05);
  assert.ok(Math.abs(polarDaylight(.5,70*deg)-polarDaylight(.5,70.1*deg))<.01);
});

test('flags: Horde north, Alliance south, WoW models by path only; pole mesh is procedural',()=>{
  assert.equal(POLE_FLAGS.N.faction,'horde');assert.equal(POLE_FLAGS.S.faction,'alliance');
  for(const f of ['N','S']){const p=poleFlagPlacement(f,3);assert.ok(p.model.endsWith('.mdx')&&p.fallback.endsWith('.mdx'));assert.deepEqual(p.position,[0,3,0]);}
  const m=poleMesh();assert.ok(m.positions.length>0&&m.indices.length>0);
});
