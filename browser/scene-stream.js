// Static authored geometry only. All matrices are column-major, model -> source WoW world.
export const SCENE_LIMITS = Object.freeze({
  assets: 192, textures: 192, bytes: 96 * 1024 * 1024, instances: 1024, jobs: 2, radius: 850, distantRadius: 6000,
  nearTiles: 8, distantTiles: 24,
});

export function modelPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[:\0]/.test(path)) throw new Error('Invalid scene path');
  const normalized = path.replaceAll('/', '\\').toLowerCase().replace(/\.(mdx|mdl)$/, '.m2');
  if (normalized.split('\\').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid scene path');
  return normalized;
}
const EMPTY_SKINS = Object.freeze([]);
const modelKey = (kind, p) => `${kind}:${p.path}:${JSON.stringify(p.skins || EMPTY_SKINS)}`;

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a, b) {
  const result = new Array(16);
  for (let k = 0; k < 16; k++) {
    const row = k % 4, col = Math.floor(k / 4);
    result[k] = a[row] * b[col * 4] + a[row + 4] * b[col * 4 + 1]
      + a[row + 8] * b[col * 4 + 2] + a[row + 12] * b[col * 4 + 3];
  }
  return result;
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
    const x = bounds[i & 1][0], y = bounds[(i >> 1) & 1][1], z = bounds[(i >> 2) & 1][2];
    for (let k = 0; k < 3; k++) {
      const v = matrix[k] * x + matrix[k + 4] * y + matrix[k + 8] * z + matrix[k + 12];
      min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v);
    }
  }
  return [min, max];
}
export function globalCollisionVertices(vertices, m, region) {
  const out = new Float64Array(vertices.length), tile = 1600/3;
  const east = region.placement[0] + (32-region.tile_origin[0])*tile;
  const south = region.placement[1] + (32-region.tile_origin[1])*tile;
  for (let i=0; i<vertices.length; i+=3) {
    const x=vertices[i], y=vertices[i+1], z=vertices[i+2];
    out[i]=-(m[1]*x+m[5]*y+m[9]*z+m[13])+east;
    out[i+1]=m[2]*x+m[6]*y+m[10]*z+m[14];
    out[i+2]=-(m[0]*x+m[4]*y+m[8]*z+m[12])+south;
  }
  return out;
}
export function boundsDistance(bounds, low, high = low) {
  return Math.hypot(
    Math.max(bounds[0][0] - high[0], 0, low[0] - bounds[1][0]),
    Math.max(bounds[0][1] - high[1], 0, low[1] - bounds[1][1]),
    Math.max(bounds[0][2] - high[2], 0, low[2] - bounds[1][2]));
}
export function boundsWithin(bounds, p, radius, verticalRadius) {
  const x = Math.max(bounds[0][0] - p[0], 0, p[0] - bounds[1][0]);
  if (x >= radius) return false;
  const y = Math.max(bounds[0][1] - p[1], 0, p[1] - bounds[1][1]);
  if (y >= radius) return false;
  const z = Math.max(bounds[0][2] - p[2], 0, p[2] - bounds[1][2]);
  if (verticalRadius !== undefined) return z < verticalRadius && Math.hypot(x, y) < radius;
  return z < radius && Math.hypot(x, y, z) < radius;
}
function extractModel(handle, collision = true) {
  try {
    const metadata = JSON.parse(handle.metadata());
    for (const batch of metadata.batches) if (batch.texture) batch.texture = modelPath(batch.texture);
    return { ...metadata, vertices: handle.vertices(), indices: handle.indices(),
      collisionVertices: collision ? handle.collision_vertices() : new Float32Array(),
      collisionIndices: collision ? handle.collision_indices() : new Uint32Array() };
  } finally { handle.free(); }
}
function modelBytes(model) {
  return model.vertices.byteLength + model.indices.byteLength
    + model.collisionVertices.byteLength + model.collisionIndices.byteLength;
}
const REQUEST_PRIORITY = Object.freeze({ texture: 0, wmo: 1, group: 2, m2: 3 });
// Keep the worst retained item at the heap root; rejected scenery never needs sorting.
export function selectionPrefix(items, limit, compare) {
  const heap=[];
  for(const item of items) {
    if(heap.length<limit) {
      let at=heap.length;heap.push(item);
      while(at) {
        const parent=(at-1)>>1;
        if(compare(heap[parent],item)>=0)break;
        heap[at]=heap[parent];at=parent;
      }
      heap[at]=item;
    } else if(limit && compare(item,heap[0])<0) {
      let at=0;
      while(at*2+1<heap.length) {
        let child=at*2+1;
        if(child+1<heap.length && compare(heap[child+1],heap[child])>0)child++;
        if(compare(heap[child],item)<=0)break;
        heap[at]=heap[child];at=child;
      }
      heap[at]=item;
    }
  }
  return heap.sort(compare);
}
function requestOrder(a, b) {
  const aCritical = a.required || (!a.distant && a.kind !== 'texture' && (a.collisionScore ?? a.score) < 32);
  const bCritical = b.required || (!b.distant && b.kind !== 'texture' && (b.collisionScore ?? b.score) < 32);
  if (aCritical !== bCritical) return aCritical ? -1 : 1;
  if (aCritical) return REQUEST_PRIORITY[a.kind] - REQUEST_PRIORITY[b.kind] || a.score - b.score || a.key.localeCompare(b.key);
  const band = r => !r.distant && (r.kind==='wmo'||r.score < 128) ? 0 : r.distant ? 1 : 2;
  if (band(a) !== band(b)) return band(a) - band(b);
  return (band(a) ? (a.visualRank ?? Number.MAX_SAFE_INTEGER) - (b.visualRank ?? Number.MAX_SAFE_INTEGER) : 0)
    || a.score - b.score || REQUEST_PRIORITY[a.kind] - REQUEST_PRIORITY[b.kind] || a.key.localeCompare(b.key);
}
function placementId(p,map) {
  if(p.identityMap!==map || p.identityId!==p.id) {
    p.identityMap=map;p.identityId=p.id;p.sceneId=`${map}:${p.kind}:${p.id}`;
  }
  return p.sceneId;
}

