import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SceneStream, placementMatrix, transformPoint, transformedBounds, globalCollisionVertices, validatePopulation, modelPath } from './scene-stream.js';

const p = (id, path = 'tree.mdx', x = 0) => ({ kind: 'm2', id, path, position: [x, 0, 0], rotation: [0, 180, 0], scale: 1 });
const fixture = ({ cutout = false } = {}) => {
  let reads = 0, freed = 0;
  const model = () => ({
    metadata: () => JSON.stringify({ bounds: [[-1, -1, 0], [1, 1, 2]], batches: [{
      texture: cutout ? 'leaves.blp' : null, alphaCutoff: cutout ? 224 / 255 : 0,
    }] }),
    vertices: () => new Float32Array(36), indices: () => new Uint32Array([0, 1, 2]),
    collision_vertices: () => new Float32Array(9), collision_indices: () => new Uint32Array([0, 1, 2]),
    free: () => freed++,
  });
  return {
    source: { read: async () => { reads++; return new Uint8Array([1]); } },
    wasm: { scene_placements: data => JSON.stringify(data), SceneModel: { m2: model },
      SceneTexture: class {
        metadata() { return '{"width":1,"height":1}'; }
        rgba() { return new Uint8Array([20, 80, 30, 0]); }
        free() { freed++; }
      } },
    reads: () => reads, freed: () => freed,
  };
};

test('ADT rotations preserve source axes, tilted scale, bounds and translation', () => {
  const identity = placementMatrix(p(1));
  assert.deepEqual(transformPoint(identity, [1, 2, 3]).map(v => Math.round(v)), [1, 2, 3]);
  const heading = placementMatrix({ ...p(1), rotation: [0, 270, 0] });
  const point = transformPoint(heading, [1, 0, 0]);
  assert.ok(Math.abs(point[0]) < 1e-10 && Math.abs(point[1] - 1) < 1e-10);
  const tilted = placementMatrix({ ...p(1), rotation: [32, 73, -24], scale: 2, position: [20, -9, 7] });
  const delta = transformPoint(tilted, [1, 2, 3]).map((v, i) => v - [20, -9, 7][i]);
  assert.ok(Math.abs(Math.hypot(...delta) - Math.sqrt(14) * 2) < 1e-9);
  assert.deepEqual(transformedBounds([[-1, -2, -3], [1, 2, 3]], identity), [[-1, -2, -3], [1, 2, 3]]);
  assert.throws(() => placementMatrix({ ...p(1), scale: NaN }));
  assert.throws(() => modelPath('..\\secret'));
  assert.equal(modelPath('WORLD/Tree.MDX'), 'world\\tree.m2');
});

test('indexed collision vertices retain transformed tilt, scale and translated world precision', () => {
  const region = {placement: [1e6, -2e6], tile_origin: [12, 23]};
  const matrix = placementMatrix({...p(1), rotation: [24,73,-31], scale: 2.5, position: [4321,-987,12]});
  const local = new Float32Array([1,2,3,-4,7,11]);
  const actual = globalCollisionVertices(local,matrix,region);
  for(let i=0;i<local.length;i+=3) {
    const source = transformPoint(matrix,Array.from(local.slice(i,i+3)));
    const expected = [-source[1]+region.placement[0]+(32-12)*1600/3,source[2],
      -source[0]+region.placement[1]+(32-23)*1600/3];
    expected.forEach((v,a)=>assert(Math.abs(actual[i+a]-v)<1e-8));
  }
  assert(actual instanceof Float64Array);
});

test('adjacent ADT duplicates share geometry, bounded jobs and caches evict old demand', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, { assets: 2, jobs: 1 });
  stream.setTile('1:0:0', [p(1), p(2)]);
  stream.setTile('1:1:0', [p(1)]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(f.reads(), 1); assert.equal(f.freed(), 1);
  assert.equal(stream.snapshot().instances.length, 2);
  assert.equal(stream.snapshot().assets.size, 1);
  stream.removeTile('1:0:0'); stream.removeTile('1:1:0');
  stream.setTile('1:3:0', [p(3, 'other.m2'), p(4, 'third.m2')]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(f.reads(), 2);
  await stream.pump();
  assert.equal(stream.snapshot().cachedAssets, 2);
  assert.ok(stream.snapshot().cachedBytes < stream.limits.bytes);
  assert.ok(!stream.cache.has('m2:tree.m2:[]'));
  stream.update(0, [0, 0, 0]);
  assert.equal(stream.snapshot().instances.length, 0);
  stream.clear(); assert.equal(stream.bytes, 0);
});

