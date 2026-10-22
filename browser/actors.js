// Bounded nearby creature animation: the world worker re-poses a few shared Stand loops with the
// Rust rig and posts whole vertex buffers; the renderer swaps them in. Visual only: nothing here
// touches collision, readiness or physics, and unsupported models just stay in bind pose.
import { npcClass, idSeed, wanders, wanderState, WANDER } from './wander.js';

export const ACTOR = Object.freeze({
  maxWanderers: 48,
  radius: 120,
  maxGroups: 16,
  maxModels: 24,
  phases: 3,
  tickMs: 100,
  budgetMs: 2,
  maxBytes: 8 * 1024 * 1024,
  retryMs: 5000,
});

const turnToward = (a, b, max) => {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return Math.abs(d) <= max ? b : a + Math.sign(d) * max;
};

export const actorPhase = id => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return (h >>> 0) % ACTOR.phases;
};
export const poseKey = (key, phase) => `${key}#${phase}`;
export const isActorInstance = i => i.kind === 'm2' && !i.distant && i.id.includes(':npc:');

export class ActorService {
  constructor(source, wasm, post, now = () => performance.now()) {
    this.source = source; this.wasm = wasm; this.post = post; this.now = now;
    this.models = new Map(); // key -> {actor,duration,bytes,used} | {until}
    this.sent = new Map(); this.walk = new Map(); // poseKey -> bytes
    this.stats = { posts: 0, poses: 0, ms: 0, maxMs: 0, models: 0, failed: 0, groups: 0, bytes: 0 };
    this.closed = false; this.enabled = true;
  }

