//! Pole frames (design/poles.md 4): frame selection, the exact hop between charts, the E longitude wrap and the east-west metric ramp.
//! E is the authored chart (global = chart, centred on `centre`); N and S are the same equirect chart rotated so the pole is the chart origin (chart = global - anchor).
use super::math::contains;
use super::types::FrameSpec;
use super::Voyage;

pub const FRAME_E: u8 = 0;

/// Frame direction -> body direction. N: (x, y, z) -> (y, x, -z); S: (x, y, z) -> (y, -x, z). Exact permutations.
fn to_body(frame: u8, d: [f64; 3]) -> [f64; 3] {
    match frame {
        1 => [d[1], d[0], -d[2]],
        2 => [d[1], -d[0], d[2]],
        _ => d,
    }
}

fn to_frame(frame: u8, d: [f64; 3]) -> [f64; 3] {
    match frame {
        1 => [d[1], d[0], -d[2]],
        2 => [-d[1], d[0], d[2]],
        _ => d,
    }
}

fn centre_of(spec: &FrameSpec, frame: u8) -> [f64; 2] {
    if frame == FRAME_E {
        spec.centre
    } else {
        [0.0, 0.0]
    }
}

fn anchor_of(spec: &FrameSpec, frame: u8) -> [f64; 2] {
    match frame {
        1 => spec.anchors[0],
        2 => spec.anchors[1],
        _ => [0.0, 0.0],
    }
}

/// Chart-local (x, z) of a global position in `frame`.
pub fn chart_of(spec: &FrameSpec, frame: u8, g: [f64; 2]) -> [f64; 2] {
    let a = anchor_of(spec, frame);
    [g[0] - a[0], g[1] - a[1]]
}

pub fn global_of(spec: &FrameSpec, frame: u8, c: [f64; 2]) -> [f64; 2] {
    let a = anchor_of(spec, frame);
    [c[0] + a[0], c[1] + a[1]]
}

/// (lat, lon) of a chart point in that frame's own equirect chart.
pub fn lat_lon(spec: &FrameSpec, frame: u8, c: [f64; 2]) -> (f64, f64) {
    let centre = centre_of(spec, frame);
    ((centre[1] - c[1]) / spec.radius, (c[0] - centre[0]) / spec.radius)
}

fn chart_at(spec: &FrameSpec, frame: u8, lat: f64, lon: f64) -> [f64; 2] {
    let centre = centre_of(spec, frame);
    [centre[0] + spec.radius * lon, centre[1] - spec.radius * lat]
}

/// Unit body direction of a frame-chart latitude/longitude.
pub fn body_dir(frame: u8, lat: f64, lon: f64) -> [f64; 3] {
    let c = lat.cos();
    to_body(frame, [c * lon.cos(), lat.sin(), c * lon.sin()])
}

