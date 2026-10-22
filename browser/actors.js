// Bounded nearby creature animation: the world worker re-poses a few shared Stand loops with the
// Rust rig and posts whole vertex buffers; the renderer swaps them in. Visual only: nothing here
// touches collision, readiness or physics, and unsupported models just stay in bind pose.
export const ACTOR = Object.freeze({
  radius: 120,
  maxGroups: 16,
  maxModels: 24,
  phases: 3,
  tickMs: 100,
  budgetMs: 2,
  maxBytes: 8 * 1024 * 1024,
  retryMs: 5000,
});

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
    this.sent = new Map(); // poseKey -> bytes
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
      const id = poseKey(i.key, actorPhase(i.id));
      if (groups.has(id)) continue;
      if (groups.size >= ACTOR.maxGroups || bytes + model.bytes > ACTOR.maxBytes) continue;
      groups.set(id, { key: i.key, phase: actorPhase(i.id), model });
      bytes += model.bytes;
    }
    return groups;
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
      this.models.set(instance.key, { actor, duration, bytes: actor.vertex_count() * 48, used: this.now() });
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
      const offset = g.phase * g.model.duration / ACTOR.phases;
      let vertices;
      try { vertices = g.model.actor.pose(0, seconds + offset); }
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

  snapshot() { return { ...this.stats, ms: Math.round(this.stats.ms * 10) / 10 }; }

  close() {
    this.closed = true;
    for (const key of [...this.models.keys()]) this.drop(key);
  }
}
