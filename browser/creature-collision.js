// Craft-vs-creature collision spike (visual/gameplay-light, never touches craft physics): a swept overlap test of the craft
// against nearby NPC cylinders and a per-creature Death -> corpse -> gone -> respawn state machine (creatures with no Death clip are left alone).
// Pure and allocation-light so it can run in the 40 ms actor tick; ActorService owns the poses, the renderer owns the visuals.
export const CREATURE_COLLISION = Object.freeze({
  minSpeed: 22,        // yd/s craft speed below which creatures are left alone
  craftRadius: 2.5,    // yd, horizontal
  craftHalfHeight: 1.5,
  maxCreatureRadius: 3, // bigger creatures are ignored (they should block, not die)
  maxCreatureHeight: 6,
  maxDying: 6,
  maxKillsPerSecond: 8,
  corpseSeconds: 25,
  respawnSeconds: 120,
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

/**
 * Craft swept from (ax,ay,az) to (bx,by,bz) against a creature's oriented hit box: model bounds scaled into yards, centred at (px,py) + the
 * rotated offset (ox,oy), turned by `yaw`, spanning feet-relative z in [zLo,zHi] (hovering and flying models sit above their feet).
 */
export function sweptOverlap(ax, ay, az, bx, by, bz, craftRadius, craftHalfHeight, px, py, pz, yaw, hx, hy, zLo, zHi, ox, oy) {
  const lo = Math.min(az, bz) - craftHalfHeight, hi = Math.max(az, bz) + craftHalfHeight;
  if (hi < pz + zLo || lo > pz + zHi) return false;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const local = (x, y, out) => { const dx = x - px, dy = y - py; out[0] = dx * c + dy * s - ox; out[1] = -dx * s + dy * c - oy; };
  const p = LOCAL_A, q = LOCAL_B; local(ax, ay, p); local(bx, by, q);
  return segmentHitsBox(p[0], p[1], q[0], q[1], hx + craftRadius, hy + craftRadius);
}
const LOCAL_A = [0, 0], LOCAL_B = [0, 0];

/** Segment vs the origin-centred box [-hx,hx]x[-hy,hy] (slab test). */
function segmentHitsBox(x0, y0, x1, y1, hx, hy) {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < 1e-9) { if (Math.abs(x0) > hx) return false; }
  else { let u = (-hx - x0) / dx, v = (hx - x0) / dx; if (u > v) { const t = u; u = v; v = t; } t0 = Math.max(t0, u); t1 = Math.min(t1, v); }
  if (t0 > t1) return false;
  if (Math.abs(dy) < 1e-9) return Math.abs(y0) <= hy;
  let u = (-hy - y0) / dy, v = (hy - y0) / dy; if (u > v) { const t = u; u = v; v = t; }
  return Math.max(t0, u) <= Math.min(t1, v);
}
/** Death hold time: the clip once, then the last frame. Returns the pose time (s) for an animation `age` seconds old. */
export const deathPoseTime = (age, duration) => Math.min(Math.max(age, 0), Math.max(duration - 0.001, 0));

export class CreatureCollision {
  constructor(rand = Math.random, config = CREATURE_COLLISION) {
    this.rand = rand; this.cfg = config; this.enabled = true;
    this.states = new Map(); // id -> {state: 'dying'|'dead'|'gone', t0, x, y, z, yaw, duration, posted}
    this.events = [];        // kills of the last update (reused array)
    this.list = []; this.listFor = undefined;
    this.prev = new Float64Array(4); this.hasPrev = false;
    this.windowStart = 0; this.windowKills = 0; this.lastSpeed = 0;
    this.stats = { kills: 0, skipped: 0, tests: 0, maxMs: 0 };
  }

  reset() { this.states.clear(); this.hasPrev = false; this.events.length = 0; this.listFor = undefined; }

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
   * home; `sizeOf(instance)` returns the hit box [halfX,halfY,zLo,zHi,offX,offY] in yards (creature-local, feet-relative) or undefined to ignore. Returns the reused events array of new kills.
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
      if (!size || Math.sqrt(size[0] * size[1]) > c.maxCreatureRadius || size[3] - size[2] > c.maxCreatureHeight) continue;
      this.stats.tests++;
      const yaw = w?.yaw ?? Math.atan2(m[1], m[0]);
      if (!sweptOverlap(ax, ay, az, x, y, z, c.craftRadius, c.craftHalfHeight, cx, cy, cz, yaw, size[0], size[1], size[2], size[3], size[4], size[5])) continue;
      const duration = durationOf(i);
      if (!(duration > 0)) { this.stats.skipped++; continue; }
      this.states.set(i.id, { state: 'dying', t0: now, x: cx, y: cy, z: cz, yaw: w?.yaw, duration, key: i.key, posted: false, goneAt: now });
      this.revision = (this.revision || 0) + 1;
      this.windowKills++; dying++; this.stats.kills++;
      events.push({ id: i.id, x: cx, y: cy, z: cz, speed });
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