test('actual alpha texture gates leaf cards and missing/corrupt are distinct', async () => {
  const f = fixture({ cutout: true }), stream = new SceneStream(f.source, f.wasm, { jobs: 1 });
  stream.setTile('1:0:0', [p(1)]); stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances.length, 0);
  assert.equal(stream.snapshot().collisionInstances.length, 1);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
  assert.equal(stream.snapshot().assets.size, 1);
  await stream.pump();
  assert.equal(stream.snapshot().instances.length, 1);
  assert.equal(stream.snapshot().textures.get('leaves.blp').rgba[3], 0);
  for (const code of ['NOT_FOUND', 'CORRUPT']) {
    const broken = new SceneStream({ read: async () => { throw Object.assign(new Error('asset failed'), { code }); } }, f.wasm);
    broken.setTile('1:0:0', [p(1)]); broken.update(1, [0, 0, 0]); await broken.pump();
    assert.equal(broken.snapshot().errors[0].code, code);
    assert.equal(broken.snapshot().instances.length, 0);
    assert.equal(broken.snapshot().unresolvedCollision[0].status, code);
    assert.equal(broken.snapshot().unresolvedCollision[0].boundsKnown, false);
  }
});

test('predicted swept-path solids precede current textures without waiting for their I/O', async () => {
  const f = fixture({cutout: true}), reads = [];
  let finishTexture;
  const source = {read: async path => {
    reads.push(path);
    if(path === 'leaves.blp') return new Promise(resolve => { finishTexture = resolve; });
    return new Uint8Array([1]);
  }};
  const stream = new SceneStream(source, f.wasm, {jobs: 1});
  stream.setTile('1:0:0', [p(1), p(2, 'ahead.m2', 80)]);
  stream.update(1, [0,0,0], [90,0,0]);
  await stream.pump();
  await stream.pump();
  assert.deepEqual(reads, ['tree.m2', 'ahead.m2']);
  const pending = stream.pump();
  stream.update(1, [5,0,0], [95,0,0]);
  assert.equal(stream.snapshot().collisionInstances.length, 2);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
  assert.equal(stream.snapshot().instances.length, 0);
  finishTexture(new Uint8Array([1])); await pending;
  assert.equal(stream.snapshot().instances.length, 2);
});

test('visual instance cap cannot hide missing nearby collision', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, {instances: 1, jobs: 1});
  stream.setTile('1:0:0', [p(1), p(2, 'wall.m2', 1)]);
  stream.update(1, [0,0,0]);
  await stream.pump();
  assert.equal(stream.snapshot().instances.length, 1);
  assert.equal(stream.snapshot().unresolvedCollision.length, 1);
  await stream.pump();
  assert.equal(stream.snapshot().collisionInstances.length, 2);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
  assert.equal(stream.snapshot().instances.length, 1);
});

test('completed model jobs rebuild selection once, retaining a fresh revision', async () => {
  const f = fixture(), stream = new SceneStream(f.source,f.wasm);
  stream.setTile('1:0:0',[p(1),p(2,'other.m2',2)]);
  stream.update(1,[0,0,0]);
  let updates = 0;
  const update = stream.update.bind(stream);
  stream.update = (...args) => {updates++; return update(...args);};
  await stream.pump();
  assert.equal(updates,1);
  assert.equal(stream.snapshot().collisionInstances.length,2);
  assert.equal(stream.selectionRevision,stream.revision);
});

test('late asynchronous completion cannot repopulate a cleared world', async () => {
  const f = fixture(); let resolve;
  const stream = new SceneStream({ read: () => new Promise(r => { resolve = r; }) }, f.wasm);
  stream.setTile('1:0:0', [p(1)]); stream.update(1, [0, 0, 0]);
  const pump = stream.pump(); stream.clear(); resolve(new Uint8Array([1])); await pump;
  assert.equal(stream.snapshot().cachedAssets, 0);
});

