//! Pure fixed-wing dynamics for the browser plane vehicle (yards and seconds, like the hover racer).
//!
//! Same contract as the racer: `step` updates attitude, speed and boost and returns the intended world
//! velocity but never moves the position; the caller sweeps that velocity through collision geometry,
//! writes the resolved position back, then calls `settle` with the support height under the plane.
//! Yaw zero faces -Z and positive yaw turns left; pitch up is positive; roll right is positive.
//! Boost fractions reuse the racer's constants and the speed numbers mirror its browser defaults.

use crate::{StepError, BOOST_DRAIN_PER_SEC, BOOST_RECHARGE_PER_SEC};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaneTuning {
    pub cruise: f32,
    pub boost_speed: f32,
    pub thrust: f32,
    pub boost_thrust: f32,
    pub drag: f32,
    pub brake: f32,
    /// Below this speed lift fades quadratically: the nose and the craft sink.
    pub stall: f32,
    pub max_roll: f32,
    pub roll_rate: f32,
    pub max_pitch: f32,
    pub pitch_rate: f32,
    /// Self-levelling rate of the nose while no pitch input is held.
    pub level_rate: f32,
    pub gravity: f32,
    /// Hover distance kept above the support surface (no-crash skim policy).
    pub clearance: f32,
}

impl Default for PlaneTuning {
    fn default() -> Self {
        Self {
            cruise: 150.0,
            boost_speed: 1000.0,
            thrust: 50.0,
            boost_thrust: 250.0,
            drag: 0.35,
            brake: 60.0,
            stall: 45.0,
            max_roll: 1.05,
            roll_rate: 2.6,
            max_pitch: 0.95,
            pitch_rate: 1.1,
            level_rate: 0.6,
            gravity: 30.0,
            clearance: 3.0,
        }
    }
}

