//! Crash proof of concept: a wrecked racer splits into a pod and two engines, each a box rigid body
//! that tumbles against a caller-supplied ground. A random subset of the engines stays tethered to the pod.
//! Debug-only; nothing in `step` or the race flow calls it.

use crate::GRAVITY;

type V = [f32; 3];
type Q = [f32; 4];

const DT: f32 = 1.0 / 120.0;
const RESTITUTION: f32 = 0.3;
const FRICTION: f32 = 0.6;

fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V, s: f32) -> V {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V, b: V) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V, b: V) -> V {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn qmul(a: Q, b: Q) -> Q {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

/// Rotation matrix columns of a unit quaternion.
fn basis(q: Q) -> [V; 3] {
    let [x, y, z, w] = q;
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w)],
        [2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w)],
        [2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

fn rotate(q: Q, v: V) -> V {
    let b = basis(q);
    add(add(mul(b[0], v[0]), mul(b[1], v[1])), mul(b[2], v[2]))
}

/// Unit quaternion from orthonormal columns (a proper rotation).
pub fn quat_from_columns(c: [V; 3]) -> Q {
    let (m00, m10, m20) = (c[0][0], c[0][1], c[0][2]);
    let (m01, m11, m21) = (c[1][0], c[1][1], c[1][2]);
    let (m02, m12, m22) = (c[2][0], c[2][1], c[2][2]);
    let t = m00 + m11 + m22;
    let q = if t > 0.0 {
        let s = (t + 1.0).sqrt() * 2.0;
        [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
    } else if m00 > m11 && m00 > m22 {
        let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0;
        [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
    } else if m11 > m22 {
        let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0;
        [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
    } else {
        let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0;
        [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
    };
    normalize(q)
}

fn normalize(q: Q) -> Q {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if n > 1e-9 {
        [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
    } else {
        [0.0, 0.0, 0.0, 1.0]
    }
}

/// Box part in model space (center and half extents before scaling).
#[derive(Clone, Copy, Debug)]
pub struct PartSpec {
    pub center: V,
    pub half: V,
}

#[derive(Clone, Debug)]
pub struct Body {
    pub pos: V,
    pub vel: V,
    pub rot: Q,
    pub spin: V,
    half: V,
    inv_mass: f32,
    inv_inertia: V,
}

impl Body {
    fn new(pos: V, rot: Q, half: V) -> Self {
        let mass = (half[0] * half[1] * half[2]).max(1e-6);
        let inertia = [
            mass / 3.0 * (half[1] * half[1] + half[2] * half[2]),
            mass / 3.0 * (half[0] * half[0] + half[2] * half[2]),
            mass / 3.0 * (half[0] * half[0] + half[1] * half[1]),
        ];
        Self {
            pos,
            vel: [0.0; 3],
            rot,
            spin: [0.0; 3],
            half,
            inv_mass: 1.0 / mass,
            inv_inertia: inertia.map(|i| 1.0 / i.max(1e-9)),
        }
    }

    fn corners(&self) -> [V; 8] {
        let mut out = [[0.0; 3]; 8];
        for (i, c) in out.iter_mut().enumerate() {
            let local = [
                if i & 1 == 0 { -self.half[0] } else { self.half[0] },
                if i & 2 == 0 { -self.half[1] } else { self.half[1] },
                if i & 4 == 0 { -self.half[2] } else { self.half[2] },
            ];
            *c = add(self.pos, rotate(self.rot, local));
        }
        out
    }

    /// World-space inverse inertia applied to a vector.
    fn inv_inertia_apply(&self, v: V) -> V {
        let b = basis(self.rot);
        let local = [dot(b[0], v), dot(b[1], v), dot(b[2], v)];
        let scaled = [
            local[0] * self.inv_inertia[0],
            local[1] * self.inv_inertia[1],
            local[2] * self.inv_inertia[2],
        ];
        add(add(mul(b[0], scaled[0]), mul(b[1], scaled[1])), mul(b[2], scaled[2]))
    }

    fn point_velocity(&self, r: V) -> V {
        add(self.vel, cross(self.spin, r))
    }

    fn impulse(&mut self, r: V, j: V) {
        self.vel = add(self.vel, mul(j, self.inv_mass));
        self.spin = add(self.spin, self.inv_inertia_apply(cross(r, j)));
    }

    /// Inverse effective mass along unit `n` at lever arm `r`.
    fn effective(&self, r: V, n: V) -> f32 {
        let rn = cross(r, n);
        self.inv_mass + dot(cross(self.inv_inertia_apply(rn), r), n)
    }
}

/// Pod-to-engine rope: anchors in each body's local frame, slack up to `rest`.
#[derive(Clone, Debug)]
struct Tether {
    pod: usize,
    engine: usize,
    pod_anchor: V,
    engine_anchor: V,
    rest: f32,
}

pub struct Wreck {
    pub bodies: Vec<Body>,
    /// Per body: still tied to the pod (the pod itself is always `true`).
    pub connected: Vec<bool>,
    tethers: Vec<Tether>,
    seed: u32,
}

impl Wreck {
    /// `rot` is the craft's model-to-world rotation (unit columns), `pos` its model origin, `scale` model->world,
    /// `vel` the craft velocity. Part 0 is the pod; others are engines and each stays tethered by chance.
    pub fn new(pos: V, rot: [V; 3], scale: f32, vel: V, parts: &[PartSpec], seed: u32) -> Self {
        let q = quat_from_columns(rot);
        let mut wreck = Self {
            bodies: vec![],
            connected: vec![],
            tethers: vec![],
            seed: seed | 1,
        };
        for (i, part) in parts.iter().enumerate() {
            let center = add(pos, rotate(q, mul(part.center, scale)));
            let half = mul(part.half, scale).map(|h| h.max(0.02));
            let mut body = Body::new(center, q, half);
            body.vel = mul(vel, 0.7);
            if i > 0 {
                let side = sub(center, wreck.bodies[0].pos);
                let out = [side[0], 0.0, side[2]];
                let n = dot(out, out).sqrt().max(1e-3);
                body.vel = add(body.vel, mul(out, (4.0 + 6.0 * wreck.rand()) / n));
                body.vel[1] += 3.0 + 5.0 * wreck.rand();
                body.spin = [wreck.signed() * 4.0, wreck.signed() * 4.0, wreck.signed() * 4.0];
            } else {
                body.vel[1] += 2.0 * wreck.rand();
                body.spin = [wreck.signed() * 1.5, wreck.signed(), wreck.signed() * 1.5];
            }
            let tie = i > 0 && wreck.rand() < 0.5;
            if tie {
                let pod = &wreck.bodies[0];
                let to_pod = sub(pod.pos, body.pos);
                let rest = dot(to_pod, to_pod).sqrt() * 1.1 + 0.3;
                let pod_anchor = [0.0, 0.0, 0.0];
                let engine_anchor = [0.0, 0.0, 0.0];
                wreck.tethers.push(Tether {
                    pod: 0,
                    engine: i,
                    pod_anchor,
                    engine_anchor,
                    rest,
                });
            }
            wreck.connected.push(i == 0 || tie);
            wreck.bodies.push(body);
        }
        wreck
    }

    fn rand(&mut self) -> f32 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 17;
        self.seed ^= self.seed << 5;
        (self.seed >> 8) as f32 / (1u32 << 24) as f32
    }

    fn signed(&mut self) -> f32 {
        self.rand() * 2.0 - 1.0
    }

    /// Advance one fixed step. `ground(x, z)` gives the support height and whether it is water.
    pub fn step(&mut self, ground: &mut dyn FnMut(f32, f32) -> (f32, bool)) {
        for body in &mut self.bodies {
            body.vel[1] -= GRAVITY * DT;
            body.vel = mul(body.vel, 1.0 - 0.15 * DT);
            body.spin = mul(body.spin, 1.0 - 0.4 * DT);
        }
        for t in self.tethers.clone() {
            let (pa, ea) = (&self.bodies[t.pod], &self.bodies[t.engine]);
            let rp = rotate(pa.rot, t.pod_anchor);
            let re = rotate(ea.rot, t.engine_anchor);
            let delta = sub(add(ea.pos, re), add(pa.pos, rp));
            let dist = dot(delta, delta).sqrt();
            if dist <= t.rest || dist < 1e-6 {
                continue;
            }
            let n = mul(delta, 1.0 / dist);
            let rel = dot(sub(ea.point_velocity(re), pa.point_velocity(rp)), n);
            let w = pa.effective(rp, n) + ea.effective(re, n);
            let j = -(rel * 0.8 + (dist - t.rest) * 8.0) / w;
            let j = j.min(0.0);
            self.bodies[t.pod].impulse(rp, mul(n, -j));
            self.bodies[t.engine].impulse(re, mul(n, j));
        }
        for body in &mut self.bodies {
            for corner in body.corners() {
                let (height, water) = ground(corner[0], corner[2]);
                let pen = height - corner[1];
                if pen <= 0.0 {
                    continue;
                }
                let r = sub(corner, body.pos);
                let v = body.point_velocity(r);
                let n = [0.0, 1.0, 0.0];
                let restitution = if water { 0.0 } else { RESTITUTION };
                let mut jn = 0.0;
                if v[1] < 0.0 {
                    jn = -(1.0 + restitution) * v[1] / body.effective(r, n);
                    body.impulse(r, mul(n, jn));
                }
                let v = body.point_velocity(r);
                let tangent = [v[0], 0.0, v[2]];
                let speed = dot(tangent, tangent).sqrt();
                if speed > 1e-4 {
                    let t = mul(tangent, 1.0 / speed);
                    let jt = (speed / body.effective(r, t)).min(FRICTION * jn.max(0.5 * pen));
                    body.impulse(r, mul(t, -jt));
                }
                if water {
                    body.vel = mul(body.vel, 1.0 - 4.0 * DT);
                    body.spin = mul(body.spin, 1.0 - 4.0 * DT);
                }
                body.pos[1] += pen * 0.2;
            }
        }
        for body in &mut self.bodies {
            body.pos = add(body.pos, mul(body.vel, DT));
            let dq = qmul([body.spin[0] * 0.5 * DT, body.spin[1] * 0.5 * DT, body.spin[2] * 0.5 * DT, 0.0], body.rot);
            body.rot = normalize([
                body.rot[0] + dq[0],
                body.rot[1] + dq[1],
                body.rot[2] + dq[2],
                body.rot[3] + dq[3],
            ]);
        }
    }

    /// Per body `[x, y, z, qx, qy, qz, qw]`.
    pub fn pose(&self) -> Vec<f32> {
        self.bodies
            .iter()
            .flat_map(|b| [b.pos[0], b.pos[1], b.pos[2], b.rot[0], b.rot[1], b.rot[2], b.rot[3]])
            .collect()
    }

    /// Seconds per `step`.
    pub const STEP: f32 = DT;
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: [V; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    fn parts() -> Vec<PartSpec> {
        vec![
            PartSpec { center: [0.0, 0.0, 0.0], half: [1.0, 0.5, 0.4] },
            PartSpec { center: [2.0, 1.5, 0.0], half: [0.6, 0.3, 0.3] },
            PartSpec { center: [2.0, -1.5, 0.0], half: [0.6, 0.3, 0.3] },
        ]
    }
    fn flat(height: f32) -> impl FnMut(f32, f32) -> (f32, bool) {
        move |_, _| (height, false)
    }

    #[test]
    fn quaternion_round_trips_a_rotation() {
        let c = [[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let b = basis(quat_from_columns(c));
        for i in 0..3 {
            for k in 0..3 {
                assert!((b[i][k] - c[i][k]).abs() < 1e-5);
            }
        }
    }

    #[test]
    fn parts_fall_and_rest_on_the_ground_without_tunnelling() {
        let mut w = Wreck::new([0.0, 6.0, 0.0], ID, 1.0, [10.0, 0.0, 0.0], &parts(), 7);
        let mut g = flat(0.0);
        let mut lowest = f32::MAX;
        for _ in 0..600 {
            w.step(&mut g);
            for b in &w.bodies {
                lowest = lowest.min(b.corners().iter().map(|c| c[1]).fold(f32::MAX, f32::min));
                assert!(b.pos.iter().all(|v| v.is_finite()));
            }
        }
        assert!(lowest > -0.6, "corner sank {lowest}");
        for b in &w.bodies {
            assert!(b.vel[1].abs() < 1.0 && b.pos[1] > 0.0 && b.pos[1] < 1.5);
        }
    }

    #[test]
    fn rests_on_water_height_not_the_seabed() {
        let mut w = Wreck::new([0.0, 3.0, 0.0], ID, 1.0, [0.0; 3], &parts(), 3);
        let mut g = |_: f32, _: f32| (5.0, true);
        for _ in 0..600 {
            w.step(&mut g);
        }
        assert!(w.bodies.iter().all(|b| b.pos[1] > 4.0));
    }

    #[test]
    fn tethered_engines_stay_near_the_pod_and_loose_ones_may_leave() {
        let mut ties = 0;
        let mut loose = 0;
        for seed in 1..40 {
            let mut w = Wreck::new([0.0, 3.0, 0.0], ID, 1.0, [20.0, 0.0, 0.0], &parts(), seed);
            let mut g = flat(0.0);
            for _ in 0..360 {
                w.step(&mut g);
            }
            for i in 1..3 {
                let d = sub(w.bodies[i].pos, w.bodies[0].pos);
                let d = dot(d, d).sqrt();
                if w.connected[i] {
                    ties += 1;
                    assert!(d < 6.5, "tethered engine {d} away");
                } else {
                    loose += 1;
                }
            }
        }
        assert!(ties > 10 && loose > 10, "{ties} tied, {loose} loose");
    }

    #[test]
    fn same_seed_replays_identically() {
        let run = || {
            let mut w = Wreck::new([0.0, 4.0, 0.0], ID, 0.5, [5.0, 0.0, 2.0], &parts(), 99);
            let mut g = flat(0.0);
            for _ in 0..200 {
                w.step(&mut g);
            }
            w.pose()
        };
        assert_eq!(run(), run());
    }
}