test('private NPC provenance, corruption and bounded local residency', async () => {
  assert.throws(() => validatePopulation(null));
  const pack = { version: 1, provenance: { source: 'synthetic-test-only', redistribution: 'private-local-only' },
    models: { 7: { path: 'creature.m2', scale: 1, skins: [] } },
    spawns: [{ id: 9, map: 1, displayId: 7, position: [0, 0, 0], orientation: 0, scale: 1 }] };
  const f = fixture(), stream = new SceneStream(f.source, f.wasm);
  stream.setPopulation(pack); stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances[0].id, '1:npc:9');
  stream.update(1, [9000, 9000, 0]);
  assert.equal(stream.snapshot().instances.length, 0);
  assert.throws(() => validatePopulation({ ...pack, spawns: [...pack.spawns, ...pack.spawns] }));
  assert.throws(() => validatePopulation({ ...pack, provenance: {} }));
});

test('WMO groups and selected child doodads load as separate jobs', async () => {
  const f = fixture();
  const rootMetadata = { groupCount: 1, groups: [{ bounds: [[-2, -2, 0], [2, 2, 5]] }],
    doodads: [{ path: 'chair.mdx', position: [1, 0, 0], orientation: [0, 0, 0, 1], scale: 1 }],
    sets: [{ start: 0, count: 1 }] };
  f.wasm.SceneRoot = class {
    metadata() { return JSON.stringify(rootMetadata); }
    group() { return f.wasm.SceneModel.m2(); }
    free() {}
  };
  const stream = new SceneStream(f.source, f.wasm, { jobs: 1 });
  stream.setTile('0:0:0', [{ ...p(7, 'inn.wmo'), kind: 'wmo' }]);
  stream.update(0, [0, 0, 0]); await stream.pump();
  assert.equal(f.reads(), 1);
  assert.equal(stream.snapshot().instances.length, 0);
  const unresolvedGroup = stream.snapshot().unresolvedCollision.find(i => i.kind === 'group');
  assert.equal(unresolvedGroup.boundsKnown, true);
  assert.deepEqual(unresolvedGroup.bounds, [[-2, -2, 0], [2, 2, 5]]);
  await stream.pump(); await stream.pump();
  assert.equal(f.reads(), 3);
  const snapshot = stream.snapshot();
  assert.equal(snapshot.instances.length, 2);
  assert.ok(snapshot.instances.some(i => i.id === '0:wmo:7:group:0'));
  const chair = snapshot.instances.find(i => i.id === '0:wmo:7:doodad:0');
  assert.deepEqual(chair.matrix.slice(12, 15), [1, 0, 0]);
  stream.update(0, [1,0,0]);
  assert.equal(stream.snapshot().instances.find(i=>i.id===chair.id).matrix,chair.matrix,
    'Static WMO child transform should be reused while the observer moves');
});

test('pinned cache limit does not reread resources endlessly and fifth tile is rejected', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, { assets: 1 });
  for (let i = 0; i < 4; i++) stream.setTile(`1:${i}:0`, [p(i, `tree${i}.m2`)]);
  assert.throws(() => stream.setTile('1:4:0', []), /fifth/);
  stream.update(1, [0, 0, 0]); await stream.pump(); await stream.pump();
  assert.equal(f.reads(), 1);
  assert.equal(stream.snapshot().capacityBlocked, true);
  assert.equal(stream.snapshot().cachedAssets, 1);
});

test('nearer moving demand displaces a still-visible distant cached model', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm, { assets: 1 });
  stream.setTile('1:0:0', [p(1, 'near.m2', 0), p(2, 'far.m2', 500)]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances[0].id, '1:m2:1');
  stream.update(1, [500, 0, 0]); await stream.pump();
  assert.equal(stream.snapshot().instances[0].id, '1:m2:2');
  assert.equal(stream.snapshot().cachedAssets, 1);
  assert.equal(f.reads(), 2);
});

