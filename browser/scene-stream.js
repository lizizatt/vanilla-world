// Static authored geometry only. All matrices are column-major, model -> source WoW world.
export const SCENE_LIMITS = Object.freeze({
  assets: 96, textures: 192, bytes: 96 * 1024 * 1024, instances: 1024, jobs: 2, radius: 850,
});

export function modelPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[:\0]/.test(path)) throw new Error('Invalid scene path');
  const normalized = path.replaceAll('/', '\\').toLowerCase().replace(/\.(mdx|mdl)$/, '.m2');
  if (normalized.split('\\').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid scene path');
  return normalized;
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a, b) {
  return Array.from({ length: 16 }, (_, k) => {
    const row = k % 4, col = Math.floor(k / 4);
    return a[row] * b[col * 4] + a[row + 4] * b[col * 4 + 1]
      + a[row + 8] * b[col * 4 + 2] + a[row + 12] * b[col * 4 + 3];
  });
}
export function transformPoint(m, p) {
  return [0, 1, 2].map(r => m[r] * p[0] + m[r + 4] * p[1] + m[r + 8] * p[2] + m[r + 12]);
}
function rotation(axis, angle) {
  const m = identity(), a = (axis + 1) % 3, b = (axis + 2) % 3;
  m[a * 4 + a] = m[b * 4 + b] = Math.cos(angle);
  m[a * 4 + b] = Math.sin(angle);
  m[b * 4 + a] = -Math.sin(angle);
  return m;
}
function finite(values, count) {
  return Array.isArray(values) && values.length === count && values.every(Number.isFinite);
}
export function placementMatrix(p) {
  if (!finite(p.position, 3) || p.position.some(v => Math.abs(v) > 100000)
      || !Number.isFinite(p.scale) || p.scale <= 0 || p.scale > 100) throw new Error('Invalid scene placement');
  let m;
  if (p.orientation) {
    if (!finite(p.orientation, 4)) throw new Error('Invalid scene quaternion');
    const length = Math.hypot(...p.orientation);
    if (length < 1e-6) throw new Error('Zero scene quaternion');
    const [x, y, z, w] = p.orientation.map(v => v / length);
    m = [1 - 2 * (y*y + z*z), 2*(x*y + z*w), 2*(x*z - y*w), 0,
      2*(x*y - z*w), 1 - 2*(x*x + z*z), 2*(y*z + x*w), 0,
      2*(x*z + y*w), 2*(y*z - x*w), 1 - 2*(x*x + y*y), 0, 0, 0, 0, 1];
  } else {
    if (!finite(p.rotation, 3)) throw new Error('Invalid ADT rotation');
    const [x, y, z] = p.rotation.map(v => v * Math.PI / 180);
    // Same source-space law as benilla-assets/coords.rs, without the Bevy conjugation.
    m = multiply(multiply(multiply(rotation(0, Math.PI / 2), rotation(1, y - Math.PI)),
      rotation(2, -x)), rotation(0, z - Math.PI / 2));
  }
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[col * 4 + row] *= p.scale;
  m.splice(12, 3, ...p.position);
  return m;
}
export function transformedBounds(bounds, matrix) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = transformPoint(matrix, [0, 1, 2].map(k => bounds[(i >> k) & 1][k]));
    p.forEach((v, k) => { min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); });
  }
  return [min, max];
}
function distance(bounds, p) {
  return Math.hypot(...p.map((v, k) => Math.max(bounds[0][k] - v, 0, v - bounds[1][k])));
}
function extractModel(handle) {
  try {
    return { ...JSON.parse(handle.metadata()), vertices: handle.vertices(), indices: handle.indices(),
      collisionVertices: handle.collision_vertices(), collisionIndices: handle.collision_indices() };
  } finally { handle.free(); }
}
function modelBytes(model) {
  return model.vertices.byteLength + model.indices.byteLength
    + model.collisionVertices.byteLength + model.collisionIndices.byteLength;
}
function requestOrder(a, b) {
  const priority = { texture: 0, wmo: 1, group: 2, m2: 3 };
  const aCritical = a.kind !== 'texture' && a.score < 32;
  const bCritical = b.kind !== 'texture' && b.score < 32;
  if (aCritical !== bCritical) return aCritical ? -1 : 1;
  if (aCritical) return priority[a.kind] - priority[b.kind] || a.score - b.score || a.key.localeCompare(b.key);
  return a.score - b.score || priority[a.kind] - priority[b.kind] || a.key.localeCompare(b.key);
}

