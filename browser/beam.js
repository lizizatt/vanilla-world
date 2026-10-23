// Energy-binder beam state for SWE1R pods (the pink arc between the engines). Pure numbers; the scene shader scrolls/jitters it.
// Returns [active, intensity, arc, broken]: intensity rises with throttle/boost/heat, arc = jitter amount (hot or damaged), broken = an engine is dead.
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

export function beamState({ throttle = 0, boosting = false, heat = 0, health = [1, 1] } = {}) {
  const worst = Math.min(...health);
  const intensity = clamp(0.45 + 0.25 * throttle + (boosting ? 0.35 : 0) + 0.4 * heat, 0, 1.6);
  const arc = Math.max(clamp((heat - 0.6) / 0.4), clamp((0.6 - worst) / 0.6));
  return [1, intensity, arc, worst <= 0.02 ? 1 : 0];
}
