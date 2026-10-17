import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMatrix,sceneSelection} from './world-renderer.js';
import {validateWorldSave,LAYOUT_VERSION} from './world-store.js';
import {moveFlight,overview} from './flight.js';

test('source matrix uses the same east/up/south basis and preserves floating-origin precision',()=>{
  const matrix=[2,0,0,0,0,2,0,0,0,0,2,0,-100,-200,30,1];
  const r={placement:[1e9,-1e9],tile_origin:[32,32]};
  const out=renderMatrix(matrix,r,[1e9+199.875,-1e9+99.75]);
  assert.deepEqual([...out.slice(12)],[.125,30,.25,1]);
  assert.equal(out[2],-2);assert.equal(out[4],-2);assert.equal(out[9],2);
});
test('GPU scene budget retains a nearest-first prefix below two million triangles',()=>{
  const instances=Array.from({length:12},(_,id)=>({id,key:'model'}));
  const assets=new Map([['model',{batches:[{indexCount:600000}]}]]);
  const selection=sceneSelection(instances,assets);
  assert.equal(selection.triangles,2000000);assert.equal(selection.omitted,2);
  assert.deepEqual(selection.selected.map(i=>i.id),[0,1,2,3,4,5,6,7,8,9]);
  assets.set('model',{batches:Array.from({length:1000},()=>({indexCount:3}))});
  assert.equal(sceneSelection(instances,assets).selected.length,4);
});
test('save validation isolates source/layout and rejects malformed flight/vehicle state',()=>{
  const save={version:1,layout:LAYOUT_VERSION,sourceId:'install-a',mode:'drive',
    vehicle:[0,2,0,0],settings:{horizon:true,scenery:true}};
  assert.doesNotThrow(()=>validateWorldSave(save,'install-a'));
  for(const invalid of [{...save,sourceId:'b'},{...save,layout:2},{...save,vehicle:[0,NaN,0,0]},
    {...save,mode:'fly',camera:[0,200000,0,0,0]},{...save,settings:{}}]) {
    assert.throws(()=>validateWorldSave(invalid,'install-a'),/retained/);
  }
  assert.equal(save.vehicle[1],2);
});
test('flight keyboard movement and overview include translated complete continents',()=>{
  const p=[0,30,0,0,0],q=moveFlight(p,new Set(['KeyW','ShiftLeft']),.1);
  assert.deepEqual(p,[0,30,0,0,0]);assert.equal(q[2],-800);
  const m={regions:[{placement:[0,0],tile_origin:[0,0]},{placement:[30000,11200],tile_origin:[0,0]}],
    horizons:[{region:0,source_bounds:[0,0,50,56]},{region:1,source_bounds:[0,0,20,42]}]};
  const view=overview(m);assert(Math.abs(view[0]-20333.3333333333)<.001);
  assert(Math.abs(view[1]-30500)<.001 && Math.abs(view[2]-30626.6666666667)<.001);
});