export class SceneStream {
  constructor(source, wasm, limits = {}) {
    this.source = source; this.wasm = wasm; this.limits = { ...SCENE_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value <= 0 || value > SCENE_LIMITS[key]) throw new Error(`Invalid scene limit ${key}`);
    }
    this.cache = new Map(); this.failures = new Map(); this.tiles = new Map();
    this.requests = new Map(); this.instances = []; this.errors = [];
    this.bytes = 0; this.clock = 0; this.busy = false; this.generation = 0;
    this.npcs = null; this.populationStatus = 'No local NPC spawn pack; client Data has no spawn positions';
  }
  setTile(key, bytes) {
    if (!this.tiles.has(key) && this.tiles.size >= 4) throw new Error('Remove an old scene tile before loading a fifth');
    const placements = JSON.parse(this.wasm.scene_placements(bytes));
    for (const p of placements) {
      p.path = modelPath(p.path);
      if (!['m2', 'wmo'].includes(p.kind) || !Number.isSafeInteger(p.id) || p.id < 0) throw new Error('Invalid scene identity');
      if (p.bounds && (!Array.isArray(p.bounds) || p.bounds.length !== 2 || p.bounds.some(v => !finite(v, 3))
          || p.bounds[0].some((v, i) => v > p.bounds[1][i]))) throw new Error('Invalid authored placement bounds');
      p.matrix = placementMatrix(p);
    }
    this.tiles.set(key, placements);
  }
  removeTile(key) { this.tiles.delete(key); }
  setPopulation(pack) {
    this.npcs = validatePopulation(pack);
    this.populationModels = pack.models;
    this.populationStatus = `Static local NPC snapshot: ${pack.provenance.source}; no server behavior`;
  }
  update(map, position) {
    if (![0, 1].includes(map) || !finite(position, 3)) throw new Error('Invalid scene observer');
    this.map = map; this.position = position; this.clock++;
    const candidates = new Map(), requests = new Map();
    const want = (key, request, score) => {
      const previous = requests.get(key);
      if (!previous || score < previous.score) requests.set(key, { ...request, key, score });
    };
    const add = (p, id, matrix, kind = p.kind) => {
      const path = modelPath(p.path);
      const skins = p.skins || [];
      const key = `${kind}:${path}:${JSON.stringify(skins)}`;
      const asset = this.cache.get(key)?.value;
      const bounds = p.bounds || (asset?.bounds ? transformedBounds(asset.bounds, matrix) : [matrix.slice(12, 15), matrix.slice(12, 15)]);
      const score = distance(bounds, position);
      if ((kind !== 'wmo' || asset) && score > this.limits.radius) return;
      want(key, { kind, path, skins }, score);
      candidates.set(id, { id, key, matrix, bounds, boundsKnown: !!p.bounds || !!asset?.bounds, score, kind });
      if (kind === 'wmo' && asset) {
        candidates.delete(id);
        asset.groups.forEach((group, index) => {
          const groupBounds = transformedBounds(group.bounds, matrix), d = distance(groupBounds, position);
          if (d > this.limits.radius) return;
          const groupKey = `group:${path}:${index}`;
          want(groupKey, { kind: 'group', path: `${path.slice(0, -4)}_${String(index).padStart(3, '0')}.wmo`, rootKey: key }, d);
          candidates.set(`${id}:group:${index}`, { id: `${id}:group:${index}`, key: groupKey, matrix, bounds: groupBounds, boundsKnown: true, score: d, kind: 'group' });
        });
        const doodads = new Set();
        for (const setIndex of new Set([0, p.doodadSet || 0])) {
          const set = asset.sets[setIndex];
          if (!set) continue;
          for (let i = set.start; i < set.start + set.count; i++) doodads.add(i);
        }
        for (const i of doodads) {
          const d = asset.doodads[i];
          if (!d) throw new Error('WMO doodad set references absent doodad');
          add({ ...d, kind: 'm2' }, `${id}:doodad:${i}`, multiply(matrix, placementMatrix(d)));
        }
      }
    };
    const seen = new Set();
    for (const [tile, placements] of this.tiles) {
      if (!tile.startsWith(`${map}:`)) continue;
      for (const p of placements) {
        const id = `${map}:${p.kind}:${p.id}`;
        if (seen.has(id)) continue;
        seen.add(id); add(p, id, p.matrix);
      }
    }
    if (this.npcs) {
      const tx = Math.floor((17066.666666666668 - position[1]) / (1600 / 3));
      const ty = Math.floor((17066.666666666668 - position[0]) / (1600 / 3));
      for (let x = tx - 2; x <= tx + 2; x++) for (let y = ty - 2; y <= ty + 2; y++) {
        for (const npc of this.npcs.get(`${map}:${x}:${y}`) || []) {
          const model = this.populationModels[npc.displayId];
          add({ ...model, kind: 'm2' }, `${map}:npc:${npc.id}`, placementMatrix({
            position: npc.position, orientation: [0, 0, Math.sin(npc.orientation / 2), Math.cos(npc.orientation / 2)],
            scale: npc.scale * model.scale,
          }));
        }
      }
    }
    this.instances = [...candidates.values()].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, this.limits.instances);
    const keep = new Set(this.instances.map(i => i.key));
    for (const i of this.instances) {
      const request = requests.get(i.key);
      if (request?.rootKey) keep.add(request.rootKey);
      const asset = this.cache.get(i.key)?.value;
      for (const batch of asset?.batches || []) {
        if (!batch.texture) continue;
        const path = modelPath(batch.texture), key = `texture:${path}`;
        want(key, { kind: 'texture', path }, i.score);
        keep.add(key);
      }
    }
    // Roots with no loaded metadata must be requested before their group instances exist.
    for (const [key, request] of requests) if (request.kind === 'wmo') keep.add(key);
    this.requests = new Map([...requests].filter(([key]) => keep.has(key)));
    for (const [key, entry] of this.cache) if (keep.has(key)) entry.used = this.clock;
    for (const key of this.failures.keys()) if (!keep.has(key)) this.failures.delete(key);
  }
  async pump() {
    if (this.busy || !this.position) return;
    this.busy = true;
    this.capacityBlocked = false;
    const generation = this.generation;
    try {
      for (let job = 0; job < this.limits.jobs; job++) {
        const request = [...this.requests.values()].filter(r => !this.cache.has(r.key) && !this.failures.has(r.key))
          .sort(requestOrder)[0];
        if (!request) break;
        const limit = request.kind === 'texture' ? this.limits.textures : this.limits.assets;
        if (this.resourceCount(request.kind) >= limit) {
          const victim = this.victimFor(request, true);
          if (!victim) { this.capacityBlocked = true; break; }
          this.evict(victim);
        }
        let result;
        try {
          result = await this.load(request);
          if (generation !== this.generation || !this.requests.has(request.key)) {
            result.dispose?.(); continue;
          }
          if (result.bytes > this.limits.bytes) throw new Error('Decoded scene resource exceeds cache byte budget');
          while (this.resourceCount(request.kind) >= limit || this.bytes + result.bytes > this.limits.bytes) {
            const victim = this.victimFor(request, this.resourceCount(request.kind) >= limit);
            if (!victim) break;
            this.evict(victim);
          }
          if (this.resourceCount(request.kind) >= limit || this.bytes + result.bytes > this.limits.bytes) {
            this.capacityBlocked = true;
            throw Object.assign(new Error('Pinned nearby scene resources exhaust cache budget'), { code: 'LIMIT' });
          }
          this.cache.set(request.key, { ...result, used: this.clock }); this.bytes += result.bytes;
          this.update(this.map, this.position);
        } catch (error) {
          result?.dispose?.();
          if (generation !== this.generation) continue;
          const failure = { path: request.path, code: error.code || 'CORRUPT', message: String(error.message || error) };
          this.failures.set(request.key, failure);
          this.errors.push(failure); if (this.errors.length > 32) this.errors.shift();
        }
      }
    } finally { this.busy = false; }
  }
  resourceCount(kind) {
    return [...this.cache.keys()].filter(key => key.startsWith('texture:') === (kind === 'texture')).length;
  }
  victimFor(request, sameKind = false) {
    const protectedRoots = new Set([...this.requests.values()].filter(r => r.rootKey).map(r => r.rootKey));
    const owners = request.kind === 'texture' ? new Set([...this.cache.entries()]
      .filter(([, entry]) => entry.value.batches?.some(b => b.texture && modelPath(b.texture) === request.path))
      .map(([key]) => key)) : new Set();
    return [...this.cache.entries()].filter(([key]) => !protectedRoots.has(key) && !owners.has(key)
      && (!sameKind || key.startsWith('texture:') === (request.kind === 'texture'))
      && (!this.requests.has(key) || requestOrder(this.requests.get(key), request) > 0))
      .sort(([a, x], [b, y]) => {
        const ar = this.requests.get(a), br = this.requests.get(b);
        if (!ar || !br) return ar ? 1 : br ? -1 : x.used - y.used;
        return requestOrder(br, ar);
      })[0]?.[0];
  }
  async load(request) {
    const bytes = await this.source.read(request.path);
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Encoded scene resource exceeds 64 MiB');
    if (request.kind === 'texture') {
      const handle = new this.wasm.SceneTexture(bytes);
      try {
        const value = { ...JSON.parse(handle.metadata()), rgba: handle.rgba() };
        return { value, bytes: value.rgba.byteLength };
      } finally { handle.free(); }
    }
    if (request.kind === 'wmo') {
      const handle = new this.wasm.SceneRoot(bytes);
      try {
        const value = { ...JSON.parse(handle.metadata()), handle };
        if (!value.groupCount || value.groups.length !== value.groupCount
            || value.groups.some(g => !Array.isArray(g.bounds) || g.bounds.length !== 2
              || g.bounds.some(v => !finite(v, 3)) || g.bounds[0].some((v, i) => v > g.bounds[1][i]))) {
          throw new Error('WMO group bounds are incomplete or invalid');
        }
        for (const doodad of value.doodads) { modelPath(doodad.path); placementMatrix(doodad); }
        if (value.sets.some(s => !Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.count)
            || s.start < 0 || s.count < 0 || s.start + s.count > value.doodads.length)) throw new Error('Invalid WMO doodad set');
        value.bounds = value.groups.reduce((b, g) => b.map((v, side) => v.map((n, axis) =>
          side ? Math.max(n, g.bounds[side][axis]) : Math.min(n, g.bounds[side][axis]))),
        [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]]);
        return { value, bytes: bytes.byteLength * 4, dispose: () => handle.free() };
      } catch (error) { handle.free(); throw error; }
    }
    const handle = request.kind === 'group'
      ? this.cache.get(request.rootKey).value.handle.group(bytes)
      : this.wasm.SceneModel.m2(bytes, request.path, JSON.stringify(request.skins));
    const value = extractModel(handle);
    return { value, bytes: modelBytes(value) };
  }
  snapshot() {
    const assets = new Map(), textures = new Map(), collisionInstances = [], unresolvedCollision = [];
    const instances = this.instances.filter(i => {
      const value = this.cache.get(i.key)?.value;
      if (!value?.vertices) {
        unresolvedCollision.push({ id: i.id, key: i.key, kind: i.kind, bounds: i.bounds, boundsKnown: i.boundsKnown,
          status: this.failures.get(i.key)?.code || 'PENDING' });
        return false;
      }
      assets.set(i.key, value);
      collisionInstances.push(i);
      for (const b of value.batches) {
        if (!b.texture) continue;
        const path = modelPath(b.texture), texture = this.cache.get(`texture:${path}`)?.value;
        if (texture) textures.set(path, texture);
      }
      // Collision is already valid while a cutout waits for its actual alpha texture.
      return !value.batches.some(b => b.alphaCutoff > 0 && (!b.texture || !this.cache.has(`texture:${modelPath(b.texture)}`)));
    });
    return { instances, collisionInstances, unresolvedCollision, assets, textures, errors: [...this.errors], populationStatus: this.populationStatus,
      cachedAssets: this.cache.size, cachedBytes: this.bytes, capacityBlocked: !!this.capacityBlocked,
      cachedModels: this.resourceCount('m2'), cachedTextures: this.resourceCount('texture'),
      pending: [...this.requests.keys()].filter(k => !this.cache.has(k) && !this.failures.has(k)).length };
  }
  evict(key) {
    const entry = this.cache.get(key);
    if (!entry) return;
    entry.dispose?.(); this.bytes -= entry.bytes; this.cache.delete(key);
  }
  retry() {
    this.failures.clear();
    this.errors=[];
  }
  clear() {
    this.generation++; for (const key of this.cache.keys()) this.evict(key);
    this.tiles.clear(); this.requests.clear(); this.failures.clear(); this.instances = []; this.errors = [];
  }
}

