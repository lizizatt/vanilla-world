import test from 'node:test';
import assert from 'node:assert/strict';
import {BODIES,centreAt,soiOf,SOI_ENTER} from './bodies.js';
import {createFlight,stepFlight,FLY} from './space-flight.js';
import {createRegistry,proceduralProvider,bakeSurface,surfaceTexel} from './tile-registry.js';
import {oceanMesh,oceanMeshCached} from './ocean-mesh.js';
import {swapPlanetState} from './renderer-events.js';

const elune=BODIES.elune,still={look:[0,1,0],right:[1,0,0],up:[0,0,1],forward:0};

/** Steps a pod through sim time at `warp` x (2 sim units per real second at 1x), counting parent swaps. */
function run(pos,warp,seconds,t0=1500,fps=60) {
  let s=createFlight(pos,t0),t=t0,swaps=0;
  for(let i=0;i<seconds*fps;i++){const next=stepFlight(s,still,1/fps,t);if(next.parent!==s.parent)swaps++;s=next;t+=2*warp/fps;}
  return swaps;
}

test('a moon sweeping past a hovering pod at 1000x never earns a swap (no thrash)', () => {
  // Pod sits 20 kyd from Elune's rail point, well inside its sphere of influence at the moment of closest approach.
  const c=centreAt(elune,1500),out=Math.hypot(...c),pos=c.map(v=>v*(1+20000/out));
  assert.equal(run(pos,1000,60),0);
});

test('the same pod at 1x swaps in once and stays (dwell does not block a real approach)', () => {
  const c=centreAt(elune,1500);
  const swaps=run([c[0],c[1]+4000,c[2]],1,20);
  assert.equal(swaps,1);
});

test('a pod jittering across the swap boundary swaps at most once per cooldown', () => {
  const t=1500,c=centreAt(elune,t),edge=soiOf(elune)*SOI_ENTER;
  let s=createFlight([c[0],c[1]+edge+500,c[2]],t),swaps=0;
  for(let i=0;i<600;i++){
    const r=edge+(i%2?-300:300),pos=[c[0],c[1]+r,c[2]],next=stepFlight({...s,pos},still,1/60,t);
    if(next.parent!==s.parent)swaps++;s=next;
  }
  assert.ok(swaps<=Math.ceil(10/FLY.swapCooldown)+1,`${swaps} swaps in 10 s`);
});

test('optimised surface bake matches the reference compositing', () => {
  const reg=createRegistry([
    {id:'a',bounds:[-.5,.5,-1,1],blend:3000,jitter:2000,provider:proceduralProvider({height:40,rgb:[.2,.6,.3]})},
    {id:'b',bounds:[-.2,.9,-.4,2],blend:900,priority:5,provider:proceduralProvider({height:90,rgb:[.7,.5,.2],water:true})},
  ]);
  const reference=(lat,lon)=>{
    let out={h:-60,rgb:[.04,.2,.36],water:true,land:0};
    for(const {chunk,weight} of reg.cover(lat,lon)){const s=chunk.provider.sample(lat,lon);if(s.skip)continue;
      out={land:Math.max(out.land,weight),h:out.h+(s.h-out.h)*weight,rgb:out.rgb.map((v,i)=>v+(s.rgb[i]-v)*weight),water:weight>=.5?s.water:out.water};}
    return out;
  };
  for(let k=0;k<400;k++){
    const lat=Math.sin(k*1.7)*1.4,lon=Math.sin(k*2.3)*3,a=reg.sample(lat,lon),b=reference(lat,lon);
    assert.deepEqual(a,b);
  }
  const w=64,h=32,bytes=bakeSurface(reg,w,h);
  for(const [x,y] of [[3,4],[30,16],[60,28]])assert.deepEqual([...bytes.slice((y*w+x)*4,(y*w+x)*4+4)],surfaceTexel(reg,x,y,w,h));
});

test('ocean fill is memoised and identical to a fresh build', () => {
  const manifest={ocean:[0,0,20000,20000],sea_level:0,whirlpool:undefined},land=[[2000,2000,3600,3600]];
  const a=oceanMeshCached(manifest,96,land),b=oceanMeshCached(manifest,96,land);
  assert.equal(a,b);
  assert.deepEqual(a,oceanMesh(manifest,96,land));
  assert.notEqual(oceanMeshCached(manifest,96,[]),a);
});

test('swapping planet state parks and restores per-body globe data, fresh on a first visit', () => {
  const r={heightGrid:new Float32Array(8).fill(1),colourGrid:{id:'az'},colourDirty:new Set([1]),horizonMini:new Map(),surfaceBytes:new Uint8Array(4),surfaceKey:'k',landRects:[[1,2,3,4]],nightBake:{rows:null}};
  const azeroth=r.heightGrid;
  swapPlanetState(r,'azeroth','elune');
  assert.notEqual(r.heightGrid,azeroth);assert.ok(r.heightGrid.every(v=>v===-Infinity));
  assert.equal(r.surfaceBytes,undefined);assert.deepEqual(r.landRects,[]);assert.equal(r.heightDirty,true);
  r.heightGrid[0]=5;
  swapPlanetState(r,'elune','azeroth');
  assert.equal(r.heightGrid,azeroth);assert.equal(r.surfaceKey,'k');assert.deepEqual(r.landRects,[[1,2,3,4]]);assert.equal(r.surfaceDirty,true);assert.ok(r.nightBake.rows);
  swapPlanetState(r,'azeroth','elune');
  assert.equal(r.heightGrid[0],5);
});
