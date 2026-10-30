use super::*;
use crate::waves::{open_sea, Component, Params, TICKS_PER_SECOND};

struct Flat(f64);
impl WaterField for Flat {
    fn sample(&self, _: f64, _: f64) -> WaterSample {
        WaterSample { height: self.0, normal: [0.0, 1.0, 0.0], surface_velocity: [0.0; 3], amp_k: 0.0, depth: f64::INFINITY }
    }
}

struct Swell {
    params: Params,
    t: f64,
}
impl WaterField for Swell {
    fn sample(&self, x: f64, z: f64) -> WaterSample {
        let s = self.params.sample([x, z], self.t, &open_sea);
        WaterSample { height: s.height, normal: s.normal, surface_velocity: s.velocity, amp_k: s.amp_k, depth: f64::INFINITY }
    }
}

const XS: [f64; 5] = [-2.0, -1.0, 0.0, 1.0, 2.0];
const DT: f64 = 1.0 / 120.0;
// Rho * g * 5 cells = weight, so each point is half submerged at rest: centre depth 0.
const MASS: f64 = 2.5;
const RHO: f64 = 1.0;
const G: f64 = 48.0;
const INERTIA: f64 = 8.0;

struct Buoy {
    y: f64,
    vy: f64,
    pitch: f64,
    wp: f64,
}
impl Buoy {
    fn points(&self) -> [[f64; 3]; 5] {
        XS.map(|x| [x, self.y + x * self.pitch, 0.0])
    }
    fn step(&mut self, field: &impl WaterField) {
        let pts = self.points();
        let mut sub = Submerged { contacts: [DRY; 5], volume: 0.0 };
        query(field, &pts, 1.0, 1.0, &mut sub);
        let (f, t) = buoyancy(&pts, &sub, RHO, G, 1.0, 1.0, [0.0, self.y, 0.0]);
        let d = drag(&sub, [0.0, self.vy, 0.0], 0.8, 1.0);
        self.vy += (f[1] / MASS - G + d[1] / MASS) * DT;
        self.wp += (t[2] / INERTIA - 3.0 * self.wp) * DT;
        self.y += self.vy * DT;
        self.pitch += self.wp * DT;
    }
}

#[test]
fn settles_to_archimedes_depth_in_flat_water() {
    let mut b = Buoy { y: 1.5, vy: 0.0, pitch: 0.0, wp: 0.0 };
    for _ in 0..4000 {
        b.step(&Flat(0.0));
    }
    assert!(b.y.abs() < 0.02, "{}", b.y);
    assert!(b.pitch.abs() < 1e-9);
}

#[test]
fn rides_a_swell_with_bounded_heave_and_pitch() {
    let mut params = {
        let omega = std::f64::consts::TAU * 150.0 / 1024.0;
        Params {
            period: 1024.0,
            shore_fade: 80.0,
            shore_margin: 16.0,
            default_slope_cap: 0.25,
            components: vec![Component { k: omega * omega / G, omega, dir: [1.0, 0.0], amp: 1.0, steepness: 0.5, phase: 0.0 }],
            discs: vec![],
        }
    };
    params.components[0].amp = 1.0;
    let mut b = Buoy { y: 0.0, vy: 0.0, pitch: 0.0, wp: 0.0 };
    let (mut peak_early, mut peak_late) = (0.0f64, 0.0f64);
    for k in 0..(60 * TICKS_PER_SECOND) {
        let field = Swell { params: params.clone(), t: params.time_at(k) };
        b.step(&field);
        assert!(b.y.is_finite() && b.pitch.abs() < 0.5, "{k}");
        if k < 30 * TICKS_PER_SECOND { peak_early = peak_early.max(b.y.abs()) } else { peak_late = peak_late.max(b.y.abs()) }
    }
    assert!(peak_late < 3.0 && peak_late <= peak_early * 1.2, "{peak_early} {peak_late}");
}

#[test]
fn queries_are_bitwise_deterministic() {
    let run = || {
        let mut b = Buoy { y: 2.0, vy: 0.0, pitch: 0.1, wp: 0.0 };
        for _ in 0..500 {
            b.step(&Flat(0.3));
        }
        (b.y.to_bits(), b.pitch.to_bits())
    };
    assert_eq!(run(), run());
}

#[test]
fn partial_immersion_fraction() {
    let mut sub = Submerged { contacts: [DRY; 2], volume: 0.0 };
    query(&Flat(0.0), &[[0.0, 0.25, 0.0], [0.0, -2.0, 0.0]], 1.0, 1.0, &mut sub);
    assert!((sub.contacts[0].fraction - 0.25).abs() < 1e-12);
    assert_eq!(sub.contacts[1].fraction, 1.0);
}
