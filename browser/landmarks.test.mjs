import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SceneStream} from './scene-stream.js';
import {LANDMARKS,LANDMARK_RADIUS,fromMddf,landmarkPlacements} from './landmarks.js';

const stream=()=>new SceneStream({read:async()=>new Uint8Array([1])},{scene_placements:d=>JSON.stringify(d)});

test('MDDF corner-origin positions map to source world axes',()=>{
  const c=32*1600/3;
  assert.deepEqual(fromMddf(0,5,0),[c,c,5]);
  const [x,y,z]=LANDMARKS[0].position;
  assert(Math.abs(x-5461.55)<0.1&&Math.abs(y+3511.65)<0.1&&Math.abs(z-1565.46)<0.1);
});

test('landmarks are per map and flagged',()=>{
  assert.equal(landmarkPlacements(0).length,0);
  const rows=landmarkPlacements(1);
  assert.equal(rows.length,1);assert(rows[0].landmark);assert.equal(rows[0].id,345709);
});

test('a landmark is selected far beyond the distant radius and ordinary doodads are not',()=>{
  const s=stream(),far=20000;
  assert(far>s.limits.distantRadius&&far<LANDMARK_RADIUS);
  const tree={kind:'m2',id:1,path:'a\\tree.mdx',position:[5461,-3511,1565],rotation:[0,0,0],scale:1};
  s.setDistantPlacements('1:0:0',s.parsePlacements(undefined,JSON.stringify([tree])));
  s.setLandmarks(1,landmarkPlacements(1));
  s.update(1,[5461+far,-3511,100]);
  const ids=s.instances.map(i=>i.id);
  assert(ids.some(id=>id.includes('345709')),'landmark selected');
  assert(!ids.some(id=>id.includes(':1')&&!id.includes('345709')),'ordinary doodad beyond range rejected');
});

test('landmarks do not consume distant-tile slots and survive tile churn',()=>{
  const s=stream();s.limits.distantTiles=1;
  s.setLandmarks(1,landmarkPlacements(1));
  s.setDistantPlacements('1:1:1',[]);
  s.removeDistantTile('1:1:1');
  assert(s.distantTiles.has('1:landmark'));
});

test('moon engines never get Azeroth skyline landmarks',async()=>{
  const {readFileSync}=await import('node:fs');
  assert.match(readFileSync(new URL('./world-engine.js',import.meta.url),'utf8'),/manifest\.landmarks=!moon/);
  assert.match(readFileSync(new URL('./far-worker.js',import.meta.url),'utf8'),/data\.manifest\.landmarks!==false/);
});