  // Nearest actors first, one shared pose per (model, phase), under the group and byte caps.
  select(instances, focus) {
    const limit = ACTOR.radius * ACTOR.radius, near = [];
    for (const i of instances) {
      if (!isActorInstance(i)) continue;
      const d = (i.matrix[12] - focus[0]) ** 2 + (i.matrix[13] - focus[1]) ** 2;
      if (d <= limit) near.push([d, i]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const groups = new Map();
    let bytes = 0;
    for (const [, i] of near) {
      const model = this.model(i);
      if (!model?.actor) continue;
      const sp = this.speedOf(i, model), phase = actorPhase(i.id) + (sp ? ACTOR.phases : 0);
      const id = poseKey(i.key, phase);
      if (groups.has(id)) continue;
      if (groups.size >= ACTOR.maxGroups || bytes + model.bytes > ACTOR.maxBytes) continue;
      groups.set(id, { key: i.key, phase, model, rate: sp ? sp / model.walkSpeed : 0 });
      bytes += model.bytes;
    }
    return groups;
  }

  // Yards/s of a walking NPC whose model has a Walk clip with a moveSpeed, else 0 (it stands).
  speedOf(i, model) {
    const l = this.walk.get(i.id)?.last;
    const v = l ? Math.hypot(l.vx, l.vy) : 0;
    if (!(v > 0.05) || !(model.walkSpeed > 0)) return 0;
    return v / Math.hypot(i.matrix[0], i.matrix[1], i.matrix[2]);
  }

  model(instance) {
    const entry = this.models.get(instance.key);
    if (entry) {
      if (entry.actor) { entry.used = this.now(); return entry; }
      if (entry.until && this.now() >= entry.until) this.models.delete(instance.key);
      else return undefined;
    }
    if (this.loading !== undefined || this.models.size >= ACTOR.maxModels) {
      if (this.models.size >= ACTOR.maxModels) this.evictIdle();
      return undefined;
    }
    this.loading = this.load(instance).finally(() => { this.loading = undefined; });
    return undefined;
  }

  evictIdle() {
    let oldest;
    for (const [key, e] of this.models) if (e.actor && (!oldest || e.used < oldest[1])) oldest = [key, e.used];
    if (oldest && this.now() - oldest[1] > 2000) this.drop(oldest[0]);
  }

  drop(key) {
    this.models.get(key)?.actor?.free();
    this.models.delete(key);
  }

  async load(instance) {
    const retry = ms => this.models.set(instance.key, { until: this.now() + ms });
    try {
      const bytes = await this.source.read(instance.path, { background: true });
      if (this.closed) return;
      const actor = this.wasm.SceneActor.create(bytes, instance.path, JSON.stringify(instance.skins || []));
      const duration = actor.duration(0);
      if (!(duration > 0)) { actor.free(); retry(Infinity); this.stats.failed++; this.stats.last = `no stand clip: ${instance.path}`; return; }
      const walk = actor.duration(4), walkSpeed = walk > 0 ? (actor.move_speed?.(4) ?? 0) : 0;
      this.models.set(instance.key, { actor, duration, walk, walkSpeed, bytes: actor.vertex_count() * 48, used: this.now() });
      this.stats.models = [...this.models.values()].filter(e => e.actor).length;
    } catch (error) {
      if (error?.code === 'DEFERRED') retry(ACTOR.retryMs);
      else { retry(Infinity); this.stats.failed++; this.stats.last = `${instance.path} skins=${JSON.stringify(instance.skins)}: ${error?.message ?? error}`; }
    }
  }

  update(instances, focus) {
    if (this.closed || !focus) return;
    const start = this.now(), groups = this.enabled ? this.select(instances, focus) : new Map(), poses = [], transfers = [];
    const seconds = start / 1000;
    for (const [id, g] of groups) {
      if (this.now() - start >= ACTOR.budgetMs && poses.length) break;
      const walking = g.phase >= ACTOR.phases, offset = (g.phase % ACTOR.phases) * (walking ? g.model.walk : g.model.duration) / ACTOR.phases;
      let vertices;
      try { vertices = g.model.actor.pose(walking ? 4 : 0, walking ? seconds * g.rate + offset : seconds + offset); }
      catch { this.drop(g.key); this.models.set(g.key, { until: Infinity }); this.stats.failed++; continue; }
      poses.push({ key: g.key, phase: g.phase, vertices });
      transfers.push(vertices.buffer);
      this.sent.set(id, g.model.bytes);
    }
    const removed = [...this.sent.keys()].filter(id => !groups.has(id));
    for (const id of removed) this.sent.delete(id);
    if (poses.length || removed.length) {
      this.post({ event: 'pose', poses, removed }, transfers);
      this.stats.posts++; this.stats.poses += poses.length;
    }
    const ms = this.now() - start;
    this.stats.ms += ms; this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.groups = groups.size;
    this.stats.bytes = [...this.sent.values()].reduce((n, v) => n + v, 0);
  }

  // Wandering NPCs: pure (id,time) paths from wander.js, kept only where the terrain under them is walkable.
  wander(instances, focus, ground, t = Date.now() / 1000) {
    if (this.closed || !focus) return;
    const start = this.now(), limit = ACTOR.radius * ACTOR.radius, near = [];
    if (this.enabled) {
      for (const i of instances) {
        if (!isActorInstance(i)) continue;
        const d = (i.matrix[12] - focus[0]) ** 2 + (i.matrix[13] - focus[1]) ** 2;
        if (d <= limit) near.push([d, i]);
      }
      near.sort((a, b) => a[0] - b[0]);
    }
    const moves = [], seen = new Set(), stats = this.stats; let homeErr = 0;
    stats.rejected = 0;
    for (const [, i] of near) {
      if (moves.length >= ACTOR.maxWanderers) break;
      const cls = npcClass(i.path), seed = idSeed(i.id);
      if (!wanders(cls, seed)) continue;
      let st = this.walk.get(i.id);
      if (!st) {
        const home = [i.matrix[12], i.matrix[13], i.matrix[14]], g = ground(home[0], home[1]);
        if (!Number.isFinite(g)) continue;
        st = { home, g, last: undefined };
        this.walk.set(i.id, st);
      }
      const s = wanderState(seed, cls, st.home, t);
      const g = ground(s.x, s.y), ahead = ground(s.x + Math.cos(s.yaw), s.y + Math.sin(s.yaw));
      const ok = Number.isFinite(g) && Math.abs(g - st.g) <= WANDER.maxHeightDelta &&
        (!Number.isFinite(ahead) || Math.abs(ahead - g) <= WANDER.maxSlope);
      const dt = st.t === undefined ? 0 : Math.min(1, Math.max(0, t - st.t)); st.t = t;
      st.yaw = st.yaw === undefined ? s.yaw : turnToward(st.yaw, s.yaw, WANDER.turnRate * dt);
      if (ok) st.last = { x: s.x, y: s.y, z: st.home[2] + g - st.g, yaw: st.yaw, vx: s.vx, vy: s.vy };
      else { stats.rejected++; if (st.last) st.last = { ...st.last, vx: 0, vy: 0 }; }
      if (!st.last) continue;
      homeErr = Math.max(homeErr, Math.abs(st.g - st.home[2]));
      const l = st.last;
      moves.push([i.id, l.x, l.y, l.z, l.yaw, l.vx, l.vy]);
      seen.add(i.id);
    }
    const removed = [...this.walk.keys()].filter(id => !seen.has(id));
    for (const id of removed) this.walk.delete(id);
    if (moves.length || removed.length) this.post({ event: 'npc-moves', t, moves, removed }, []);
    const ms = this.now() - start;
    stats.homeErr = Math.round(homeErr * 100) / 100; stats.wanderers = moves.length; stats.wanderMs = Math.round(ms * 100) / 100;
    stats.wanderMaxMs = Math.max(stats.wanderMaxMs ?? 0, ms);
  }

  snapshot() { return { ...this.stats, ms: Math.round(this.stats.ms * 10) / 10 }; }

  close() {
    this.closed = true;
    for (const key of [...this.models.keys()]) this.drop(key);
  }
}
