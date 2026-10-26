import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyEvent,bodyState} from './renderer-events.js';
import {otherSurface} from './renderer-sky.js';
import {AZEROTH} from './bodies.js';
import {MINIMAP_SIZE} from './terrain-stream.js';

test("a non-active body's own minimap colour reaches its far globe bake (land, not just ocean)", () => {
  const r={heightGrid:new Float32Array(16).fill(-Infinity),bodyManifests:{azeroth:{world_bounds:[0,0,1,1]}}};
  const placement=[AZEROTH.centre[0]+100,AZEROTH.centre[1]+100];
  const key={region:0,x:3,y:4,source:[3,4]};
  assert.ok(bodyEvent(r,AZEROTH,{event:'horizon',...key,vertices:new Float32Array(0),placement}));
  const rgba=new Uint8Array(MINIMAP_SIZE*MINIMAP_SIZE*4);for(let i=0;i<rgba.length;i+=4)rgba.set([200,150,60,255],i);
  assert.ok(bodyEvent(r,AZEROTH,{event:'horizon-material',...key,rgba}));
  const s=bodyState(r,'azeroth');
  assert.ok(s.farVersion>0&&s.farGrid.n.some(n=>n>0));
  const bytes=otherSurface(r,AZEROTH,s,10000);
  let land=0;for(let i=3;i<bytes.length;i+=4)if(bytes[i]>128)land++;
  assert.ok(land>0,'baked surface has land from the streamed minimap');
});
