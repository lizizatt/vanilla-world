// CPU-only regression for the "chunks stop loading after circling the world" stall (see stream-stress.mjs for the real-app version).
// Shared-space flight unwraps longitude near the previous x, so every lap used to add a whole turn to the pose. The streaming engine indexes terrain
// by one turn of the chart, so after a lap the camera was "over" tiles that do not exist there and nothing near it ever loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AZEROTH} from './bodies.js';
import {stepShared} from './shared-flight.js';
import {createTerrainIndex,TILE} from './world-worker-logic.js';

const west={look:[-1,0,0],right:[0,0,-1],up:[0,1,0]};
const turn=AZEROTH.circumference,[cx]=AZEROTH.centre;
const fly=(laps,{alt=300,dt=1/30,onStep}={})=>{
  let space,pose=[cx,alt,-9000,Math.PI/2,0];
  const steps=Math.ceil(laps*turn/(8000*dt));
  for(let i=0;i<steps;i++){
    const r=stepShared(space,pose,west,{forward:1,fast:true},dt,1000);
    space=r.space;pose=r.pose;
    onStep?.(pose,i);
  }
  return pose;
};

test('circling the world keeps the chart longitude within one turn of the centre',()=>{
  let worst=0;
  fly(3,{onStep:p=>{worst=Math.max(worst,Math.abs(p[0]-cx));}});
  assert.ok(worst<=turn/2+1,`|x-cx| reached ${Math.round(worst)} yd (one turn is ${Math.round(turn)})`);
});

test('after laps over open ocean the terrain under the camera is still found by the streaming index',()=>{
  const index=createTerrainIndex(),placements=[];
  // A land mass wrapping the whole turn and the whole flown latitude band, so wherever the camera drifts to there is a tile under it iff x is on the chart.
  for(let x=cx-turn/2;x<cx+turn/2;x+=TILE)for(let z=-25000;z<25000;z+=TILE)placements.push([x,z]);
  const pose=fly(3);
  const last=index.nearby(placements,[pose[0],pose[2]],850).length;
  assert.ok(last>0,'no terrain tiles near the camera after circling the world');
});
