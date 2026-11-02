// Craft-vs-creature collision spike (visual/gameplay-light, never touches craft physics): a swept overlap test of the craft
// against nearby NPC cylinders, probability gating, and a per-creature Death -> corpse -> gone -> respawn state machine.
// Pure and allocation-light so it can run in the 40 ms actor tick; ActorService owns the poses, the renderer owns the visuals.
export const CREATURE_COLLISION = Object.freeze({
  minSpeed: 22,        // yd/s craft speed below which creatures are left alone
  gibSpeed: 70,        // at/above this speed the gib chance is doubled
  gibChance: 0.12,
  craftRadius: 2.5,    // yd, horizontal
  craftHalfHeight: 1.5,
  maxCreatureRadius: 3, // bigger creatures are ignored (they should block, not die)
  maxCreatureHeight: 6,
  maxDying: 6,
  maxKillsPerSecond: 8,
  corpseSeconds: 25,
  respawnSeconds: 120,
  fallbackDeathSeconds: 1.2,
  reach: 60,           // broadphase square half-width around the craft, yd
  classes: Object.freeze(['critter', 'creature', 'civilian']),
});

/** Closest approach of segment (ax,ay)->(bx,by) to point (px,py), squared. */
export function segmentDistance2(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 > 1e-12 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const cx = ax + dx * t - px, cy = ay + dy * t - py;
  return cx * cx + cy * cy;
}

/** Craft swept from (ax,ay,az) to (bx,by,bz) against a creature cylinder (feet at z, given radius and height). */
export function sweptOverlap(ax, ay, az, bx, by, bz, craftRadius, craftHalfHeight, cx, cy, cz, radius, height) {
  const r = craftRadius + radius;
  if (segmentDistance2(ax, ay, bx, by, cx, cy) > r * r) return false;
  const lo = Math.min(az, bz) - craftHalfHeight, hi = Math.max(az, bz) + craftHalfHeight;
  return hi >= cz && lo <= cz + height;
}

/** Death hold time: the clip once, then the last frame. Returns the pose time (s) for an animation `age` seconds old. */
export const deathPoseTime = (age, duration) => Math.min(Math.max(age, 0), Math.max(duration - 0.001, 0));

export class CreatureCollision {
  constructor(rand = Math.random, config = CREATURE_COLLISION) {
    this.rand = rand; this.cfg = config; this.enabled = true;
    this.states = new Map(); // id -> {state: 'dying'|'dead'|'gone', t0, gib, x, y, z, yaw, duration, posted}
    this.events = [];        // kills of the last update (reused array)
    this.list = []; this.listFor = undefined;
    this.prev = new Float64Array(4); this.hasPrev = false;
    this.windowStart = 0; this.windowKills = 0; this.lastSpeed = 0;
    this.stats = { kills: 0, gibs: 0, tests: 0, maxMs: 0 };
  }

  reset() { this.states.clear(); this.hasPrev = false; this.events.length = 0; this.listFor = undefined; }

  /** Probability gate: critters and small creatures only, gib more likely at high speed. */
  gibRoll(speed) {
    const c = this.cfg, p = c.gibChance * (speed >= c.gibSpeed ? 2 : 1);
    return this.rand() < p;
  }

  isAlive(id) { return !this.states.has(id); }
  isDeadOrDying(id) { const s = this.states.get(id); return !!s && s.state !== 'gone'; }

  /** NPC instance list, rebuilt only when the scene snapshot's array changes. */
  npcs(instances, filter) {
    if (this.listFor !== instances) {
      this.list = instances.filter(filter); this.listFor = instances;
    }
    return this.list;
  }

  /**
   * One tick. Craft at (x,y,z) source-space at time `now` (s). `positionOf(id)` returns the NPC's current {x,y,z} (wander) or undefined for the authored
   * home; `sizeOf(instance)` returns [radius,height] in yards or undefined to ignore. Returns the reused events array of new kills.
   */
  update(instances, filter, x, y, z, now, positionOf, sizeOf, classOf, durationOf) {
    const c = this.cfg, events = this.events; events.length = 0;
    this.advance(now);
    const p = this.prev;
    if (!this.enabled) { this.hasPrev = false; return events; }
    if (!this.hasPrev || now - p[3] > 1 || now <= p[3]) { p[0] = x; p[1] = y; p[2] = z; p[3] = now; this.hasPrev = true; return events; }
    const dt = now - p[3], speed = Math.hypot(x - p[0], y - p[1]) / dt;
    this.lastSpeed = speed;
    const ax = p[0], ay = p[1], az = p[2];
    p[0] = x; p[1] = y; p[2] = z; p[3] = now;
    if (speed < c.minSpeed) return events;
    if (now - this.windowStart >= 1) { this.windowStart = now; this.windowKills = 0; }
    let dying = 0;
    for (const s of this.states.values()) if (s.state === 'dying') dying++;
    for (const i of this.npcs(instances, filter)) {
      if (this.windowKills >= c.maxKillsPerSecond || dying >= c.maxDying) break;
      if (this.states.has(i.id)) continue;
      const m = i.matrix, w = positionOf(i.id), cx = w ? w.x : m[12], cy = w ? w.y : m[13], cz = w ? w.z : m[14];
      if (cx < Math.min(ax, x) - c.reach || cx > Math.max(ax, x) + c.reach || cy < Math.min(ay, y) - c.reach || cy > Math.max(ay, y) + c.reach) continue;
      const cls = classOf(i);
      if (!cls || !c.classes.includes(cls)) continue;
      const size = sizeOf(i);
      if (!size || size[0] > c.maxCreatureRadius || size[1] > c.maxCreatureHeight) continue;
      this.stats.tests++;
      if (!sweptOverlap(ax, ay, az, x, y, z, c.craftRadius, c.craftHalfHeight, cx, cy, cz, size[0], size[1])) continue;
      const duration = durationOf(i), gib = !(duration > 0) || this.gibRoll(speed);
      this.states.set(i.id, { state: gib ? 'gone' : 'dying', t0: now, gib, x: cx, y: cy, z: cz, yaw: w?.yaw, duration: duration > 0 ? duration : c.fallbackDeathSeconds,       key: i.key, posted: false, goneAt: now });
            this.revision = (this.revision || 0) + 1;
            this.windowKills++; if (!gib) dying++;
      this.stats.kills++; if (gib) this.stats.gibs++;
      events.push({ id: i.id, gib, x: cx, y: cy, z: cz, size: Math.max(size[0], size[1] * .5), speed });
    }
    return events;
  }

  /** Death state machine: dying -> dead (held last frame) -> gone (hidden) -> respawned (state dropped). Returns true if any state changed. */
  advance(now) {
    const c = this.cfg; let changed = false;
    for (const [id, s] of this.states) {
      const age = now - s.t0;
      if (s.state === 'dying' && age >= s.duration) { s.state = 'dead'; changed = true; }
      if (s.state === 'dead' && age >= s.duration + c.corpseSeconds) { s.state = 'gone'; s.goneAt = now; changed = true; }
      if (s.state === 'gone' && now - s.goneAt >= c.respawnSeconds) { this.states.delete(id); changed = true; }
    }
    if (changed) this.revision = (this.revision || 0) + 1;
    return changed;
  }
}