test('texture dependencies have separate bounded slots and cannot evict their geometry owner', async () => {
  const f = fixture({ cutout: true }), stream = new SceneStream(f.source, f.wasm, { assets: 1, textures: 1 });
  stream.setTile('1:0:0', [p(1)]); stream.update(1, [0, 0, 0]);
  await stream.pump(); await stream.pump();
  const snapshot = stream.snapshot();
  assert.equal(snapshot.instances.length, 1);
  assert.equal(snapshot.cachedModels, 1);
  assert.equal(snapshot.cachedTextures, 1);
  assert.equal(f.reads(), 2);
  assert.equal(snapshot.pending, 0);
});

test('unresolved solids inside 32 yards precede texture jobs without prioritizing far solids', async () => {
  const f = fixture({ cutout: true }), reads = [];
  const stream = new SceneStream({ read: async path => { reads.push(path); return f.source.read(path); } }, f.wasm, { jobs: 1 });
  stream.setTile('1:0:0', [p(1, 'a.m2'), p(2, 'b.m2', 20), p(3, 'c.m2', 100)]);
  stream.update(1, [0, 0, 0]);
  await stream.pump(); await stream.pump();
  assert.deepEqual(reads, ['a.m2', 'b.m2']);
  assert.equal(stream.snapshot().collisionInstances.length, 2);
  assert.equal(stream.snapshot().instances.length, 0);
  await stream.pump();
  assert.equal(reads[2], 'leaves.blp');
  assert.equal(stream.snapshot().instances.length, 2);
  await stream.pump();
  assert.equal(reads[3], 'c.m2');
});

test('unloaded WMO roots retain authored world bounds even with distant placement origins', () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm);
  const bounds = [[200, -10, -5], [250, 10, 20]];
  stream.setTile('1:0:0', [{ ...p(1, 'hut.wmo', 550), kind: 'wmo', bounds }]);
  stream.update(1, [0, 0, 0]);
  const root = stream.snapshot().unresolvedCollision[0];
  assert.equal(root.boundsKnown, true);
  assert.deepEqual(root.bounds, bounds);
  assert.equal(stream.instances[0].score, 200);
});

test('distant metadata shares assets, preserves near copies and never claims collision residency', async () => {
  const f = fixture(), stream = new SceneStream(f.source, f.wasm);
  stream.setTile('1:0:0', [p(1)]);
  stream.setDistantTile('1:0:0', [p(1), p(2, 'tree.mdx', 1400)]);
  stream.update(1, [0, 0, 0]); await stream.pump();
  const snapshot = stream.snapshot();
  assert.equal(snapshot.instances.length, 2);
  assert.equal(snapshot.assets.size, 1);
  assert.equal(snapshot.instances.find(i => i.id === '1:m2:1').distant, false);
  assert.equal(snapshot.instances.find(i => i.id === '1:m2:2').distant, true);
  assert.deepEqual(snapshot.collisionInstances.map(i => i.id), ['1:m2:1']);
  assert.equal(snapshot.unresolvedCollision.length, 0);
  stream.removeTile('1:0:0'); stream.update(1, [0, 0, 0]);
  assert.equal(stream.snapshot().collisionInstances.length, 0);
  for (let i = 1; i < 12; i++) stream.setDistantTile(`1:${i}:0`, []);
  assert.throws(() => stream.setDistantTile('1:12:0', []), /thirteenth/);
  assert.equal(stream.tiles.size, 0);
  stream.clear(); assert.equal(stream.distantTiles.size, 0);
});

test('far visual requests never delay nearer collision or texture work', async () => {
  const f = fixture({ cutout: true }), reads = [];
  const stream = new SceneStream({ read: async path => { reads.push(path); return f.source.read(path); } }, f.wasm, { jobs: 1 });
  stream.setTile('1:0:0', [p(1, 'near.m2', 40)]);
  stream.setDistantTile('1:1:0', [p(2, 'far.m2', 1400)]);
  stream.update(1, [0, 0, 0]); await stream.pump(); await stream.pump(); await stream.pump();
  assert.deepEqual(reads, ['near.m2', 'leaves.blp', 'far.m2']);
  assert.equal(stream.snapshot().unresolvedCollision.length, 0);
});
