use super::*;
use crate::{Input, State, FIXED_DT, HOVER_HEIGHT};

fn params(scale: f64) -> Params {
    let table = [(150.0, 0.0, 0.5, 0.7), (220.0, 0.35, 0.3, 2.1), (300.0, -0.5, 0.15, 4.0), (420.0, 0.9, 0.05, 5.3)];
    let mut a = vec![1.0, 1024.0, 80.0, 16.0, 0.25, 4.0];
    for (n, off, amp, phase) in table {
        let omega = TAU * n / 1024.0;
        let h: f64 = 0.6 + off;
        a.extend([omega * omega / 48.0, omega, h.cos(), h.sin(), amp, 0.5, phase]);
    }
    a.extend([1.0, 0.0, 0.0, 100.0, 200.0, scale, 0.5]);
    Params::from_array(&a).unwrap()
}

#[test]
fn deterministic_and_wraps_exactly() {
    let p = params(2.5);
    let a = p.sample([123.4, -56.7], p.time_at(777), &open_sea);
    let b = p.sample([123.4, -56.7], p.time_at(777), &open_sea);
    assert_eq!(a, b);
    let wrap = 1024 * TICKS_PER_SECOND;
    assert_eq!(p.time_at(777), p.time_at(777 + wrap));
    assert!(p.height([5.0, 5.0], p.time_at(0), &open_sea).is_finite());
}

#[test]
fn normals_match_finite_differences() {
    let p = params(10.0);
    let t = 31.0;
    let eps = 1e-3;
    for q in [[10.0, 20.0], [-300.0, 40.0], [1000.0, -700.0]] {
        let s = p.sample(q, t, &open_sea);
        let hx = (p.height([q[0] + eps, q[1]], t, &open_sea) - p.height([q[0] - eps, q[1]], t, &open_sea)) / (2.0 * eps);
        let hz = (p.height([q[0], q[1] + eps], t, &open_sea) - p.height([q[0], q[1] - eps], t, &open_sea)) / (2.0 * eps);
        let inv = 1.0 / (hx * hx + 1.0 + hz * hz).sqrt();
        // the 3-iteration inversion is approximate at 10x, so tolerance is loose but meaningful
        assert!((s.normal[0] + hx * inv).abs() < 0.03 && (s.normal[2] + hz * inv).abs() < 0.03, "{q:?}");
        assert!((s.normal.iter().map(|v| v * v).sum::<f64>() - 1.0).abs() < 1e-12);
    }
}

#[test]
fn slopes_stay_gentle_by_default() {
    let p = params(1.0);
    let mut worst: f64 = 0.0;
    for i in 0..2000 {
        let s = p.sample([i as f64 * 7.3, i as f64 * -3.1], i as f64 * 0.37, &open_sea);
        worst = worst.max(s.normal[0].hypot(s.normal[2]) / s.normal[1]);
    }
    assert!(worst < 0.25, "{worst}");
}

#[test]
fn shore_fades_to_exactly_zero() {
    let p = params(10.0);
    let land = |q: [f64; 2]| q[0].abs();
    for x in [0.0, 5.0, 30.0] {
        // within margin + max displacement of land the surface is exactly flat
        let s = p.sample([x, 0.0], 12.3, &land);
        if x <= p.shore_margin {
            assert_eq!(s, FLAT);
        }
    }
    let far = p.sample([4000.0, 0.0], 12.3, &land);
    assert!(far.amp_k > 0.0 && far.height != 0.0);
    // fade is monotonic with distance
    let mut last = 0.0;
    for x in 0..40 {
        let k = p.shore_k(x as f64 * 5.0);
        assert!(k >= last);
        last = k;
    }
}

#[test]
fn invalid_parameters_are_rejected() {
    let good = params(1.0);
    let mut a = vec![1.0, 1024.0, 80.0, 16.0, 0.25, 1.0, 0.1, 0.0, 1.0, 0.0, 1.0, 0.5, 0.0, 0.0];
    assert!(Params::from_array(&a).is_err(), "non-integer omega multiple");
    assert!(Params::from_array(&[]).is_err());
    assert!(Params::from_array(&[2.0; 20]).is_err());
    a = vec![f64::NAN; 14];
    assert!(Params::from_array(&a).is_err());
    let mut p = good.clone();
    p.components[0].amp = 50.0;
    assert!(p.validate().is_err(), "slope cap");
    let mut p = good.clone();
    p.discs[0].scale = 20.0;
    assert!(p.validate().is_err());
    let mut p = good;
    p.period = 1024.001;
    assert!(p.validate().is_err());
}