export class SceneStream {
  constructor(source, wasm, limits = {}) {
    this.source = source; this.wasm = wasm; this.limits = { ...SCENE_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value <= 0 || value > SCENE_LIMITS[key]) throw new Error(`Invalid scene limit ${key}`);
    }
    this.cache = new Map(); this.failures = new Map(); this.tiles = new Map(); this.distantTiles = new Map();
    this.requests = new Map(); this.instances = []; this.collisionCandidates = []; this.errors = [];
    this.bytes = 0; this.clock = 0; this.busy = false; this.generation = 0; this.revision = 0;
    this.selectionRevision = -1;
    this.timings = {readMs: 0, decodeMs: 0, loads: 0};
    this.expanded = new WeakMap();
    this.bounds = new WeakMap();
    this.pointBounds = new WeakMap();
    this.boundSizes = new WeakMap();
    this.placementLists = new Map();
    this.placementInstances = new WeakMap();
    this.npcs = null; this.populationStatus = 'No local NPC spawn pack; client Data has no spawn positions';
  }
  setTile(key, bytes, metadata) {
    if (!this.tiles.has(key) && this.tiles.size >= this.limits.nearTiles) throw new Error('Remove an old scene tile before exceeding the near-tile budget');
    this.tiles.set(key, this.parsePlacements(bytes, metadata));
    this.placementLists.delete(this.tiles);
    this.revision++;
  }
  setDistantTile(key, bytes) {
    this.setDistantPlacements(key,this.parsePlacements(bytes));
  }
  setDistantPlacements(key,placements) {
    if (!this.distantTiles.has(key) && this.distantTiles.size >= this.limits.distantTiles) throw new Error('Remove old metadata before exceeding the distant-tile budget');
    this.distantTiles.set(key,placements);
    this.placementLists.delete(this.distantTiles);
    this.revision++;
  }
  removeDistantTile(key) {
    if(this.distantTiles.delete(key)){this.placementLists.delete(this.distantTiles);this.revision++;}
  }
  placementList(tiles,map) {
    let list=this.placementLists.get(tiles);
    if(!list || list.map!==map) {
      const seen=new Set(),entries=[];
      for(const [tile,placements] of tiles)if(tile.startsWith(`${map}:`))
        for(const p of placements) {
          const id=placementId(p,map);
          if(!seen.has(id)){seen.add(id);entries.push(p);}
        }
      list={map,entries};this.placementLists.set(tiles,list);
    }
    return list.entries;
  }
  parsePlacements(bytes, metadata) {
    const placements = JSON.parse(metadata ?? this.wasm.scene_placements(bytes));
    for (const p of placements) {
      p.path = modelPath(p.path);
      if (!['m2', 'wmo'].includes(p.kind) || !Number.isSafeInteger(p.id) || p.id < 0) throw new Error('Invalid scene identity');
      if (p.bounds && (!Array.isArray(p.bounds) || p.bounds.length !== 2 || p.bounds.some(v => !finite(v, 3))
          || p.bounds[0].some((v, i) => v > p.bounds[1][i]))) throw new Error('Invalid authored placement bounds');
      p.matrix = placementMatrix(p);
      p.key = modelKey(p.kind, p);
      p.identityId=undefined;
    }
    return placements;
  }
  removeTile(key) { if(this.tiles.delete(key)){this.placementLists.delete(this.tiles);this.revision++;} }
  setPopulation(pack) {
    this.npcs = validatePopulation(pack);
    this.populationModels = pack.models;
    this.npcMatrices = new WeakMap();
    this.populationStatus = `Static local NPC snapshot: ${pack.provenance.source}; no server behavior`;
    this.revision++;
  }
  update(map, position, predicted = position, collisionRadius = 32, collisionVerticalRadius = collisionRadius) {
    if (![0, 1].includes(map) || !finite(position, 3) || !finite(predicted, 3) ||
      !Number.isFinite(collisionRadius) || collisionRadius < 0 ||
      !Number.isFinite(collisionVerticalRadius) || collisionVerticalRadius < 0) throw new Error('Invalid scene observer');
    this.map = map; this.position = position; this.predicted = predicted; this.clock++;
    this.collisionRadius = collisionRadius;
    this.collisionVerticalRadius = collisionVerticalRadius;
    const low = position.map((v, a) => Math.min(v, predicted[a]));
    const high = position.map((v, a) => Math.max(v, predicted[a]));
    const supportColumn = predicted[2] < position[2];
    const collisionDistance = bounds => boundsDistance(bounds, low, high);
    const candidates = new Map(), requests = new Map(), farCandidates=[];
    const want = (key, request, score, distant) => {
      const previous = requests.get(key);
      request.key = key; request.score = score; request.distant = distant;
      if (!previous || requestOrder(request, previous) < 0) requests.set(key, request);
    };
    const put = (id,p,matrix,bounds,boundsKnown,score,kind,distant,rootKey) => {
      let entries=this.placementInstances.get(matrix);
      if(!entries){entries=new Map();this.placementInstances.set(matrix,entries);}
      let instance=entries.get(id);
      if(!instance) {
        instance={id,key:p.key,matrix,kind,path:p.path,skins:p.skins||EMPTY_SKINS,rootKey};
        entries.set(id,instance);
      }
      instance.bounds=bounds;instance.boundsKnown=boundsKnown;instance.score=score;instance.distant=distant;
      instance.collisionScore=undefined;
      if(distant)farCandidates.push(instance);
      else candidates.set(id,instance);
    };
    const add = (p, id, matrix, kind = p.kind, distant = false) => {
      if (distant && (candidates.has(id)||this.nearVisible?.has(id))) return;
      const path = p.path;
      const skins = p.skins || EMPTY_SKINS;
      const key = p.key;
      const asset = this.cache.get(key)?.value;
      const boundsAsset=asset||(this.visualOnly?this.discovered?.get(key):undefined);
      let bounds = p.bounds;
      if (!bounds && boundsAsset?.bounds) {
        let transforms = this.bounds.get(boundsAsset);
        if (!transforms) { transforms = new WeakMap(); this.bounds.set(boundsAsset, transforms); }
        bounds = transforms.get(matrix);
        if (!bounds) { bounds = transformedBounds(boundsAsset.bounds, matrix); transforms.set(matrix, bounds); }
      }
      if(!bounds) {
        bounds=this.pointBounds.get(matrix);
        if(!bounds){bounds=[matrix.slice(12,15),matrix.slice(12,15)];this.pointBounds.set(matrix,bounds);}
      }
      const score = boundsDistance(bounds, position);
      const radius = distant ? this.limits.distantRadius : this.limits.radius;
      if ((kind !== 'wmo' || asset || p.bounds) && score > radius
        && (distant || !supportColumn || collisionDistance(bounds) > collisionRadius)) return;
      if(kind==='wmo')
        want(key, { kind, path, skins, collisionScore: distant?undefined:collisionDistance(bounds) }, score, distant);
      if(kind!=='wmo' || !asset)put(id,p,matrix,bounds,!!p.bounds||!!boundsAsset?.bounds,score,kind,distant);
      if (kind === 'wmo' && asset) {
        let placements = this.expanded.get(asset);
        if (!placements) { placements = new WeakMap(); this.expanded.set(asset, placements); }
        let expanded = placements.get(matrix);
        if (!expanded || expanded.id !== id) {
          const doodads = new Set();
          for (const setIndex of new Set([0, p.doodadSet || 0])) {
            const set = asset.sets[setIndex];
            if (set) for (let i = set.start; i < set.start + set.count; i++) doodads.add(i);
          }
          expanded = {
            id,
            groups: asset.groups.map(group => transformedBounds(group.bounds, matrix)),
            groupIds: asset.groups.map((_, index) => `${id}:group:${index}`),
            groupPlacements:asset.groups.map((_,index)=>({key:`group:${path}:${index}`,
              path:`${path.slice(0,-4)}_${String(index).padStart(3,'0')}.wmo`})),
            doodads: [...doodads].map(i => {
              const d = asset.doodads[i];
              if (!d) throw new Error('WMO doodad set references absent doodad');
              return {id: `${id}:doodad:${i}`, d, matrix: multiply(matrix, placementMatrix(d))};
            }),
          };
          placements.set(matrix, expanded);
        }
        asset.groups.forEach((group, index) => {
          const groupId = expanded.groupIds[index];
          if (distant && (candidates.has(groupId)||this.nearVisible?.has(groupId))) return;
          const groupBounds = expanded.groups[index], d = boundsDistance(groupBounds, position);
          if (d > radius && (distant || !supportColumn || collisionDistance(groupBounds) > collisionRadius)) return;
          put(groupId,expanded.groupPlacements[index],matrix,groupBounds,true,d,'group',distant,key);
        });
        // Distant buildings retain their structure, not hundreds of interior props.
        if (!distant) for (const {id: childId, d, matrix: childMatrix} of expanded.doodads) {
          add(d, childId, childMatrix, 'm2', distant);
        }
      }
    };
    for (const p of this.placementList(this.tiles,map))add(p,placementId(p,map),p.matrix);
    for (const p of this.placementList(this.distantTiles,map))add(p,placementId(p,map),p.matrix,p.kind,true);
    if (this.npcs) {
      const tx = Math.floor((17066.666666666668 - position[1]) / (1600 / 3));
      const ty = Math.floor((17066.666666666668 - position[0]) / (1600 / 3));
      for (let x = tx - 2; x <= tx + 2; x++) for (let y = ty - 2; y <= ty + 2; y++) {
        for (const npc of this.npcs.get(`${map}:${x}:${y}`) || []) {
          const model = this.populationModels[npc.displayId];
          let matrix = this.npcMatrices.get(npc);
          if (!matrix) {
            matrix = placementMatrix({
              position: npc.position, orientation: [0, 0, Math.sin(npc.orientation / 2), Math.cos(npc.orientation / 2)],
              scale: npc.scale * model.scale,
            });
            this.npcMatrices.set(npc, matrix);
          }
          add(model, `${map}:npc:${npc.id}`, matrix, 'm2');
        }
      }
    }
    const all = [...candidates.values(),...farCandidates];
    // Preserve every near solid and its order, even when the visual budget is full.
    this.collisionCandidates = all.filter(i => !i.distant);
    for (const i of all) {
      let size=this.boundSizes.get(i.bounds);
      if(size===undefined) {
        size=Math.max(1,Math.hypot(i.bounds[1][0]-i.bounds[0][0],
          i.bounds[1][1]-i.bounds[0][1],i.bounds[1][2]-i.bounds[0][2]));
        this.boundSizes.set(i.bounds,size);
      }
      i.prominence=size/Math.max(1,i.score);
    }
    const visualOrder=(a,b)=>Number(b.score<128)-Number(a.score<128)
      || (a.score<128?a.score-b.score:b.prominence-a.prominence) || a.score-b.score || a.id.localeCompare(b.id);
    const near = selectionPrefix(this.collisionCandidates,this.limits.instances,visualOrder);
    const farCount=all.length-this.collisionCandidates.length;
    const reserved = Math.min(farCount,Math.max(1,Math.floor(this.limits.instances/4)));
    const farLimit=Math.max(reserved,this.limits.instances-near.length);
    const modelCandidates=all.filter(i=>i.distant&&i.kind==='m2'),unknownModels=new Map();
    // Without near-cache bounds, repeated known fences must not starve undiscovered tree models.
    if(this.visualOnly)for(const i of modelCandidates)
      if(!this.discovered?.has(i.key)&&!this.cache.has(i.key)&&!this.failures.has(i.key)) {
      const previous=unknownModels.get(i.key);
      if(!previous||visualOrder(i,previous)<0)unknownModels.set(i.key,i);
    }
    const farStructures=selectionPrefix(all.filter(i=>i.distant&&i.kind!=='m2'),farLimit,visualOrder),far=[];
    const modelSlots=this.visualOnly?Math.max(Math.floor(this.limits.instances/2),this.limits.instances-farStructures.length):farLimit;
    const discovery=selectionPrefix(unknownModels.values(),Math.min(8,modelSlots),visualOrder);
    const discoveryIds=new Set(discovery.map(i=>i.id));
    const discoveryKeys=new Set(discovery.map(i=>i.key));
    const farModels=[...selectionPrefix(modelCandidates.filter(i=>!discoveryIds.has(i.id)),
      modelSlots-discovery.length,visualOrder),...discovery];
    for(let i=0;i<Math.max(farModels.length,farStructures.length);i++){
      if(farStructures[i])far.push(farStructures[i]);
      if(farModels[i])far.push(farModels[i]);
    }
    // Reserve distant silhouettes without removing a single near collision candidate.
    this.instances = [...near.slice(0,this.limits.instances-reserved),
      ...far.slice(0,Math.max(reserved,this.limits.instances-near.length))];
    const keep = new Set(this.instances.map(i => i.key));
    for (const i of this.collisionCandidates) {
      i.collisionScore=collisionDistance(i.bounds);
      if(i.collisionScore < 32 ||
        boundsWithin(i.bounds, position, i.boundsKnown ? collisionRadius : Math.max(32, collisionRadius),
          i.boundsKnown ? collisionVerticalRadius : Math.max(32, collisionVerticalRadius))) {
        keep.add(i.key);
        want(i.key,{kind:i.kind,path:i.path,skins:i.skins,rootKey:i.rootKey,
          collisionScore:i.collisionScore,required:true},i.score,false);
        if (i.rootKey) { keep.add(i.rootKey); requests.get(i.rootKey).required = true; }
      }
    }
    for (const [visualRank,i] of this.instances.entries()) {
      want(i.key,{kind:i.kind,path:i.path,skins:i.skins,rootKey:i.rootKey,
        collisionScore:i.collisionScore,visualRank},i.score,i.distant);
      const request = requests.get(i.key);
      if(this.visualOnly&&discoveryKeys.has(i.key))request.discovery=true;
      if (request) request.visualRank=Math.min(request.visualRank??Infinity,visualRank);
      if (request?.rootKey) {
        keep.add(request.rootKey);
        const root=requests.get(request.rootKey);
        root.visualRank=Math.min(root.visualRank??Infinity,visualRank);
      }
      const asset = this.cache.get(i.key)?.value;
      for (const batch of asset?.batches || []) {
        if (!batch.texture) continue;
        const path = batch.texture, key = `texture:${path}`;
        want(key, { kind: 'texture', path, visualRank }, i.score, i.distant);
        keep.add(key);
      }
    }
    // Roots with no loaded metadata must be requested before their group instances exist.
    for (const [key, request] of requests) if (request.kind === 'wmo') keep.add(key);
    this.requests = new Map([...requests].filter(([key]) => keep.has(key)));
    this.foregroundKey=[...this.requests.values()].find(r=>(r.required||(!r.distant&&r.score<128))
      && !this.cache.has(r.key)&&!this.failures.has(r.key))?.key;
    for (const [key, entry] of this.cache) if (keep.has(key)) entry.used = this.clock;
    for (const key of this.failures.keys()) if (!keep.has(key)) this.failures.delete(key);
    this.selectionRevision = this.revision;
  }
  async pump(deferSelection = false) {
    if (this.busy || !this.position) return;
    this.busy = true;
    this.capacityBlocked = false;
    const generation = this.generation;
    let loaded = false, loadedRoot = false;
    try {
      for (let job = 0; job < this.limits.jobs; job++) {
        const pending = [...this.requests.values()].filter(r => !this.cache.has(r.key) && !this.failures.has(r.key))
          .sort(requestOrder);
        let request = this.visualOnly
          ? pending.find(r=>!!r.discovery===(this.timings.loads%4===0))||pending[0] : pending[0];
        if (!request) break;
        if(this.visualOnly&&this.resourceCount(request.kind)>=(request.kind==='texture'?this.limits.textures:this.limits.assets)
          &&!this.victimFor(request,true))request=pending.find(r=>
            this.resourceCount(r.kind)<(r.kind==='texture'?this.limits.textures:this.limits.assets)||this.victimFor(r,true))||request;
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
          if(this.visualOnly&&request.kind==='m2')this.discovered?.set(request.key,{bounds:result.value.bounds});
          if (result.bytes > this.limits.bytes) throw new Error('Decoded scene resource exceeds cache byte budget');
          while (this.resourceCount(request.kind) >= limit || this.bytes + result.bytes > this.limits.bytes) {
            const victim = this.victimFor(request, this.resourceCount(request.kind) >= limit);
            if (!victim) break;
            this.evict(victim);
          }
          if (this.resourceCount(request.kind) >= limit || this.bytes + result.bytes > this.limits.bytes) {
            this.capacityBlocked = true;
            throw Object.assign(new Error(`Pinned ${this.visualOnly?'distant':'nearby'} scene resources exhaust cache budget`), { code: 'LIMIT' });
          }
          this.cache.set(request.key, { ...result, used: this.clock }); this.bytes += result.bytes;
          this.revision++;
          loaded = true;
          if (request.kind === 'wmo') { loadedRoot = true; break; }
        } catch (error) {
          result?.dispose?.();
          if (generation !== this.generation) continue;
          if (error.code === 'DEFERRED') break;
          const failure = { path: request.path, code: error.code || 'CORRUPT', message: String(error.message || error) };
          this.failures.set(request.key, failure);
          this.revision++;
          this.errors.push(failure); if (this.errors.length > 32) this.errors.shift();
        }
      }
    } finally {
      this.busy = false;
      if (loaded && generation === this.generation && (!deferSelection || loadedRoot))
        this.update(this.map, this.position, this.predicted, this.collisionRadius, this.collisionVerticalRadius);
    }
  }
  resourceCount(kind) {
    return [...this.cache.keys()].filter(key => key.startsWith('texture:') === (kind === 'texture')).length;
  }
  victimFor(request, sameKind = false) {
    const protectedRoots = new Set([...this.requests.values()].filter(r => r.rootKey).map(r => r.rootKey));
    const owners = request.kind === 'texture' ? new Set([...this.cache.entries()]
      .filter(([, entry]) => entry.value.batches?.some(b => b.texture === request.path))
      .map(([key]) => key)) : new Set();
    return [...this.cache.entries()].filter(([key]) => !protectedRoots.has(key) && !owners.has(key)
      && (!sameKind || key.startsWith('texture:') === (request.kind === 'texture'))
      && (!this.requests.has(key) || requestOrder(this.requests.get(key), request) > 0
        || this.visualOnly&&request.discovery&&(key.startsWith('m2:')||key.startsWith('group:'))))
      .sort(([a, x], [b, y]) => {
        const ar = this.requests.get(a), br = this.requests.get(b);
        if (!ar || !br) return ar ? 1 : br ? -1 : x.used - y.used;
        return requestOrder(br, ar);
      })[0]?.[0];
  }
  async load(request) {
    const readStart = performance.now();
    const generation=this.generation,background=!request.required&&(request.distant||request.score>=128);
    const shouldDefer=()=>generation!==this.generation || !this.requests.has(request.key)
      || [...this.requests.values()].some(r=>r.required&&!this.cache.has(r.key)&&!this.failures.has(r.key));
    if(request.kind==='texture'&&this.source.readTexture) {
      try {
        const value=await this.source.readTexture(request.path,'rgba',shouldDefer);
        this.timings.loads++;
        return {value,bytes:value.rgba.byteLength};
      } finally {this.timings.readMs+=performance.now()-readStart;}
    }
    let bytes;
    try { bytes = await this.source.read(request.path,{background,shouldDefer:background?()=>
      generation!==this.generation || !this.requests.has(request.key)
      || !!(this.foregroundKey&&!this.cache.has(this.foregroundKey)):undefined}); }
    finally { this.timings.readMs += performance.now()-readStart; }
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Encoded scene resource exceeds 64 MiB');
    const decodeStart = performance.now();
    try {
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
        for (const doodad of value.doodads) {
          doodad.path = modelPath(doodad.path);placementMatrix(doodad);
          doodad.key = modelKey('m2', doodad);
        }
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
    const value = extractModel(handle,!this.visualOnly);
    return { value, bytes: modelBytes(value) };
    } finally { this.timings.decodeMs += performance.now()-decodeStart; this.timings.loads++; }
  }
  snapshot() {
    const assets = new Map(), textures = new Map(), collisionInstances = [], unresolvedCollision = [];
    for (const i of this.collisionCandidates) {
      const value = this.cache.get(i.key)?.value;
      if (!value?.vertices) {
        unresolvedCollision.push({ id: i.id, key: i.key, kind: i.kind, bounds: i.bounds, boundsKnown: i.boundsKnown,
          status: this.failures.get(i.key)?.code || 'PENDING' });
      } else {
        assets.set(i.key, value);
        collisionInstances.push(i);
      }
    }
    const instances = this.instances.filter(i => {
      const value = this.cache.get(i.key)?.value;
      if (!value?.vertices) return false;
      assets.set(i.key, value);
      for (const b of value.batches) {
        if (!b.texture) continue;
        const path = b.texture, texture = this.cache.get(`texture:${path}`)?.value;
        if (texture) textures.set(path, texture);
      }
      // Collision is already valid while a cutout waits for its actual alpha texture.
      return !value.batches.some(b => b.alphaCutoff > 0 && (!b.texture || !this.cache.has(`texture:${b.texture}`)));
    });
    return { instances, collisionInstances, unresolvedCollision, assets, textures, errors: [...this.errors], populationStatus: this.populationStatus,
      cachedAssets: this.cache.size, cachedBytes: this.bytes, capacityBlocked: !!this.capacityBlocked, timings: {...this.timings},
      cachedModels: this.resourceCount('m2'), cachedTextures: this.resourceCount('texture'),
      pending: [...this.requests.keys()].filter(k => !this.cache.has(k) && !this.failures.has(k)).length };
  }
  evict(key) {
    const entry = this.cache.get(key);
    if (!entry) return;
    entry.dispose?.(); this.bytes -= entry.bytes; this.cache.delete(key);
    this.revision++;
  }
  retry() {
    this.failures.clear();
    this.errors=[];
    this.revision++;
  }
  clear() {
    this.generation++; for (const key of this.cache.keys()) this.evict(key);
    this.tiles.clear(); this.distantTiles.clear(); this.requests.clear(); this.failures.clear();
    this.placementLists.clear();
    this.discovered?.clear();
    this.instances = []; this.collisionCandidates = []; this.errors = [];
    this.revision++;
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
    model.key = modelKey('m2', model);
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