impl PlaneTuning {
    pub fn validate(&self) -> Result<(), StepError> {
        let all = [
            self.cruise, self.boost_speed, self.thrust, self.boost_thrust, self.drag, self.brake,
            self.stall, self.max_roll, self.roll_rate, self.max_pitch, self.pitch_rate,
            self.level_rate, self.gravity, self.clearance,
        ];
        if all.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return Err(StepError::InvalidTuning("plane tuning must be finite and nonnegative"));
        }
        if self.stall <= 0.0 || self.cruise <= 0.0 || self.boost_speed < self.cruise {
            return Err(StepError::InvalidTuning("plane stall/cruise must be positive and boost >= cruise"));
        }
        if self.max_roll >= std::f32::consts::FRAC_PI_2 || self.max_pitch >= std::f32::consts::FRAC_PI_2 {
            return Err(StepError::InvalidTuning("plane roll and pitch limits must be below 90 degrees"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlaneInput {
    /// [-1, 1]; negative brakes.
    pub throttle: f32,
    /// [-1, 1]; positive banks right.
    pub roll: f32,
    /// [-1, 1]; positive pulls the nose up.
    pub pitch: f32,
    pub boost: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaneState {
    pub position: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
    pub speed: f32,
    /// Downward speed from lost lift.
    pub sink: f32,
    pub boost_reserve: f32,
}

fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    v.max(lo).min(hi)
}

impl PlaneState {
    pub fn new(position: [f32; 3], yaw: f32, speed: f32) -> Result<Self, StepError> {
        if position.iter().chain([&yaw, &speed]).any(|v| !v.is_finite()) || speed < 0.0 {
            return Err(StepError::InvalidState);
        }
        Ok(Self { position, yaw, pitch: 0.0, roll: 0.0, speed, sink: 0.0, boost_reserve: 1.0 })
    }

    pub fn forward(&self) -> [f32; 3] {
        let c = self.pitch.cos();
        [-self.yaw.sin() * c, self.pitch.sin(), -self.yaw.cos() * c]
    }

    /// Returns the intended world velocity; state is unchanged on error.
    pub fn step(&mut self, input: PlaneInput, dt: f32, t: &PlaneTuning) -> Result<[f32; 3], StepError> {
        if !dt.is_finite() || dt <= 0.0 || dt > 1.0 / 30.0 {
            return Err(StepError::InvalidDt);
        }
        if ![input.throttle, input.roll, input.pitch].iter().all(|v| v.is_finite()) {
            return Err(StepError::InvalidInput);
        }
        let (throttle, roll_in, pitch_in) = (
            clamp(input.throttle, -1.0, 1.0),
            clamp(input.roll, -1.0, 1.0),
            clamp(input.pitch, -1.0, 1.0),
        );
        let mut s = *self;
        let boosting = input.boost && s.boost_reserve > 0.0 && throttle >= 0.0;
        let drain = if boosting { -BOOST_DRAIN_PER_SEC } else { BOOST_RECHARGE_PER_SEC };
        s.boost_reserve = clamp(s.boost_reserve + drain * dt, 0.0, 1.0);
        s.roll += clamp(roll_in * t.max_roll - s.roll, -t.roll_rate * dt, t.roll_rate * dt);
        let flying = (s.speed / t.stall).powi(2).min(1.0);
        let level = if pitch_in == 0.0 { -s.pitch * t.level_rate * flying } else { 0.0 };
        s.pitch = clamp(s.pitch + (pitch_in * t.pitch_rate + level - (1.0 - flying) * 0.8) * dt, -t.max_pitch, t.max_pitch);
        // Coordinated turn: heading rate from bank, slower at speed so a 1000 yd/s boost stays controllable.
        s.yaw -= s.roll.tan() * t.gravity / s.speed.max(t.stall) * dt * flying;
        let limit = if boosting { t.boost_speed } else { t.cruise };
        let thrust = if boosting { t.boost_thrust } else { t.thrust * throttle.max(0.0) };
        let accel = if s.speed < limit { thrust } else { 0.0 }
            - if throttle < 0.0 { t.brake } else { 0.0 }
            - s.pitch.sin() * t.gravity
            - t.drag * (s.speed - limit).max(0.0)
            - t.drag * 0.1 * s.speed;
        s.speed = clamp(s.speed + accel * dt, 0.0, t.boost_speed);
        s.sink = (s.sink + (1.0 - flying) * t.gravity * dt) * (-4.0 * flying * dt).exp();
        let f = s.forward();
        let velocity = [f[0] * s.speed, f[1] * s.speed - s.sink, f[2] * s.speed];
        if !velocity.iter().chain([&s.yaw, &s.pitch, &s.roll]).all(|v| v.is_finite()) {
            return Err(StepError::NonFiniteResult);
        }
        *self = s;
        Ok(velocity)
    }

    /// Keeps the plane `clearance` above the support height and reports whether it was scraping.
    pub fn settle(&mut self, support: Option<f32>, t: &PlaneTuning, dt: f32) -> bool {
        let Some(floor) = support.map(|h| h + t.clearance) else { return false };
        if self.position[1] >= floor {
            return false;
        }
        self.position[1] = floor;
        self.pitch = self.pitch.max(0.0);
        self.sink = 0.0;
        self.speed = (self.speed - t.brake * dt).max(0.0);
        true
    }

    /// Scenery strike: the caller keeps the pre-sweep position; the plane bleeds speed and noses up
    /// instead of crashing.
    pub fn collide(&mut self) {
        self.speed *= 0.4;
        self.sink = 0.0;
        self.pitch = self.pitch.max(0.15);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FIXED_DT;

    fn fly(p: &mut PlaneState, input: PlaneInput, seconds: f32, ground: Option<f32>) -> u32 {
        let t = PlaneTuning::default();
        let mut contacts = 0;
        for _ in 0..(seconds / FIXED_DT) as u32 {
            let v = p.step(input, FIXED_DT, &t).unwrap();
            for i in 0..3 {
                p.position[i] += v[i] * FIXED_DT;
            }
            contacts += u32::from(p.settle(ground, &t, FIXED_DT));
        }
        contacts
    }
    const CRUISE: PlaneInput = PlaneInput { throttle: 1.0, roll: 0.0, pitch: 0.0, boost: false };

    #[test]
    fn forward_faces_minus_z_and_climbs_with_pitch() {
        let mut p = PlaneState::new([0.0; 3], 0.0, 100.0).unwrap();
        let f = p.forward();
        assert!(f[0].abs() < 1e-6 && f[1] == 0.0 && f[2] == -1.0);
        p.pitch = 0.5;
        assert!(p.forward()[1] > 0.0);
    }

    #[test]
    fn cruise_holds_altitude_and_speed() {
        let mut p = PlaneState::new([0.0, 500.0, 0.0], 0.0, 90.0).unwrap();
        fly(&mut p, CRUISE, 10.0, None);
        assert!((p.speed - 150.0).abs() < 8.0, "{}", p.speed);
        assert!((p.position[1] - 500.0).abs() < 1.0);
    }

    #[test]
    fn bank_turns_in_the_bank_direction() {
        let mut p = PlaneState::new([0.0, 500.0, 0.0], 0.0, 150.0).unwrap();
        fly(&mut p, PlaneInput { roll: 1.0, ..CRUISE }, 4.0, None);
        assert!(p.yaw < 0.0 && p.position[0] > 10.0, "right bank must turn right: yaw {} x {}", p.yaw, p.position[0]);
        let mut l = PlaneState::new([0.0, 500.0, 0.0], 0.0, 150.0).unwrap();
        fly(&mut l, PlaneInput { roll: -1.0, ..CRUISE }, 4.0, None);
        assert!(l.yaw > 0.0 && l.position[0] < -10.0);
    }

    #[test]
    fn stalled_plane_sinks_and_drops_its_nose() {
        let mut p = PlaneState::new([0.0, 500.0, 0.0], 0.0, 5.0).unwrap();
        fly(&mut p, PlaneInput { throttle: 0.0, ..CRUISE }, 3.0, None);
        assert!(p.position[1] < 450.0 && p.pitch < 0.0, "{} {}", p.position[1], p.pitch);
    }

    #[test]
    fn boost_exceeds_cruise_drains_and_caps() {
        let boost = PlaneInput { boost: true, ..CRUISE };
        let mut p = PlaneState::new([0.0, 9000.0, 0.0], 0.0, 150.0).unwrap();
        fly(&mut p, boost, 3.0, None);
        assert!(p.speed > 225.0 && p.boost_reserve < 1.0, "{} {}", p.speed, p.boost_reserve);
        fly(&mut p, boost, 30.0, None);
        assert!(p.speed <= 1000.0 && p.boost_reserve < 0.01);
        fly(&mut p, CRUISE, 30.0, None);
        assert!((p.speed - 150.0).abs() < 10.0, "drag pulls speed back to cruise: {}", p.speed);
    }

    #[test]
    fn braking_cancels_boost_and_slows() {
        let mut p = PlaneState::new([0.0, 9000.0, 0.0], 0.0, 150.0).unwrap();
        fly(&mut p, PlaneInput { throttle: -1.0, boost: true, ..CRUISE }, 2.0, None);
        assert!(p.speed < 100.0 && p.boost_reserve > 0.99);
    }

    #[test]
    fn ground_is_never_penetrated_and_scrape_reports_contact() {
        let mut p = PlaneState::new([0.0, 10.0, 0.0], 0.0, 150.0).unwrap();
        p.pitch = -0.5;
        let contacts = fly(&mut p, PlaneInput { pitch: -1.0, ..CRUISE }, 2.0, Some(0.0));
        assert!(contacts > 0 && p.position[1] >= 3.0 - 1e-4 && p.pitch >= 0.0);
    }

    #[test]
    fn scenery_strike_bleeds_speed_and_noses_up() {
        let mut p = PlaneState::new([0.0, 100.0, 0.0], 0.0, 200.0).unwrap();
        p.collide();
        assert!(p.speed == 80.0 && p.pitch >= 0.15);
    }

    #[test]
    fn invalid_input_and_tuning_are_rejected_atomically() {
        let t = PlaneTuning::default();
        let mut p = PlaneState::new([0.0, 100.0, 0.0], 0.0, 100.0).unwrap();
        let before = p;
        assert_eq!(p.step(PlaneInput { throttle: f32::NAN, ..CRUISE }, FIXED_DT, &t), Err(StepError::InvalidInput));
        assert_eq!(p.step(CRUISE, 0.0, &t), Err(StepError::InvalidDt));
        assert_eq!(p, before);
        assert!(PlaneTuning { stall: 0.0, ..t }.validate().is_err());
        assert!(t.validate().is_ok());
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut p = PlaneState::new([1.0, 300.0, 2.0], 0.3, 120.0).unwrap();
            fly(&mut p, PlaneInput { roll: 0.5, pitch: 0.2, ..CRUISE }, 5.0, None);
            p
        };
        assert_eq!(run(), run());
    }
}
