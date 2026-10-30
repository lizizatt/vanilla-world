use super::tests::fixture;
use super::*;
use flats_racer_physics::waves::{Component, Disc, Params};
use std::f64::consts::TAU;

fn table(scale: f64) -> Vec<f64> {
    let mut a = vec![1.0, 1024.0, 80.0, 16.0, 0.25, 4.0];
    for (n, off, amp, phase) in [(150.0, 0.0, 0.5, 0.7), (220.0, 0.35, 0.3, 2.1), (300.0, -0.5, 0.15, 4.0), (420.0, 0.9, 0.05, 5.3)] {
        let omega = TAU * n / 1024.0;
        let h: f64 = 0.6 + off;
        a.extend([omega * omega / 48.0, omega, h.cos(), h.sin(), amp, 0.5, phase]);
    }
    // One huge disc so the whole fixture strip sits at `scale`.
    a.extend([1.0, 1000.0, 266.0, 1.0e7, 1.0e7 + 1.0, scale, 0.5]);
    a
}

fn world(waves: Option<&[f64]>) -> Voyage {
    let mut w = Voyage::from_manifest(fixture(0.0)).unwrap();
    if let Some(a) = waves {
        w.set_waves(a).unwrap();
    }
    w
}

fn cruise(w: &mut Voyage, ticks: u32, jump_at: Option<u32>) -> Vec<(f32, f64, u8)> {
    w.origin = [600.0, 266.0];
    w.state = State::new([0.0, 1.1, 0.0], -std::f32::consts::FRAC_PI_2).unwrap();
    let mut out = vec![];
    for k in 0..ticks {
        let input = Input { throttle: 1.0, jump: jump_at.is_some_and(|j| k >= j && k < j + 120 && (k - j) % 30 < 2), ..Default::default() };
        w.advance(input).unwrap();
        let g = w.global();
        out.push((w.state.position[1], f64::from(w.sample(g).water.unwrap_or(0.0)), w.hold));
    }
    out
}

#[test]
fn waves_off_is_bit_identical_to_flat_water() {
    let mut a = world(None);
    let mut b = world(Some(&table(10.0)));
    b.set_waves(&[]).unwrap();
    a.whirlpool = Some([1000.0, 266.0, 300.0, 40.0]);
    b.whirlpool = a.whirlpool;
    for (x, z) in [(700.0, 100.0), (1000.0, 266.0), (1500.0, 500.0), (540.0, 10.0), (1990.0, 266.0)] {
        assert_eq!(a.sample([x, z]).water.map(f32::to_bits), b.sample([x, z]).water.map(f32::to_bits));
    }
    let (ra, rb) = (cruise(&mut a, 600, Some(100)), cruise(&mut b, 600, Some(100)));
    assert!(ra.iter().zip(&rb).all(|(p, q)| p.0.to_bits() == q.0.to_bits() && p.1.to_bits() == q.1.to_bits() && p.2 == q.2));
    let flat = world(None);
    assert_eq!(flat.sample([1000.0, 266.0]).water, Some(0.0));
}

#[test]
fn waves_move_with_sim_ticks_only_and_fade_at_shore() {
    let mut w = world(Some(&table(1.0)));
    let at = |w: &Voyage, x: f64| w.sample([x, 266.0]).water.unwrap();
    let h0 = at(&w, 1000.0);
    assert_eq!(at(&w, 1000.0), h0, "no tick, no motion");
    assert_ne!(h0, 0.0);
    w.origin = [1500.0, 266.0];
    w.state = State::new([0.0, 5.0, 0.0], 0.0).unwrap();
    for _ in 0..240 {
        w.advance(Input::default()).unwrap();
    }
    assert_eq!(w.wave_ticks(), 240.0);
    assert_ne!(at(&w, 1000.0), h0);
    // flat at the authored tile edge (x = 533.3) and the ocean-rect edge (z = 0)
    for p in [[534.0, 266.0], [1000.0, 1.0], [1000.0, 532.0], [1995.0, 266.0]] {
        assert_eq!(w.sample(p).water, Some(0.0), "{p:?}");
    }
    let batch = w.water_sample_batch(&[1000.0, 266.0, 534.0, 266.0]).unwrap();
    assert_eq!(batch.len(), 16);
    assert_eq!(batch[0], at(&w, 1000.0));
    assert_eq!(&batch[9..12], &[0.0, 1.0, 0.0]);
}

