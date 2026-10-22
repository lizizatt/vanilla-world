// Deterministic visual-only NPC wandering: position is a pure function of (id, home, wall-clock seconds),
// so every client and every reload agrees. Classes are guessed from the model path because the public
// pack carries no creature type, wander radius or movement type (see SCENE.md "NPC pack provenance").
export const WANDER = Object.freeze({
  critter: { radius: 8, speed: 1.4, chance: 1 },
  civilian: { radius: 5, speed: 2.2, chance: 0.2 },
  period: [14, 30],
  maxHeightDelta: 2,
  maxSlope: 1.2,
  turnRate: 4,
});

// shortcut: critters by name list, guards/vendors are indistinguishable from civilians without creature templates.
const CRITTER = /(^|[\\/])(rabbit|squirrel|rat|mouse|cat|chicken|frog|toad|crab|snake|sheep|bunny|deer|fawn|seagull|bird|crow|raven|roach|spider|scorpid|worm|turtle|beetle)/i;

export function npcClass(path) {
  if (/^character[\\/]/i.test(path)) return 'civilian';
  return CRITTER.test(path) ? 'critter' : undefined;
}

const hash = (a, b = 0) => {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
};
export const idSeed = id => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return hash(h);
};
const unit = (seed, k, n) => hash(seed ^ Math.imul(k, 0x45d9f3b), n) / 4294967296;

export const wanders = (cls, seed) => !!cls && unit(seed, 0, 99) < WANDER[cls].chance;

const waypoint = (home, radius, seed, k) => {
  const a = unit(seed, k, 1) * Math.PI * 2, r = radius * Math.sqrt(unit(seed, k, 2));
  return [home[0] + Math.cos(a) * r, home[1] + Math.sin(a) * r];
};

/** Source-space yards: position, facing (rad, WoW orientation) and velocity at time t (seconds). */
export function wanderState(seed, cls, home, t) {
  const { radius, speed } = WANDER[cls], [lo, hi] = WANDER.period;
  const period = lo + unit(seed, 0, 3) * (hi - lo), offset = unit(seed, 0, 4) * period;
  const k = Math.floor((t + offset) / period), into = t + offset - k * period;
  const from = waypoint(home, radius, seed, k - 1), to = waypoint(home, radius, seed, k);
  const dx = to[0] - from[0], dy = to[1] - from[1], dist = Math.hypot(dx, dy);
  const travel = Math.min(dist / speed, period * 0.8), heading = Math.atan2(dy, dx);
  if (dist < 1e-6 || into >= travel) return { x: to[0], y: to[1], yaw: heading, vx: 0, vy: 0 };
  const f = into / travel, v = dist / travel;
  return { x: from[0] + dx * f, y: from[1] + dy * f, yaw: heading, vx: dx / dist * v, vy: dy / dist * v };
}