/// East and south unit tangents of a chart point, as body vectors.
fn tangents(frame: u8, lat: f64, lon: f64) -> ([f64; 3], [f64; 3]) {
    let (sl, cl, sp, cp) = (lon.sin(), lon.cos(), lat.sin(), lat.cos());
    (
        to_body(frame, [-sl, 0.0, cl]),
        to_body(frame, [sp * cl, -cp, sp * sl]),
    )
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Frame selection with hysteresis: E hands over at |lat| >= handoff, a pole frame returns only below handoff - hysteresis.
pub fn frame_for(spec: &FrameSpec, d: [f64; 3], current: u8) -> u8 {
    let lat = d[1].clamp(-1.0, 1.0).asin();
    if current == FRAME_E {
        return if lat.abs() >= spec.handoff {
            if lat > 0.0 { 1 } else { 2 }
        } else {
            FRAME_E
        };
    }
    if lat.abs() < spec.handoff - spec.hysteresis {
        FRAME_E
    } else {
        current
    }
}

/// Smooth east-west chart-displacement multiplier: 1 up to `ramp_start`, 1/cos(handoff) at the hand-off (true E-W speed there).
pub fn ramp_factor(spec: &FrameSpec, z: f64) -> f64 {
    let lat = ((spec.centre[1] - z) / spec.radius).abs();
    if lat <= spec.ramp_start {
        return 1.0;
    }
    let t = ((lat - spec.ramp_start) / (spec.handoff - spec.ramp_start)).clamp(0.0, 1.0);
    let s = t * t * (3.0 - 2.0 * t);
    1.0 + (1.0 / spec.handoff.cos() - 1.0) * s
}

/// The same point, heading and true velocity re-expressed in another frame.
pub struct Hopped {
    pub global: [f64; 2],
    pub yaw: f32,
    pub velocity: [f32; 2],
}

pub fn hop_pose(spec: &FrameSpec, from: u8, to: u8, g: [f64; 2], yaw: f32, velocity: [f32; 2]) -> Hopped {
    let (lat, lon) = lat_lon(spec, from, chart_of(spec, from, g));
    let d = body_dir(from, lat, lon);
    let (east, south) = tangents(from, lat, lon);
    let (hx, hz) = (-f64::from(yaw).sin(), -f64::from(yaw).cos());
    let along = |x: f64, z: f64| {
        [0, 1, 2].map(|i| east[i] * x + south[i] * z)
    };
    let (heading, v) = (
        along(hx, hz),
        along(f64::from(velocity[0]), f64::from(velocity[1])),
    );
    let df = to_frame(to, d);
    let lat2 = df[1].clamp(-1.0, 1.0).asin();
    let lon2 = df[2].atan2(df[0]);
    let (east2, south2) = tangents(to, lat2, lon2);
    Hopped {
        global: global_of(spec, to, chart_at(spec, to, lat2, lon2)),
        yaw: (-dot(heading, east2)).atan2(-dot(heading, south2)) as f32,
        velocity: [dot(v, east2) as f32, dot(v, south2) as f32],
    }
}

impl Voyage {
    /// Fold an E position into the canonical longitude range; positions inside a pole region are left alone.
    pub(crate) fn canon(&self, p: [f64; 2]) -> [f64; 2] {
        let Some(spec) = self.manifest.frames.as_ref() else {
            return p;
        };
        if spec.wrap <= 0.0
            || self.manifest.regions[self.manifest.base_regions()..]
                .iter()
                .any(|r| contains(r.bounds(), p))
        {
            return p;
        }
        let k = ((p[0] - spec.centre[0] + spec.wrap / 2.0) / spec.wrap).floor();
        if k == 0.0 {
            p
        } else {
            [p[0] - k * spec.wrap, p[1]]
        }
    }

    /// East-west chart displacement multiplier at global z (1 outside the ramp zone and in pole frames).
    pub(crate) fn ramp(&self, z: f64) -> f64 {
        match self.manifest.frames.as_ref() {
            Some(spec) if self.frame == FRAME_E => ramp_factor(spec, z),
            _ => 1.0,
        }
    }

    /// Keep the E origin within one circumference by re-seating it; global motion stays continuous modulo the period.
    pub(crate) fn wrap_longitude(&mut self) {
        let Some(spec) = self.manifest.frames else {
            return;
        };
        if self.frame != FRAME_E || spec.wrap <= 0.0 {
            return;
        }
        let x = self.global()[0] - spec.centre[0];
        if x >= spec.wrap / 2.0 {
            self.origin[0] -= spec.wrap;
            self.wraps -= 1;
        } else if x < -spec.wrap / 2.0 {
            self.origin[0] += spec.wrap;
            self.wraps += 1;
        }
    }

    /// Atomically hop to the other chart once the pod crosses the hand-off circle, but only onto resident terrain.
    pub(crate) fn maybe_hop(&mut self) {
        let Some(spec) = self.manifest.frames else {
            return;
        };
        let (lat, lon) = lat_lon(&spec, self.frame, chart_of(&spec, self.frame, self.global()));
        let to = frame_for(&spec, body_dir(self.frame, lat, lon), self.frame);
        if to == self.frame {
            return;
        }
        let s = self.state;
        let hop = hop_pose(
            &spec,
            self.frame,
            to,
            self.global(),
            s.yaw,
            [s.velocity[0], s.velocity[2]],
        );
        if self
            .heights_at(hop.global, hop.yaw, s.position[1])
            .is_err()
        {
            return;
        }
        self.origin = [hop.global[0].round(), hop.global[1].round()];
        self.state.position[0] = (hop.global[0] - self.origin[0]) as f32;
        self.state.position[2] = (hop.global[1] - self.origin[1]) as f32;
        self.state.yaw = hop.yaw;
        self.state.velocity[0] = hop.velocity[0];
        self.state.velocity[2] = hop.velocity[1];
        self.frame = to;
        self.hops += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voyage::{HorizonEntry, Manifest, Region, TileEntry, TILE};
    use crate::world::{add_poles, tests::flat_tile, PoleSpec};
    use flats_racer_physics::Input;

    const WRAP: f64 = 60.0 * TILE;
    const R: f64 = WRAP / (2.0 * std::f64::consts::PI);

    fn spec() -> PoleSpec {
        PoleSpec {
            radius: R,
            centre: [0.0, 0.0],
            handoff: 80f64.to_radians(),
            hysteresis: 0.05,
            ramp_start: 1.0,
            wrap: WRAP,
            tiles: [4, 4],
        }
    }

    fn moon() -> Manifest {
        let tiles = (0..30)
            .flat_map(|y| (0..60).map(move |x| (x, y)))
            .map(|(x, y)| TileEntry {
                region: 0,
                x,
                y,
                file: format!("Elune_{x}_{y}.adt"),
                bytes: 0,
                sha256: String::new(),
            })
            .collect();
        Manifest {
            version: 4,
            label: "Elune".into(),
            regions: vec![Region {
                id: "elune".into(),
                map: "Elune".into(),
                tile_origin: [0, 0],
                tile_count: [60, 30],
                placement: [-30.0 * TILE, -15.0 * TILE],
                frame: 0,
            }],
            tiles,
            horizons: vec![HorizonEntry {
                region: 0,
                file: "Elune.wdl".into(),
                bytes: 1,
                sha256: "0".repeat(64),
                source_bounds: [0, 0, 60, 30],
            }],
            world_bounds: None,
            ocean: [1.0e9, 1.0e9, 1.0e9 + 1.0, 1.0e9 + 1.0],
            sea_level: -1.0e6,
            spawn: [0.0, 0.0, 0.0, 0.0],
            destination: [0.0, 0.0],
            frames: None,
        }
    }

    fn world() -> Voyage {
        let mut w = Voyage::from_manifest(add_poles(moon(), &spec()).unwrap()).unwrap();
        w.hold = 0;
        for (i, t) in w.manifest.tiles.clone().iter().enumerate() {
            if t.region != 0 {
                w.resident.insert(i, flat_tile(t.x, t.y));
            }
        }
        w
    }

    fn east_tile(w: &mut Voyage, p: [f64; 2]) {
        let i = w.locate(p).unwrap();
        let t = w.manifest.tiles[i].clone();
        w.resident.insert(i, flat_tile(t.x, t.y));
    }

    fn wrapped(a: f32) -> f32 {
        a.sin().atan2(a.cos())
    }

    #[test]
    fn frames_are_opt_in_and_validated() {
        let m = moon();
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("frames") && !json.contains("\"frame\""));
        assert!(serde_json::from_str::<Manifest>(&json).is_ok());
        let p = add_poles(m.clone(), &spec()).unwrap();
        assert_eq!((p.regions.len(), p.tiles.len()), (3, 1800 + 32));
        assert!(serde_json::from_str::<Manifest>(&serde_json::to_string(&p).unwrap()).is_ok());
        assert!(add_poles(p, &spec()).is_err());
        for bad in [
            PoleSpec { tiles: [3, 4], ..spec() },
            PoleSpec { handoff: 1.6, ..spec() },
            PoleSpec { hysteresis: 0.0, ..spec() },
            PoleSpec { ramp_start: 1.5, ..spec() },
        ] {
            assert!(add_poles(m.clone(), &bad).is_err());
        }
        let mut v1 = m;
        v1.version = 1;
        assert!(add_poles(v1, &spec()).is_err());
    }

    #[test]
    fn ramp_is_untouched_below_start_and_true_speed_at_handoff() {
        let f = world().manifest.frames.unwrap();
        for lat in [0.0, 0.3, 1.0] {
            assert_eq!(ramp_factor(&f, -lat * R), 1.0);
            assert_eq!(ramp_factor(&f, lat * R), 1.0);
        }
        let mut last = 1.0;
        for i in 0..=40 {
            let m = ramp_factor(&f, -(1.0 + (f.handoff - 1.0) * f64::from(i) / 40.0) * R);
            assert!(m >= last);
            last = m;
        }
        assert!((last - 1.0 / f.handoff.cos()).abs() < 1e-9);
    }

    #[test]
    fn hysteresis_prevents_ping_pong() {
        let f = world().manifest.frames.unwrap();
        let at = |lat: f64| body_dir(FRAME_E, lat, 0.3);
        assert_eq!(frame_for(&f, at(f.handoff - 0.001), 0), 0);
        assert_eq!(frame_for(&f, at(f.handoff + 1e-6), 0), 1);
        assert_eq!(frame_for(&f, at(-f.handoff - 1e-6), 0), 2);
        assert_eq!(frame_for(&f, at(f.handoff - 0.01), 1), 1);
        assert_eq!(frame_for(&f, at(f.handoff - f.hysteresis - 0.01), 1), 0);
    }

    #[test]
    fn hop_round_trips_position_heading_and_true_speed() {
        let f = world().manifest.frames.unwrap();
        for (lat, lon) in [(1.40, 0.2), (-1.40, -2.5), (1.45, 3.0)] {
            for yaw in [0.0f32, 0.7, -2.0, 3.0] {
                let g = chart_at(&f, FRAME_E, lat, lon);
                let to = if lat > 0.0 { 1 } else { 2 };
                let v = [30.0, -40.0];
                let there = hop_pose(&f, FRAME_E, to, g, yaw, v);
                let speed = f64::from(there.velocity[0]).hypot(f64::from(there.velocity[1]));
                assert!((speed - 50.0).abs() < 1e-3, "{speed}");
                let back = hop_pose(&f, to, FRAME_E, there.global, there.yaw, there.velocity);
                assert!((back.global[0] - g[0]).abs() < 1e-3 && (back.global[1] - g[1]).abs() < 1e-3);
                assert!(wrapped(back.yaw - yaw).abs() < 1e-4);
                assert!((back.velocity[0] - v[0] as f32).abs() < 1e-3);
                assert!((back.velocity[1] - v[1] as f32).abs() < 1e-3);
            }
        }
    }

    #[test]
    fn longitude_wraps_in_lookup_and_shifts_the_origin() {
        let mut w = world();
        for z in [-3000.0, 0.0, 2000.0] {
            let a = w.locate([WRAP / 2.0 + 100.0, z]);
            assert!(a.is_some());
            assert_eq!(a, w.locate([-WRAP / 2.0 + 100.0, z]));
            assert_eq!(w.locate([-WRAP / 2.0 - 100.0, z]), w.locate([WRAP / 2.0 - 100.0, z]));
        }
        w.origin = [WRAP / 2.0 - 10.0, 0.0];
        w.state.position = [20.0, 1.1, 0.0];
        let before = w.global()[0];
        w.wrap_longitude();
        assert_eq!((w.wraps, w.origin[0]), (-1, WRAP / 2.0 - 10.0 - WRAP));
        assert!((w.global()[0] - (before - WRAP)).abs() < 1e-9);
        w.wrap_longitude();
        assert_eq!(w.wraps, -1);
    }

    #[test]
    fn crossing_the_handoff_hops_atomically_onto_resident_terrain() {
        let mut w = world();
        let handoff_z = -R * w.manifest.frames.unwrap().handoff;
        let start = [266.0, handoff_z + 0.01];
        east_tile(&mut w, start);
        w.origin = [start[0].round(), start[1].round()];
        w.state.position = [(start[0] - w.origin[0]) as f32, 1.1, (start[1] - w.origin[1]) as f32];
        w.state.velocity = [0.0, 0.0, -100.0];
        w.advance(Input::default()).unwrap();
        assert_eq!((w.frame, w.hops, w.hold), (1, 1, 0));
        let chart = chart_of(&w.manifest.frames.unwrap(), 1, w.global());
        let toward_pole = -(chart[0] * f64::from(w.state.velocity[0]) + chart[1] * f64::from(w.state.velocity[2]));
        assert!(toward_pole > 0.0);
        assert!(chart[0].hypot(chart[1]) < 1.0e3);
        let t = w.frame_state();
        assert_eq!((t[0], t[2]), (1.0, 1.0));
        assert!((t[3] - chart[0]).abs() < 1e-6 && (t[4] - chart[1]).abs() < 1e-6);
    }

    #[test]
    fn hop_never_lands_on_unloaded_terrain() {
        let mut w = world();
        let tiles = w.manifest.tiles.clone();
        w.resident.retain(|&i, _| tiles[i].region == 0);
        let handoff_z = -R * w.manifest.frames.unwrap().handoff;
        let start = [266.0, handoff_z + 0.01];
        east_tile(&mut w, start);
        w.origin = [start[0].round(), start[1].round()];
        w.state.position = [(start[0] - w.origin[0]) as f32, 1.1, (start[1] - w.origin[1]) as f32];
        w.state.velocity = [0.0, 0.0, -100.0];
        w.advance(Input::default()).unwrap();
        assert_eq!((w.frame, w.hops, w.hold), (0, 0, 0));
    }

    #[test]
    fn failed_substep_after_a_hop_rolls_the_frame_back() {
        let mut w = world();
        let f = w.manifest.frames.unwrap();
        let start = [0.0, -R * f.handoff + 0.01];
        east_tile(&mut w, start);
        east_tile(&mut w, [-10.0, start[1]]);
        w.origin = [start[0].round(), start[1].round()];
        w.state.position = [(start[0] - w.origin[0]) as f32, 1.1, (start[1] - w.origin[1]) as f32];
        w.state.velocity = [0.0, 0.0, -500.0];
        w.tuning.max_speed = 500.0;
        w.tuning.boost_max_speed = 500.0;
        // On the lon=0 meridian the hop lands on the N chart's -z axis heading +z; put a thin wall just ahead of it.
        let wall_z = f.anchors[0][1] - R * (std::f64::consts::FRAC_PI_2 - f.handoff) + 3.0;
        w.scene_bounds = vec![[-3000.0, -100.0, wall_z, 3000.0, 100.0, wall_z + 0.1]];
        let (position, origin, rebases) = (w.state.position, w.origin, w.rebases);
        w.advance(Input { throttle: 1.0, ..Default::default() }).unwrap();
        assert_eq!(w.hold, 3);
        assert_eq!((w.frame, w.wraps, w.hops, w.rebases), (0, 0, 0, rebases));
        assert_eq!((w.state.position, w.origin), (position, origin));
        assert_eq!(w.state.velocity, [0.0; 3]);
    }

    #[test]
    fn pose_frame_is_optional_and_validated() {
        let mut w = world();
        w.restore_pose(&[0.0, 1.5, 0.0, 0.0, 1.0]).unwrap();
        assert_eq!(w.frame, 1);
        assert_eq!(w.global(), [0.0, -200_000.0]);
        w.restore_pose(&[0.0, 1.5, 0.0, 0.0, 2.0]).unwrap();
        assert_eq!((w.frame, w.global()), (2, [0.0, 200_000.0]));
        east_tile(&mut w, [266.0, 266.0]);
        w.restore_pose(&[266.0, 1.5, 266.0, 0.0]).unwrap();
        assert_eq!((w.frame, w.global()), (0, [266.0, 266.0]));
        assert!(w.restore_pose(&[0.0, 1.5, 0.0, 0.0, 3.0]).is_err());
        assert!(w.restore_pose(&[0.0, 1.5, 0.0, 0.0, 0.5]).is_err());
        assert!(w.restore_pose(&[0.0, 1.5, 0.0]).is_err());
        let mut plain = Voyage::from_manifest(moon()).unwrap();
        assert!(plain.restore_pose(&[0.0, 1.5, 0.0, 0.0, 1.0]).is_err());
        assert_eq!(plain.telemetry().len(), 18);
        assert_eq!(plain.frame_state(), vec![0.0, 0.0, 0.0, plain.global()[0], plain.global()[1]]);
    }
}