#[test]
fn flights_over_a_ten_times_swell_and_a_steep_face() {
    let mut w = world(Some(&table(10.0)));
    let run = cruise(&mut w, 1200, None);
    let holds = run.iter().filter(|r| r.2 != 0).count();
    let (lo, hi) = run.iter().fold((f64::MAX, f64::MIN), |(l, h), r| (l.min(r.1), h.max(r.1)));

    let mut storm_a = world(Some(&table(2.5)));
    let mut storm_b = world(Some(&table(2.5)));
    let (calm, jump) = (cruise(&mut storm_a, 1200, None), cruise(&mut storm_b, 1200, Some(300)));
    let clearance = |r: &[(f32, f64, u8)]| r[300..420].iter().map(|s| f64::from(s.0) - s.1).fold(f64::MIN, f64::max);
    let air = clearance(&jump) - clearance(&calm);
    println!("10x cruise: surface {lo:.2}..{hi:.2} yd, holds {holds}; 2.5x storm peak clearance cruise {:.2} jump {:.2} yd", clearance(&calm), clearance(&jump));
    assert!(hi - lo > 5.0, "swell must be visible");
    assert_eq!(holds, 0, "a 0.38-slope face is glided, not hit");
    assert!(air > 0.2, "jump must leave the swell: {air}");

    // Steep face: bypass validation to force a slope far above the cap; the same SUPPORT_RISE rollback as land fires.
    let mut steep = Params::from_array(&table(1.0)).unwrap();
    steep.components = vec![Component { k: 0.02, omega: TAU * 150.0 / 1024.0, dir: [1.0, 0.0], amp: 150.0, steepness: 0.0, phase: 0.0 }];
    steep.discs.clear();
    steep.shore_margin = 0.0;
    steep.shore_fade = 1.0;
    let mut w3 = world(None);
    w3.waves = Some(steep);
    let (mut hold_tick, mut health) = (None, w3.state.health);
    w3.origin = [700.0, 266.0];
    w3.state = State::new([0.0, 1.1, 0.0], -std::f32::consts::FRAC_PI_2).unwrap();
    for k in 0..2400 {
        w3.advance(Input { throttle: 1.0, ..Default::default() }).unwrap();
        if w3.hold == 3 && hold_tick.is_none() {
            hold_tick = Some(k);
            health = w3.state.health;
        }
    }
    println!("steep face: hold=3 at tick {hold_tick:?}, health {health:?}, velocity {:?}", w3.state.velocity);
    assert!(hold_tick.is_some(), "a face steeper than SUPPORT_RISE must collide like land");
    let _ = Disc { centre: [0.0; 2], inner: 0.0, outer: 1.0, scale: 1.0, slope_cap: 1.0 };
}

#[test]
fn rust_matches_the_javascript_golden_vectors() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../../browser/wave-golden.json")).unwrap();
    let nums = |v: &serde_json::Value| v.as_array().unwrap().iter().map(|n| n.as_f64().unwrap()).collect::<Vec<_>>();
    let params = Params::from_array(&nums(&golden["params"])).unwrap();
    for (i, c) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let p = nums(&c["p"]);
        let t = params.time_at(c["tick"].as_u64().unwrap());
        let s = params.sample([p[0], p[1]], t, &flats_racer_physics::waves::open_sea);
        let want: Vec<f64> = [vec![c["h"].as_f64().unwrap(), c["amp"].as_f64().unwrap()], nums(&c["n"]), nums(&c["v"])].concat();
        let got: Vec<f64> = [vec![s.height, s.amp_k], s.normal.to_vec(), s.velocity.to_vec()].concat();
        for (a, b) in want.iter().zip(&got) {
            assert!((a - b).abs() < 1e-9, "case {i}: js {a} rust {b}");
        }
    }
}
