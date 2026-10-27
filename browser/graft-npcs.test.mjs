import test from 'node:test';
import assert from 'node:assert/strict';
import {translateSpawns,bodyPopulation,GRAFT_INFO,RIM_BAND} from './graft-npcs.js';
import {SITES,tilesOf,domeCentre} from './elune-sites.js';
import {MOON_TILES_X,MOON_TILES_Y} from './moon-terrain.js';
import {ADT_TILE} from './adt-synth.js';

const site=SITES.elune[0],CX=MOON_TILES_X/2,CY=MOON_TILES_Y/2,EDGE=17066.666666666668,t0=tilesOf(site)[0];
// A creature standing at chart (x,z) on the body, expressed at its source position on the real map.
const sourceAt=(x,z,extra={})=>({id:7,map:1,displayId:5,position:[EDGE-(z+CY*ADT_TILE)+(t0.dy-t0.sy)*ADT_TILE,EDGE-(x+CX*ADT_TILE)+(t0.dx-t0.sx)*ADT_TILE,20],orientation:1,scale:1,...extra});

test('creatures inside the dome move with the graft tile delta and yOffset', () => {
  const [cx,cz]=domeCentre(site,CX,CY),[out]=translateSpawns([sourceAt(cx,cz)],site,{yOffset:300});
  assert.ok(out);
  assert.ok(Math.abs(out.position[0]-(EDGE-(cz+CY*ADT_TILE)))<1e-6&&Math.abs(out.position[1]-(EDGE-(cx+CX*ADT_TILE)))<1e-6);
  assert.equal(out.position[2],320);assert.equal(out.id,1e6+7);assert.equal(out.displayId,5);
});

test('creatures near or beyond the dome circle, other maps and other tiles are dropped', () => {
  const [cx,cz]=domeCentre(site,CX,CY),R=site.dome.radius;
  assert.equal(translateSpawns([sourceAt(cx+R-RIM_BAND+5,cz)],site,{yOffset:0}).length,0);
  assert.equal(translateSpawns([sourceAt(cx+R+50,cz)],site,{yOffset:0}).length,0);
  assert.equal(translateSpawns([sourceAt(cx,cz,{map:0})].map(s=>({...s,map:0})),site,{yOffset:0}).length,0);
  assert.equal(translateSpawns([{...sourceAt(cx,cz),position:[100,100,0]}],site,{yOffset:0}).length,0);
  assert.equal(translateSpawns([sourceAt(cx+R-RIM_BAND-5,cz)],site,{yOffset:0}).length,1);
});

test('a body population holds only the site creatures, never the source map spawns, and is absent without a pack or graft', async () => {
  const [cx,cz]=domeCentre(site,CX,CY),pack={version:1,models:{},spawns:[sourceAt(cx,cz),{...sourceAt(cx,cz),id:9,position:[0,0,0]}]};
  const source={async read(path){assert.equal(path,GRAFT_INFO);return new TextEncoder().encode(JSON.stringify({moonglade:100}));}};
  const pop=await bodyPopulation('elune',pack,source);
  assert.equal(pop.spawns.length,1);assert.equal(pop.spawns[0].position[2],120);
  assert.equal(await bodyPopulation('elune',undefined,source),undefined);
  assert.equal(await bodyPopulation('azeroth',pack,source),undefined);
  await assert.rejects(bodyPopulation('elune',pack,{read:async()=>{throw new Error('nope');}}));
});
