import test from 'node:test';
import assert from 'node:assert/strict';
import {createRegistry,defaultManifest,proceduralProvider,rectBounds,OCEAN,createColourGrid,splatMinimap,adtProvider,adtChunk,bakeSurface,surfaceChunks,surfaceTexel} from './tile-registry.js';
import {FALLBACK_RECTS,globeToFlat,PLANET_RADIUS} from './space.js';

test('uncovered bins are open ocean',() => {
  const r=createRegistry(defaultManifest().map(c=>({...c,jitter:0})));
  assert.deepEqual(r.sample(0,Math.PI),{...OCEAN,land:0});
  assert.equal(r.cover(0,Math.PI).length,0);
});

test('continent interior is land, edge feathers to ocean',() => {
  const r=createRegistry(defaultManifest().map(c=>({...c,jitter:0}))),[a0,a1,o0,o1]=rectBounds(FALLBACK_RECTS[0]);
  const mid=r.sample((a0+a1)/2,(o0+o1)/2),edge=r.sample(a0+1e-9,(o0+o1)/2);
  assert.equal(mid.water,false);
  assert(Math.abs(edge.h-OCEAN.h)<1,'edge height meets ocean (no step)');
  assert(edge.rgb.every((v,i)=>Math.abs(v-OCEAN.rgb[i])<.01),'edge colour meets ocean');
});

test('custom irregular chunk added later, higher priority wins in overlap',() => {
  const r=createRegistry(defaultManifest().map(c=>({...c,jitter:0}))),[a0,a1,o0,o1]=rectBounds(FALLBACK_RECTS[0]);
  const lat=(a0+a1)/2,lon=(o0+o1)/2,w=3000/PLANET_RADIUS;
  r.add({id:'maelstrom',kind:'poi',priority:5,blend:0,bounds:[lat-w,lat+w,lon-w,lon+w],provider:proceduralProvider({height:500,rgb:[1,0,0]})});
  assert.deepEqual(r.sample(lat,lon).rgb,[1,0,0]);
  assert.equal(r.chunks.at(-1).id,'maelstrom');
});

test('flat rect bounds round-trip through globeToFlat',() => {
  const [a0,,o0]=rectBounds(FALLBACK_RECTS[1]),[x,z]=globeToFlat(a0,o0);
  assert(Math.abs(x-FALLBACK_RECTS[1][0])<1e-6&&Math.abs(z-FALLBACK_RECTS[1][3])<1e-6);
});


test('adt provider uses minimap colour where a tile was splatted and the no coverage elsewhere', () => {
  const grid=createColourGrid(),rgba=new Uint8Array(32*32*4);
  for(let i=0;i<rgba.length;i+=4)rgba.set([200,40,20,255],i);
  const centre=[0,0],R=PLANET_RADIUS;
  const dirty=splatMinimap(grid,rgba,32,[0,-1600/3],centre,R);
  assert.ok(dirty.size>0);
  const p=adtProvider(grid),near=p.sample(.005,.005).rgb;
  assert.ok(Math.abs(near[0]-200/255)<1e-3&&Math.abs(near[1]-40/255)<1e-3);
  assert.ok(p.sample(.5,2).skip);
  const reg=createRegistry([{id:'a',kind:'adt',bounds:[-1.5,1.5,-3,3],blend:0,provider:p}]);
  assert.equal(reg.sample(.5,2).land,0);assert.equal(reg.sample(.005,.005).land,1);
});

test('real-data surface bake is bit-identical without the skipped procedural chunks',() => {
  const grid=createColourGrid(),rects=FALLBACK_RECTS;
  for(let k=0;k<grid.n.length;k+=7){if((k*2654435761>>>0)%5<2)continue;grid.n[k]=2;grid.sum[k*3]=.3*2;grid.sum[k*3+1]=(k%11)/11*2;grid.sum[k*3+2]=.7*2;}
  const legacy=createRegistry([...defaultManifest(undefined,rects).map(c=>({...c,provider:{sample:() => ({skip:true})}})),adtChunk(grid)]);
  assert.deepEqual(bakeSurface(createRegistry(surfaceChunks(rects,true,grid))),bakeSurface(legacy));
  const proc=createRegistry([...defaultManifest(undefined,rects),adtChunk(grid)]);
  assert.deepEqual(bakeSurface(createRegistry(surfaceChunks(rects,false,grid))),bakeSurface(proc));
});
test('patching only the dirty colour-grid texels equals a full re-bake',() => {
  const grid=createColourGrid(),rects=FALLBACK_RECTS,reg=createRegistry(surfaceChunks(rects,true,grid));
  const rgba=new Uint8Array(64*64*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=40+i%200;rgba[i+1]=90;rgba[i+2]=(i>>3)%255;rgba[i+3]=255;}
  splatMinimap(grid,rgba,64,[-3000,2000],[0,0],PLANET_RADIUS,new Set());
  const before=bakeSurface(reg),dirty=new Set();
  splatMinimap(grid,rgba,64,[-2400,2200],[0,0],PLANET_RADIUS,dirty);
  assert.ok(dirty.size>0);
  const next=before.slice();for(const k of dirty)next.set(surfaceTexel(reg,k%1024,Math.floor(k/1024),1024,512),k*4);
  assert.deepEqual(next,bakeSurface(reg));
});