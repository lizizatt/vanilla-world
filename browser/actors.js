// Bounded nearby creature animation: the world worker re-poses a few shared Stand loops with the
// Rust rig and posts whole vertex buffers; the renderer swaps them in. Visual only: nothing here
// touches collision, readiness or physics, and unsupported models just stay in bind pose.
import { npcClass, idSeed, wanders, wanderState, WANDER } from './wander.js';
import { CreatureCollision, deathPoseTime } from './creature-collision.js';

export const ACTOR = Object.freeze({
  maxWanderers: 48,
  radius: 120,
  maxGroups: 32,
  maxModels: 32,
  phases: 3,
  tickMs: 40,
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
    this.cc = new CreatureCollision(); this.deathSent = new Map(); this.fxRevision = -1; this.size = [0, 0]; this.assets = undefined;
    this.positionOf = id => this.walk.get(id)?.last;
    this.classOf = i => npcClass(i.path);
    this.durationOf = i => this.models.get(i.key)?.death ?? 0;
    this.sizeOf = i => this.sizeFor(i);
  }

  // Cylinder (radius, height) in yards from the model bounds and instance scale; undefined until the model is resident.
  sizeFor(i) {
    const b = this.assets?.get(i.key)?.bounds, m = i.matrix;
    if (!b) return undefined;
    const k = Math.hypot(m[0], m[1], m[2]);
    this.size[0] = Math.max(b[1][0] - b[0][0], b[1][1] - b[0][1]) * k * 0.5;
    this.size[1] = (b[1][2] - b[0][2]) * k;
    return this.size;
  }

  // Craft (source space) vs nearby creatures. Visual-only: posts hide/gib events; the craft is never touched.
  collide(instances, assets, x, y, z) {
    const cc = this.cc;
    if (this.closed) return;
    if (!cc.enabled || !this.enabled) {
      if (cc.states.size || this.fxRevision > 0) { cc.reset(); this.fxRevision = -1; this.post({ event: 'npc-fx', hidden: [], dead: [], gibs: [] }, []); }
      return;
    }
    this.assets = assets;
    const events = cc.update(instances, isActorInstance, x, y, z, this.now() / 1000, this.positionOf, this.sizeOf, this.classOf, this.durationOf);
    if (cc.revision === this.fxRevision && !events.length) return;
    this.fxRevision = cc.revision ?? 0;
    const hidden = [], dead = [];
    for (const [id, s] of cc.states) (s.state === 'gone' ? hidden : s.state === 'dying' || s.state === 'dead' ? dead : []).push(id);
    const gibs = events.filter(e => e.gib).map(e => [e.x, e.y, e.z, e.size]);
    this.post({ event: 'npc-fx', hidden, dead, gibs }, []);
  }

  // Death clip once at the corpse's own pose key, then the final frame is held (posted once) until the creature goes or respawns.
  deathPoses(poses, transfers, removed) {
    const t = this.now() / 1000, n = poses.length;
    for (const [id, s] of this.cc.states) {
      if (s.gib || s.state === 'gone' || (s.state === 'dead' && s.posted)) continue;
      const model = this.models.get(s.key);
      if (!model?.actor || poses.length - n >= this.cc.cfg.maxDying + 4) continue;
      let vertices;
      try { vertices = model.actor.pose(1, deathPoseTime(t - s.t0, model.death || s.duration)); } catch { continue; }
      const phase = `d:${id}`;
      poses.push({ key: s.key, phase, vertices }); transfers.push(vertices.buffer);
      this.deathSent.set(id, poseKey(s.key, phase));
      if (s.state === 'dead') s.posted = true;
    }
    for (const [id, pk] of this.deathSent) {
      const s = this.cc.states.get(id);
      if (!s || s.state === 'gone') { removed.push(pk); this.deathSent.delete(id); }
    }
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
    const seen = new Set(); // pass 0 gives every nearby model one group before any model gets extra phases
    for (const [pass, [, i]] of [...near.map(n => [0, n]), ...near.map(n => [1, n])]) {
      const model = this.model(i);
      if (!model?.actor) continue;
      const sp = this.speedOf(i, model), phase = actorPhase(i.id) + (sp ? ACTOR.phases : 0);
      const id = poseKey(i.key, phase);
      if (groups.has(id) || (pass === 0 && seen.has(i.key))) continue;
      if (groups.size >= ACTOR.maxGroups || bytes + model.bytes > ACTOR.maxBytes) continue;
      seen.add(i.key);
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
      const bytes = await this.source.read(instance.path, { background: true, shouldDefer:()=>this.closed });
      if (this.closed) return;
      const actor = this.wasm.SceneActor.create(bytes, instance.path, JSON.stringify(instance.skins || []), instance.geosets && JSON.stringify(instance.geosets));
      const duration = actor.duration(0);
      if (!(duration > 0)) { actor.free(); retry(Infinity); this.stats.failed++; this.stats.last = `no stand clip: ${instance.path}`; return; }
      const death = actor.duration(1), walk = actor.duration(4), walkSpeed = walk > 0 ? (actor.move_speed?.(4) ?? 0) : 0;
      this.models.set(instance.key, { actor, duration, walk, death, walkSpeed, bytes: actor.vertex_count() * 48, used: this.now() });
      this.stats.models = [...this.models.values()].filter(e => e.actor).length;
    } catch (error) {
      if(this.closed)return;
      if (error?.code === 'DEFERRED') retry(ACTOR.retryMs);
      else { retry(Infinity); this.stats.failed++; this.stats.last = `${instance.path} skins=${JSON.stringify(instance.skins)}: ${error?.message ?? error}`; }
    }
  }

  update(instances, focus) {
    if (this.closed || !focus) return;
    const start = this.now(), groups = this.enabled ? this.select(instances, focus) : new Map(), poses = [], transfers = [];
    const seconds = start / 1000;
    // Rotate the start so a spent budget starves different groups each tick instead of always the farthest.
    const list = [...groups], at = list.length ? (this.cursor = (this.cursor ?? -1) + 1) % list.length : 0;
    let done = 0;
    for (const [id, g] of [...list.slice(at), ...list.slice(0, at)]) {
      if (this.now() - start >= ACTOR.budgetMs && done) break;
      done++;
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
    this.deathPoses(poses, transfers, removed);
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
      if (this.cc.states.size && this.cc.isDeadOrDying(i.id)) {
        const st = this.walk.get(i.id);
        if (st?.last) {
          if (st.last.vx || st.last.vy) st.last = { ...st.last, vx: 0, vy: 0 };
          const l = st.last; moves.push([i.id, l.x, l.y, l.z, l.yaw, 0, 0]); seen.add(i.id);
        }
        continue;
      }
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