#[test]
fn three_iteration_inversion_is_close_to_converged() {
    let p = params(2.5);
    let t = 100.0;
    for q in [[10.0, 20.0], [-300.0, 40.0], [1000.0, -700.0]] {
        let s = p.sample(q, t, &open_sea);
        let mut p0 = q;
        for _ in 0..60 {
            let mut d = [0.0, 0.0];
            let m = p.region_scale(p0);
            for c in &p.components {
                let th = c.k * (c.dir[0] * p0[0] + c.dir[1] * p0[1]) - c.omega * t + c.phase;
                d[0] += m * c.steepness * c.amp * th.cos() * c.dir[0];
                d[1] += m * c.steepness * c.amp * th.cos() * c.dir[1];
            }
            p0 = [q[0] - d[0], q[1] - d[1]];
        }
        let m = p.region_scale(p0);
        let h: f64 = p
            .components
            .iter()
            .map(|c| m * c.amp * (c.k * (c.dir[0] * p0[0] + c.dir[1] * p0[1]) - c.omega * t + c.phase).sin())
            .sum();
        assert!((h - s.height).abs() < 0.02, "{} vs {}", h, s.height);
    }
}

fn surface_track(p: &Params, at: [f64; 2], ticks: u64) -> (f64, f64) {
    let h = |k: u64| p.height(at, p.time_at(k), &open_sea);
    (h(ticks), (h(ticks + 1) - h(ticks)) * TICKS_PER_SECOND as f64)
}

#[test]
fn flat_water_hover_is_unchanged_by_zero_amplitude() {
    let run = |wave: Option<&Params>| {
        let mut s = State::new([0.0, HOVER_HEIGHT + 2.0, 0.0], 0.0).unwrap();
        for k in 0..600u64 {
            let (h, v) = wave.map_or((0.0, 0.0), |p| surface_track(p, [0.0, 0.0], k));
            let d = (s.position[1] as f64 - h) as f32;
            s.step_with_surface_motion(Input::default(), [Some(d); 4], v as f32, FIXED_DT, &Default::default()).unwrap();
            s.position[1] += s.velocity[1] * FIXED_DT;
        }
        s.position[1].to_bits()
    };
    let mut off = params(1.0);
    off.discs.clear();
    off.components.iter_mut().for_each(|c| c.amp = 0.0);
    assert_eq!(run(None), run(Some(&off)));
}

#[test]
fn hover_spring_tracks_a_swell() {
    for scale in [1.0, 2.5, 10.0] {
        let mut p = params(scale);
        p.discs[0].inner = 1.0e9;
        p.discs[0].outer = 1.0e9 + 1.0;
        let (h0, v0) = surface_track(&p, [0.0, 0.0], 0);
        let mut s = State::new([0.0, (h0 + f64::from(HOVER_HEIGHT)) as f32, 0.0], 0.0).unwrap();
        s.velocity[1] = v0 as f32;
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for k in 0..(40 * 120u64) {
            let (h, v) = surface_track(&p, [0.0, 0.0], k);
            let d = (s.position[1] as f64 - h) as f32;
            if d <= 0.0 {
                panic!("pod went through the surface at scale {scale}: {d}");
            }
            if k > 10 * 120 {
                lo = lo.min(d);
                hi = hi.max(d);
            }
            s.step_with_surface_motion(Input::default(), [Some(d); 4], v as f32, FIXED_DT, &Default::default()).unwrap();
            s.position[1] += s.velocity[1] * FIXED_DT;
        }
        // The spring follows the swell: height above water stays near HOVER_HEIGHT with bounded bounce.
        assert!(lo > 0.2 && hi < HOVER_HEIGHT * 3.0, "scale {scale}: {lo}..{hi}");
    }
}