export function validatePopulation(pack) {
  if (!pack || pack.version !== 1 || !pack.provenance || typeof pack.provenance.source !== 'string'
      || !pack.provenance.source || pack.provenance.source.length > 4096 || pack.provenance.redistribution !== 'private-local-only'
      || !pack.models || Array.isArray(pack.models) || Object.keys(pack.models).length > 16000
      || !Array.isArray(pack.spawns) || pack.spawns.length > 200000) throw new Error('Invalid local NPC pack/provenance');
  for (const model of Object.values(pack.models)) {
    model.path = modelPath(model.path);
    if (!Number.isFinite(model.scale) || model.scale <= 0 || model.scale > 100
        || !Array.isArray(model.skins) || model.skins.length > 4
        || model.skins.some(s => s !== null && (typeof s !== 'string' || s.length > 1024))) throw new Error('Invalid NPC model');
  }
  const chunks = new Map(), ids = new Set();
  for (const npc of pack.spawns) {
    if (!Number.isSafeInteger(npc.id) || npc.id < 0 || ids.has(npc.id) || ![0, 1].includes(npc.map)
        || !Number.isSafeInteger(npc.displayId) || npc.displayId <= 0
        || !finite(npc.position, 3) || npc.position.some(v => Math.abs(v) > 100000)
        || !Number.isFinite(npc.orientation) || !Number.isFinite(npc.scale) || npc.scale <= 0
        || npc.scale > 100 || !Object.hasOwn(pack.models, npc.displayId)
        || npc.scale * pack.models[npc.displayId].scale > 100) throw new Error('Invalid NPC spawn');
    ids.add(npc.id);
    const x = Math.floor((17066.666666666668 - npc.position[1]) / (1600 / 3));
    const y = Math.floor((17066.666666666668 - npc.position[0]) / (1600 / 3));
    const key = `${npc.map}:${x}:${y}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(npc);
  }
  return chunks;
}
