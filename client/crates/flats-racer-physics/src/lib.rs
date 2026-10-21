//! Pure Y-up hover-racer dynamics; collision detection and position integration belong to the caller.
//!
//! Deviation: this opt-in fork uses custom spring-supported racer physics, not stock 1.12 walking.
//! Call `step` at a fixed timestep, sweep its intended velocity through collision geometry, then
//! write the resolved position and velocity back. No step advances position or queries geometry.

use std::{error::Error, fmt};

pub mod plane;

pub const FIXED_DT: f32 = 1.0 / 120.0;
/// Boost reserve fraction per second: 7.5 s of full boost, 10 s to recharge from empty.
pub const BOOST_DRAIN_PER_SEC: f32 = 0.4 / 3.0;
pub const BOOST_RECHARGE_PER_SEC: f32 = 0.1;
/// Equilibrium distance in world units from body center to a level support surface.
pub const HOVER_HEIGHT: f32 = 1.1;
/// Downward probe length measured from body center, not from the bottom of the collision shape.
pub const SUPPORT_REACH: f32 = 1.9;
/// Local X/Y/Z probe origins relative to body center; rotate X/Z by yaw before casting downward.
/// The resolver must reject walls/ceilings and return only upward-facing support hits.
pub const PROBE_OFFSETS: [[f32; 3]; 4] = [
    [-0.65, 0.0, -0.85],
    [0.65, 0.0, -0.85],
    [-0.65, 0.0, 0.85],
    [0.65, 0.0, 0.85],
];
pub const MAX_SPEED: f32 = 36.0;
pub const BOOST_MAX_SPEED: f32 = 50.0;
pub const GRAVITY: f32 = 24.0;

/// Runtime dynamics without gameplay range limits.
///
/// Values must be finite. Speed caps, hover height and gravity must be positive; all other
/// parameters may be zero but not negative. Boost speed must be at least normal speed.
/// Boost consumption/recharge and hop-control timers stay fixed. Extreme configurations can
/// produce an unrepresentable state; steps then return `NonFiniteResult` atomically.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tuning {
    pub max_speed: f32,
    pub boost_max_speed: f32,
    pub acceleration: f32,
    /// Additional acceleration supplied by a full boost fraction.
    pub boost_acceleration: f32,
    pub braking: f32,
    pub drag: f32,
    pub turn_rate: f32,
    pub turn_response: f32,
    pub grip: f32,
    pub drift_grip: f32,
    pub drift_turn_multiplier: f32,
    pub hover_height: f32,
    pub spring: f32,
    pub damping: f32,
    pub gravity: f32,
    pub hop_speed: f32,
    /// Multiplier for airborne horizontal thrust, braking, grip and steering.
    pub air_control: f32,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            max_speed: MAX_SPEED,
            boost_max_speed: BOOST_MAX_SPEED,
            acceleration: 18.0,
            boost_acceleration: 22.0,
            braking: 30.0,
            drag: 0.25,
            turn_rate: 2.2,
            turn_response: 10.0,
            grip: 8.0,
            drift_grip: 1.5,
            drift_turn_multiplier: 1.3,
            hover_height: HOVER_HEIGHT,
            spring: 90.0,
            damping: 18.0,
            gravity: GRAVITY,
            hop_speed: 7.0,
            air_control: 0.9,
        }
    }
}

impl Tuning {
    /// Probe distance for this hover height. Callers must use this when casting support rays.
    /// For valid tuning the result is finite, including at `f32::MAX`.
    pub fn support_reach(&self) -> f32 {
        (self.hover_height + 0.8).max(SUPPORT_REACH)
    }

    /// Rejects the entire configuration, reporting the first invalid field and its domain.
    pub fn validate(&self) -> Result<(), StepError> {
        let positive = [
            (self.max_speed, "max_speed must be finite and > 0"),
            (
                self.boost_max_speed,
                "boost_max_speed must be finite and > 0",
            ),
            (self.hover_height, "hover_height must be finite and > 0"),
            (self.gravity, "gravity must be finite and > 0"),
        ];
        let nonnegative = [
            (self.acceleration, "acceleration must be finite and >= 0"),
            (
                self.boost_acceleration,
                "boost_acceleration must be finite and >= 0",
            ),
            (self.braking, "braking must be finite and >= 0"),
            (self.drag, "drag must be finite and >= 0"),
            (self.turn_rate, "turn_rate must be finite and >= 0"),
            (self.turn_response, "turn_response must be finite and >= 0"),
            (self.grip, "grip must be finite and >= 0"),
            (self.drift_grip, "drift_grip must be finite and >= 0"),
            (
                self.drift_turn_multiplier,
                "drift_turn_multiplier must be finite and >= 0",
            ),
            (self.spring, "spring must be finite and >= 0"),
            (self.damping, "damping must be finite and >= 0"),
            (self.hop_speed, "hop_speed must be finite and >= 0"),
            (self.air_control, "air_control must be finite and >= 0"),
        ];
        for (value, message) in positive {
            if !value.is_finite() || value <= 0.0 {
                return Err(StepError::InvalidTuning(message));
            }
        }
        for (value, message) in nonnegative {
            if !value.is_finite() || value < 0.0 {
                return Err(StepError::InvalidTuning(message));
            }
        }
        if self.boost_max_speed < self.max_speed {
            return Err(StepError::InvalidTuning(
                "boost_max_speed must be >= max_speed",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    /// Finite values are clamped to [-1, 1]; negative throttle supplies reverse thrust.
    pub throttle: f32,
    /// Positive is left, negative is right; finite values are clamped to [-1, 1].
    pub steer: f32,
    pub brake: bool,
    pub boost: bool,
    pub drift: bool,
    /// A rising edge while supported hops once; holding never retriggers on landing.
    pub jump: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct State {
    pub position: [f32; 3],
    pub velocity: [f32; 3],
    /// Radians about +Y; yaw zero faces -Z, positive yaw turns left.
    pub yaw: f32,
    pub yaw_rate: f32,
    /// Cosmetic roll in radians, bounded to +/-0.35; never affects support or thrust.
    pub bank: f32,
    pub grounded: bool,
    pub jump_cooldown: f32,
    /// Fraction in [0, 1], consumed by forward boost with nonzero control authority.
    pub boost_reserve: f32,
    jump_held: bool,
    support_lockout: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepError {
    InvalidDt,
    InvalidInput,
    InvalidState,
    InvalidSupport(usize),
    InvalidTuning(&'static str),
    NonFiniteResult,
}

impl fmt::Display for StepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDt => f.write_str("dt must be finite and in (0, 1/30] seconds"),
            Self::InvalidInput => {
                f.write_str("throttle, steer and terrain rise rate must be finite")
            }
            Self::InvalidState => f.write_str("state must be finite with valid reserve and timers"),
            Self::InvalidTuning(message) => f.write_str(message),
            Self::InvalidSupport(index) => {
                write!(f, "support {index} must be finite and nonnegative")
            }
            Self::NonFiniteResult => f.write_str("numerical step produced a nonfinite result"),
        }
    }
}

impl Error for StepError {}

impl State {
    pub fn new(position: [f32; 3], yaw: f32) -> Result<Self, StepError> {
        if position.iter().any(|v| !v.is_finite()) || !yaw.is_finite() {
            return Err(StepError::InvalidState);
        }
        Ok(Self {
            position,
            velocity: [0.0; 3],
            yaw: wrap_yaw(yaw),
            yaw_rate: 0.0,
            bank: 0.0,
            grounded: false,
            jump_cooldown: 0.0,
            boost_reserve: 1.0,
            jump_held: false,
            support_lockout: 0.0,
        })
    }

    /// Atomically clears momentum, jump latch, all timers, bank and reserve depletion.
    pub fn reset(&mut self, position: [f32; 3], yaw: f32) -> Result<(), StepError> {
        *self = Self::new(position, yaw)?;
        Ok(())
    }

    /// Returns intended world velocity, updating velocity/orientation/timers but never position.
    ///
    /// Use four center-relative distances (see `PROBE_OFFSETS`), or `None` for no support.
    /// Hits beyond `SUPPORT_REACH` are valid but ignored. Invalid arguments/state return an
    /// explicit error without changing any state. Run at `FIXED_DT`, not variable render dt.
    pub fn step(
        &mut self,
        input: Input,
        supports: [Option<f32>; 4],
        dt: f32,
    ) -> Result<[f32; 3], StepError> {
        self.step_with_tuning(input, supports, dt, &Tuning::default())
    }

    /// Like `step`, with caller-selected dynamics and `tuning.support_reach()`.
    /// Invalid tuning or an unrepresentable result leaves all state unchanged.
    pub fn step_with_tuning(
        &mut self,
        input: Input,
        supports: [Option<f32>; 4],
        dt: f32,
        tuning: &Tuning,
    ) -> Result<[f32; 3], StepError> {
        self.step_with_surface_motion(input, supports, 0.0, dt, tuning)
    }

    /// Terrain rise rate under horizontal motion, in yd/s; zero for flat or missing support.
    /// Damping and contact use velocity relative to the support plane, not world vertical speed.
    pub fn step_with_surface_motion(
        &mut self,
        input: Input,
        supports: [Option<f32>; 4],
        surface_velocity: f32,
        dt: f32,
        tuning: &Tuning,
    ) -> Result<[f32; 3], StepError> {
        tuning.validate()?;
        if !dt.is_finite() || dt <= 0.0 || dt > 1.0 / 30.0 {
            return Err(StepError::InvalidDt);
        }
        if !input.throttle.is_finite() || !input.steer.is_finite() || !surface_velocity.is_finite()
        {
            return Err(StepError::InvalidInput);
        }
        if !self.valid() {
            return Err(StepError::InvalidState);
        }
        for (index, distance) in supports.iter().enumerate() {
            if distance.is_some_and(|v| !v.is_finite() || v < 0.0) {
                return Err(StepError::InvalidSupport(index));
            }
        }
        let mut next = *self;
        next.advance(input, supports, surface_velocity, dt, tuning);
        if !next.valid() {
            return Err(StepError::NonFiniteResult);
        }
        *self = next;
        Ok(self.velocity)
    }

    fn valid(&self) -> bool {
        self.position
            .iter()
            .chain(self.velocity.iter())
            .all(|v| v.is_finite())
            && [self.yaw, self.yaw_rate, self.bank]
                .iter()
                .all(|v| v.is_finite())
            && (0.0..=1.0).contains(&self.boost_reserve)
            && [self.jump_cooldown, self.support_lockout]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.0)
    }

    fn advance(
        &mut self,
        input: Input,
        supports: [Option<f32>; 4],
        surface_velocity: f32,
        dt: f32,
        tuning: &Tuning,
    ) {
        self.jump_cooldown = (self.jump_cooldown - dt).max(0.0);
        self.support_lockout = (self.support_lockout - dt).max(0.0);
        let mut height = 0.0;
        let mut count = 0;
        for distance in supports
            .into_iter()
            .flatten()
            .filter(|v| *v <= tuning.support_reach())
        {
            height += distance as f64;
            count += 1;
        }
        let support = count > 0 && self.support_lockout == 0.0;
        if count > 0 {
            height /= count as f64;
        }
        self.grounded = support
            && height <= tuning.hover_height as f64 + 0.3
            && f64::from(self.velocity[1]) - f64::from(surface_velocity) <= 2.0;
        let jump = input.jump && !self.jump_held && self.grounded && self.jump_cooldown == 0.0;
        self.jump_held = input.jump;
        if jump {
            self.velocity[1] = (f64::from(surface_velocity) + f64::from(tuning.hop_speed)) as f32;
            self.jump_cooldown = 0.65;
            self.support_lockout = 0.3;
            self.grounded = false;
        }
        // Lift is unilateral: distant/missing ground cannot pull the racer downward or hold it up.
        let dt64 = dt as f64;
        let vertical = self.velocity[1] as f64;
        let gravity = tuning.gravity as f64;
        let next_vertical = if support && !jump {
            let relative = vertical - f64::from(surface_velocity);
            let spring = f64::from(tuning.spring);
            let damping = f64::from(tuning.damping);
            // Implicit spring/damper stays stable with stiff tuning; suspension can push, not suck.
            let relative_next = (relative
                + spring * (f64::from(tuning.hover_height) - height) * dt64)
                / (1.0 + damping * dt64 + spring * dt64 * dt64);
            (relative_next + f64::from(surface_velocity)).max(vertical - gravity * dt64)
        } else {
            vertical - gravity * dt64
        };
        self.velocity[1] = next_vertical as f32;

        let throttle = input.throttle.clamp(-1.0, 1.0) as f64;
        let steer = input.steer.clamp(-1.0, 1.0) as f64;
        let authority = if self.grounded {
            1.0
        } else {
            tuning.air_control as f64
        };
        let vx = self.velocity[0] as f64;
        let vz = self.velocity[2] as f64;
        let speed = vx.hypot(vz);
        let previous_speed = speed;
        let target_turn = steer
            * tuning.turn_rate as f64
            * authority
            * if input.drift {
                tuning.drift_turn_multiplier as f64
            } else {
                1.0
            };
        // exp_m1 retains response for tiny rates; f64 products handle every finite f32 input.
        let yaw_rate = self.yaw_rate as f64
            + (target_turn - self.yaw_rate as f64)
                * -(-(tuning.turn_response as f64) * dt64).exp_m1();
        self.yaw_rate = yaw_rate as f32;
        self.yaw = ((self.yaw as f64 + yaw_rate * dt64 + std::f64::consts::PI)
            .rem_euclid(std::f64::consts::TAU)
            - std::f64::consts::PI) as f32;
        let bank_target =
            (-steer * authority * (speed / 12.0).min(1.0) * 0.35).clamp(-0.35, 0.35);
        self.bank =
            (self.bank as f64 + (bank_target - self.bank as f64) * -(-8.0 * dt64).exp_m1()) as f32;
        let (sin, cos) = self.yaw.sin_cos();
        let forward = [-sin as f64, -cos as f64];
        let right = [cos as f64, -sin as f64];
        let mut longitudinal = vx * forward[0] + vz * forward[1];
        let lateral = (vx * right[0] + vz * right[1])
            * (-(if input.drift {
                tuning.drift_grip
            } else {
                tuning.grip
            } as f64)
                * authority
                * dt64)
                .exp();
        let boosting = input.boost
            && throttle > 0.0
            && !input.brake
            && authority > 0.0
            && self.boost_reserve > 0.0;
        // Prorate the final fraction of boost rather than granting a whole free last tick.
        let boost_fraction = if boosting {
            (self.boost_reserve / (BOOST_DRAIN_PER_SEC * dt)).min(1.0)
        } else {
            0.0
        };
        if boosting {
            self.boost_reserve = (self.boost_reserve - BOOST_DRAIN_PER_SEC * dt).max(0.0);
        } else if !input.boost {
            self.boost_reserve = (self.boost_reserve + BOOST_RECHARGE_PER_SEC * dt).min(1.0);
        }
        longitudinal += throttle
            * (tuning.acceleration as f64
                + tuning.boost_acceleration as f64 * boost_fraction as f64)
            * authority
            * dt64;
        // Scaled by authority like grip above: full air control keeps full drag, but a
        // reduced air authority must not let full-strength drag outrun already-scaled-down
        // airborne thrust, or holding the throttle in midair can never gain speed.
        let drag = (-(tuning.drag as f64) * authority * dt64).exp();
        longitudinal *= drag;
        if input.brake {
            longitudinal = longitudinal.signum()
                * (longitudinal.abs() - tuning.braking as f64 * authority * dt64).max(0.0);
        }
        let mut vx = forward[0] * longitudinal + right[0] * lateral;
        let mut vz = forward[1] * longitudinal + right[1] * lateral;
        let speed = vx.hypot(vz);
        // Retain excess boost momentum when released, but never accelerate past the normal cap.
        let cap = if boosting {
            tuning.boost_max_speed as f64
        } else {
            (tuning.max_speed as f64).max(previous_speed * drag)
        };
        let cap = cap.min(tuning.boost_max_speed as f64);
        if speed > cap {
            vx *= cap / speed;
            vz *= cap / speed;
        }
        self.velocity[0] = vx as f32;
        self.velocity[2] = vz as f32;
    }
}

fn wrap_yaw(yaw: f32) -> f32 {
    (yaw + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI
}

#[cfg(test)]
mod tests {
    use super::*;

    fn racer() -> State {
        State::new([0.0, HOVER_HEIGHT, 0.0], 0.0).unwrap()
    }

    fn speed(state: &State) -> f32 {
        state.velocity[0].hypot(state.velocity[2])
    }

    fn tick(state: &mut State, input: Input) {
        let distance = (state.position[1] >= 0.0).then_some(state.position[1]);
        state.step(input, [distance; 4], FIXED_DT).unwrap();
        for axis in 0..3 {
            state.position[axis] += state.velocity[axis] * FIXED_DT;
        }
        // Minimal level-ground collision resolver, deliberately outside the numerical step.
        if state.position[1] < 0.25 {
            state.position[1] = 0.25;
            state.velocity[1] = state.velocity[1].max(0.0);
        }
    }

    #[test]
    fn accelerates_and_brakes_without_integrating_position() {
        let mut state = racer();
        let position = state.position;
        let thrust = Input {
            throttle: 1.0,
            ..Input::default()
        };
        for _ in 0..120 {
            state
                .step(thrust, [Some(HOVER_HEIGHT); 4], FIXED_DT)
                .unwrap();
        }
        assert_eq!(state.position, position);
        let accelerated = speed(&state);
        assert!(accelerated > 15.0 && accelerated < 17.0, "{accelerated}");
        for _ in 0..120 {
            tick(
                &mut state,
                Input {
                    brake: true,
                    ..Input::default()
                },
            );
        }
        assert!(speed(&state) < 0.01);
        println!(
            "one-second acceleration: {accelerated:.3}; one-second braking: {:.3}",
            speed(&state)
        );
    }

    #[test]
    fn steering_tracks_motion_while_drift_preserves_slip() {
        let mut grip = racer();
        grip.velocity[2] = -20.0;
        let mut drift = grip;
        let steer = Input {
            steer: 1.0,
            ..Input::default()
        };
        for _ in 0..60 {
            tick(&mut grip, steer);
            tick(
                &mut drift,
                Input {
                    drift: true,
                    ..steer
                },
            );
        }
        let slip = |state: &State| {
            let (sin, cos) = state.yaw.sin_cos();
            (state.velocity[0] * cos - state.velocity[2] * sin).abs()
        };
        assert!(grip.yaw > 0.5 && grip.velocity[0] < -5.0);
        assert!(slip(&drift) > slip(&grip) * 2.0);
        assert!(drift.yaw > grip.yaw);
        println!(
            "half-second lateral slip grip={:.3}, drift={:.3}",
            slip(&grip),
            slip(&drift)
        );
        let mut stopped = racer();
        for _ in 0..120 {
            tick(&mut stopped, steer);
        }
        assert!(stopped.yaw > 1.0);
        assert_eq!(speed(&stopped), 0.0);
    }

    #[test]
    fn steering_works_after_crests_and_long_falls_without_granting_flight() {
        for air_control in [0.0, 0.8] {
            let tuning = Tuning {
                air_control,
                drag: 0.0,
                ..Tuning::default()
            };
            let mut state = State::new([0.0, 100.0, 0.0], 0.0).unwrap();
            for _ in 0..240 {
                state
                    .step_with_tuning(
                        Input {
                            steer: 1.0,
                            boost: true,
                            ..Input::default()
                        },
                        [None; 4],
                        FIXED_DT,
                        &tuning,
                    )
                    .unwrap();
            }
            assert_eq!(speed(&state), 0.0);
            assert!(state.velocity[1] < -25.0);
            assert_eq!(state.boost_reserve, 1.0);
            if air_control == 0.0 {
                assert_eq!(state.yaw, 0.0);
            } else {
                assert!(state.yaw.abs() > 1.0);
                assert!((state.yaw_rate - tuning.turn_rate * air_control).abs() < 0.001);
            }
        }
    }

    #[test]
    fn equilibrium_and_perturbations_converge() {
        let mut equilibrium = racer();
        for _ in 0..1200 {
            tick(&mut equilibrium, Input::default());
        }
        assert!((equilibrium.position[1] - HOVER_HEIGHT).abs() < 0.00001);
        for initial_height in [0.4, 1.65] {
            let mut state = racer();
            state.position[1] = initial_height;
            for _ in 0..360 {
                tick(&mut state, Input::default());
            }
            assert!(
                (state.position[1] - HOVER_HEIGHT).abs() < 0.001,
                "{state:?}"
            );
            assert!(state.velocity[1].abs() < 0.001);
            println!(
                "height {initial_height:.2} -> {:.6} after 3s",
                state.position[1]
            );
        }
    }

    #[test]
    fn climbing_and_descending_support_preserve_contact_and_control() {
        for rise in [-40.0, -5.0, 0.0, 5.0, 40.0] {
            let mut state = racer();
            state.velocity = [0.0, rise, -20.0];
            for _ in 0..120 {
                state
                    .step_with_surface_motion(
                        Input {
                            throttle: 1.0,
                            steer: 0.5,
                            boost: true,
                            ..Default::default()
                        },
                        [Some(HOVER_HEIGHT); 4],
                        rise,
                        FIXED_DT,
                        &Tuning::default(),
                    )
                    .unwrap();
                assert!(state.grounded, "terrain rise {rise}");
                assert!((state.velocity[1] - rise).abs() < 0.0001);
            }
            assert!(state.yaw.abs() > 0.5);
            assert!(speed(&state) > 30.0);
            assert!(state.boost_reserve < 0.95);
        }
    }

    #[test]
    fn slope_hop_inherits_rise_then_ignores_support_during_lockout() {
        for rise in [-5.0, 8.0] {
            let tuning = Tuning::default();
            let mut state = racer();
            state.velocity[1] = rise;
            state
                .step_with_surface_motion(
                    Input {
                        jump: true,
                        ..Default::default()
                    },
                    [Some(HOVER_HEIGHT); 4],
                    rise,
                    FIXED_DT,
                    &tuning,
                )
                .unwrap();
            assert!(!state.grounded);
            assert!(
                (state.velocity[1] - (rise + tuning.hop_speed - GRAVITY * FIXED_DT)).abs()
                    < 0.00001
            );
            let before = state.velocity[1];
            state
                .step_with_surface_motion(
                    Input::default(),
                    [Some(HOVER_HEIGHT); 4],
                    100.0,
                    FIXED_DT,
                    &tuning,
                )
                .unwrap();
            assert!(!state.grounded);
            assert!((state.velocity[1] - (before - GRAVITY * FIXED_DT)).abs() < 0.00001);
        }
    }

    #[test]
    fn partial_supports_agree_and_missing_support_never_uses_terrain_motion() {
        let mut full = racer();
        full.velocity[1] = -3.0;
        let mut partial = full;
        full.step(Input::default(), [Some(0.8); 4], FIXED_DT)
            .unwrap();
        partial
            .step(
                Input::default(),
                [Some(0.8), None, Some(0.8), None],
                FIXED_DT,
            )
            .unwrap();
        assert_eq!(full, partial);
        for supports in [[None; 4], [Some(SUPPORT_REACH + 0.01); 4]] {
            let mut flat = racer();
            let mut slope = flat;
            flat.step(Input::default(), supports, FIXED_DT).unwrap();
            slope
                .step_with_surface_motion(
                    Input::default(),
                    supports,
                    f32::MAX,
                    FIXED_DT,
                    &Tuning::default(),
                )
                .unwrap();
            assert_eq!(flat, slope);
        }
    }

    #[test]
    fn spring_float_absorbs_small_bumps_instead_of_snapping_to_ground() {
        let mut state = racer();
        let mut peak = HOVER_HEIGHT;
        for tick in 0..480 {
            let ground = if tick < 30 { 0.25 } else { 0.0 };
            let before = state.position[1];
            state
                .step(Input::default(), [Some(before - ground); 4], FIXED_DT)
                .unwrap();
            state.position[1] += state.velocity[1] * FIXED_DT;
            assert!((state.position[1] - before).abs() < 0.02);
            if tick == 0 {
                assert!(
                    state.position[1] > HOVER_HEIGHT && state.position[1] < HOVER_HEIGHT + 0.01
                );
            }
            peak = peak.max(state.position[1]);
        }
        assert!(peak > HOVER_HEIGHT + 0.1 && peak < HOVER_HEIGHT + 0.3);
        assert!((state.position[1] - HOVER_HEIGHT).abs() < 0.001);
        println!(
            "quarter-yard bump: body rise {:.4}yd, settles within .001yd after 4s",
            peak - HOVER_HEIGHT
        );
    }

    #[test]
    fn crest_is_ballistic_and_reacquisition_recovers_without_free_flight() {
        let mut state = racer();
        state.velocity[1] = 12.0;
        for _ in 0..60 {
            state
                .step_with_surface_motion(
                    Input {
                        throttle: 1.0,
                        boost: true,
                        ..Default::default()
                    },
                    [None; 4],
                    -12.0,
                    FIXED_DT,
                    &Tuning::default(),
                )
                .unwrap();
            assert!(!state.grounded);
            assert!(speed(&state) > 0.0);
            assert!(state.boost_reserve < 1.0);
        }
        assert!((state.boost_reserve - (1.0 - 0.2 / 3.0)).abs() < 0.00001);
        assert!(state.velocity[1].abs() < 0.0001);
        for _ in 0..600 {
            tick(&mut state, Input::default());
        }
        assert!(state.grounded);
        assert!((state.position[1] - HOVER_HEIGHT).abs() < 0.001);
    }

    #[test]
    fn stiff_or_zero_suspension_stays_finite_and_bounded() {
        for (spring, damping) in [(90.0, 0.0), (1e8, 0.0), (f32::MAX, f32::MAX), (0.0, 0.0)] {
            let tuning = Tuning {
                spring,
                damping,
                ..Default::default()
            };
            let mut state = racer();
            state.position[1] -= 0.2;
            for _ in 0..1200 {
                state
                    .step_with_tuning(
                        Input::default(),
                        [Some(state.position[1]); 4],
                        FIXED_DT,
                        &tuning,
                    )
                    .unwrap();
                state.position[1] += state.velocity[1] * FIXED_DT;
                assert!(
                    (0.0..20.0).contains(&state.position[1]),
                    "{spring}/{damping}: {state:?}"
                );
                assert!(
                    state.velocity[1].abs() < 30.0,
                    "{spring}/{damping}: {state:?}"
                );
            }
        }
    }

    #[test]
    fn terrain_motion_nonfinite_and_overflow_fail_atomically() {
        for rise in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let original = racer();
            let mut state = original;
            assert_eq!(
                state.step_with_surface_motion(
                    Input::default(),
                    [Some(HOVER_HEIGHT); 4],
                    rise,
                    FIXED_DT,
                    &Tuning::default(),
                ),
                Err(StepError::InvalidInput)
            );
            assert_eq!(state, original);
        }
        let mut state = racer();
        let original = state;
        let tuning = Tuning {
            hop_speed: f32::MAX,
            ..Default::default()
        };
        assert_eq!(
            state.step_with_surface_motion(
                Input {
                    jump: true,
                    ..Default::default()
                },
                [Some(HOVER_HEIGHT); 4],
                f32::MAX,
                FIXED_DT,
                &tuning,
            ),
            Err(StepError::NonFiniteResult)
        );
        assert_eq!(state, original);
    }

    #[test]
    fn reverse_braking_never_flips_direction_and_does_not_spend_boost() {
        let mut state = racer();
        state.velocity[2] = 10.0;
        for _ in 0..240 {
            state
                .step(
                    Input {
                        brake: true,
                        boost: true,
                        ..Default::default()
                    },
                    [Some(HOVER_HEIGHT); 4],
                    FIXED_DT,
                )
                .unwrap();
            assert!(state.velocity[2] >= 0.0);
            assert_eq!(state.boost_reserve, 1.0);
        }
        assert!(speed(&state) < 0.001);
    }

    #[test]
    fn missing_or_distant_support_is_ballistic_not_suction() {
        for supports in [[None; 4], [Some(SUPPORT_REACH + 0.01); 4]] {
            let mut state = racer();
            state.step(Input::default(), supports, FIXED_DT).unwrap();
            assert!((state.velocity[1] + GRAVITY * FIXED_DT).abs() < 0.00001);
            assert!(!state.grounded);
        }
        let mut state = racer();
        state.velocity[1] = 8.0;
        state
            .step(Input::default(), [Some(1.8); 4], FIXED_DT)
            .unwrap();
        assert!((state.velocity[1] - (8.0 - GRAVITY * FIXED_DT)).abs() < 0.00001);
        let mut compressed = racer();
        compressed.velocity[1] = -50.0;
        compressed
            .step(Input::default(), [Some(0.0); 4], FIXED_DT)
            .unwrap();
        let expected = (-50.0 + 90.0 * HOVER_HEIGHT * FIXED_DT)
            / (1.0 + 18.0 * FIXED_DT + 90.0 * FIXED_DT * FIXED_DT);
        assert!((compressed.velocity[1] - expected).abs() < 0.00001);
    }

    #[test]
    fn held_jump_hops_once_then_lands_without_flight() {
        let mut state = racer();
        let held = Input {
            jump: true,
            throttle: 1.0,
            boost: true,
            ..Input::default()
        };
        let mut peak = HOVER_HEIGHT;
        let mut hops = 0;
        for _ in 0..1200 {
            let before = state.velocity[1];
            tick(&mut state, held);
            if before < 2.0 && state.velocity[1] > 6.0 {
                hops += 1;
            }
            peak = peak.max(state.position[1]);
        }
        assert_eq!(hops, 1);
        assert!(peak > HOVER_HEIGHT + 0.5 && peak < HOVER_HEIGHT + 1.2);
        assert!((state.position[1] - HOVER_HEIGHT).abs() < 0.001);
        assert!(state.grounded);
        tick(&mut state, Input::default());
        tick(&mut state, held);
        assert!(state.velocity[1] > 6.0);
        println!("held-hop peak={peak:.3}, hops in 10s={hops}");
    }

    #[test]
    fn airborne_boost_continues_after_hop_without_vertical_lift() {
        let mut state = racer();
        tick(
            &mut state,
            Input {
                jump: true,
                ..Input::default()
            },
        );
        for _ in 0..60 {
            state
                .step(
                    Input {
                        throttle: 1.0,
                        boost: true,
                        ..Input::default()
                    },
                    [None; 4],
                    FIXED_DT,
                )
                .unwrap();
        }
        let before = speed(&state);
        let reserve = state.boost_reserve;
        for _ in 0..120 {
            state
                .step(
                    Input {
                        throttle: 1.0,
                        boost: true,
                        ..Input::default()
                    },
                    [None; 4],
                    FIXED_DT,
                )
                .unwrap();
        }
        assert!(speed(&state) > before + 1.0);
        assert!((state.boost_reserve - (reserve - 0.4 / 3.0)).abs() < 0.00001);
        assert!(state.velocity[1] < -20.0);
    }

    #[test]
    fn sustained_air_thrust_and_braking_match_rates_without_vertical_lift() {
        for hz in [30, 60, 144] {
            for air_control in [0.0, 0.8] {
                let tuning = Tuning {
                    acceleration: 30.0,
                    braking: 30.0,
                    drag: 0.0,
                    air_control,
                    max_speed: 250.0,
                    boost_max_speed: 500.0,
                    ..Tuning::default()
                };
                let mut state = State::new([0.0, 100.0, 0.0], 0.0).unwrap();
                let mut falling = state;
                let dt = 1.0 / hz as f32;
                for tick in 0..hz * 3 {
                    state
                        .step_with_tuning(
                            Input {
                                throttle: if tick < hz * 2 { 1.0 } else { 0.0 },
                                brake: tick >= hz * 2,
                                boost: false,
                                ..Input::default()
                            },
                            [None; 4],
                            dt,
                            &tuning,
                        )
                        .unwrap();
                    falling
                        .step_with_tuning(Input::default(), [None; 4], dt, &tuning)
                        .unwrap();
                    assert_eq!(state.velocity[1], falling.velocity[1]);
                    assert_eq!(state.position[1], falling.position[1]);
                    if tick == hz * 2 - 1 {
                        assert!((speed(&state) - 60.0 * air_control).abs() < 0.001);
                    }
                }
                assert!((speed(&state) - 30.0 * air_control).abs() < 0.001);
                assert_eq!(state.boost_reserve, 1.0);
            }
        }
    }

    #[test]
    fn airborne_boost_from_rest_preserves_gravity_and_reserve_rules() {
        for hz in [30, 60, 144] {
            for air_control in [0.0, 0.9] {
                let tuning = Tuning {
                    air_control,
                    drag: 0.0,
                    ..Tuning::default()
                };
                let mut boosted = State::new([0.0, 100.0, 0.0], 0.0).unwrap();
                let mut normal = boosted;
                let mut falling = boosted;
                let dt = 1.0 / hz as f32;
                for _ in 0..hz {
                    for (state, input) in [
                        (&mut boosted, Input { throttle: 1.0, boost: true, ..Input::default() }),
                        (&mut normal, Input { throttle: 1.0, ..Input::default() }),
                        (&mut falling, Input::default()),
                    ] {
                        state.step_with_tuning(input, [None; 4], dt, &tuning).unwrap();
                    }
                    assert_eq!(boosted.velocity[1], falling.velocity[1]);
                    assert_eq!(normal.velocity[1], falling.velocity[1]);
                    assert!(!boosted.grounded);
                }
                assert!((speed(&normal) - tuning.acceleration * air_control).abs() < 0.001);
                assert!((speed(&boosted) - (tuning.acceleration + tuning.boost_acceleration) * air_control).abs() < 0.001);
                let expected = if air_control > 0.0 { 1.0 - 0.4 / 3.0 } else { 1.0 };
                assert!((boosted.boost_reserve - expected).abs() < 0.00001);
                assert_eq!(normal.boost_reserve, 1.0);
            }
        }
    }

    #[test]
    fn airborne_braking_reverse_and_idle_do_not_spend_boost() {
        for (throttle, brake) in [(1.0, true), (-1.0, false), (0.0, false)] {
            let mut boosted = State::new([0.0, 100.0, 0.0], 0.0).unwrap();
            boosted.boost_reserve = 0.4;
            let mut normal = boosted;
            for _ in 0..60 {
                let input = Input { throttle, brake, boost: true, ..Input::default() };
                boosted.step(input, [None; 4], FIXED_DT).unwrap();
                normal.step(Input { boost: false, ..input }, [None; 4], FIXED_DT).unwrap();
                assert_eq!(boosted.velocity, normal.velocity);
                assert_eq!(boosted.boost_reserve, 0.4);
            }
        }
    }

    #[test]
    fn fall_and_landing_recover() {
        let mut state = State::new([0.0, 8.0, 0.0], 0.0).unwrap();
        for _ in 0..120 {
            tick(&mut state, Input::default());
        }
        assert!(state.position[1] < 4.0);
        for _ in 0..600 {
            tick(&mut state, Input::default());
        }
        assert!((state.position[1] - HOVER_HEIGHT).abs() < 0.001);
        assert!(state.grounded);
    }

    #[test]
    fn boost_and_normal_speed_and_reserve_are_bounded() {
        let mut normal = racer();
        let mut boosted = racer();
        let mut peak: f32 = 0.0;
        for frame in 0..2400 {
            tick(
                &mut normal,
                Input {
                    throttle: 1.0,
                    ..Input::default()
                },
            );
            tick(
                &mut boosted,
                Input {
                    throttle: 1.0,
                    boost: true,
                    ..Input::default()
                },
            );
            peak = peak.max(speed(&boosted));
            assert!(speed(&normal) <= MAX_SPEED + 0.0001);
            assert!(speed(&boosted) <= BOOST_MAX_SPEED + 0.0001);
            assert!((0.0..=1.0).contains(&boosted.boost_reserve));
            if frame == 119 {
                assert!(speed(&boosted) > speed(&normal) * 1.8);
            }
        }
        assert_eq!(boosted.boost_reserve, 0.0);
        for _ in 0..1200 {
            tick(&mut boosted, Input::default());
        }
        assert!((boosted.boost_reserve - 1.0).abs() < 0.00001);
        println!("normal top={:.3}, boost peak={peak:.3}", speed(&normal));
    }

    #[test]
    fn fixed_accumulator_is_render_grouping_invariant() {
        fn run(fps: u32) -> (State, usize) {
            let mut state = racer();
            let mut accumulator = 0.0_f64;
            let mut steps = 0;
            for _ in 0..fps * 6 {
                accumulator += 1.0 / fps as f64;
                while accumulator + 1e-12 >= 1.0 / 120.0 {
                    let input = Input {
                        throttle: 1.0,
                        steer: if steps >= 240 { 0.6 } else { 0.0 },
                        jump: (120..180).contains(&steps),
                        boost: steps < 120,
                        drift: steps >= 480,
                        ..Input::default()
                    };
                    tick(&mut state, input);
                    accumulator -= 1.0 / 120.0;
                    steps += 1;
                }
            }
            (state, steps)
        }
        let baseline = run(30);
        assert_eq!(baseline.1, 720);
        for fps in [60, 144] {
            assert_eq!(run(fps), baseline);
        }
    }

    #[test]
    fn reset_clears_all_dynamic_and_latched_state() {
        let mut state = racer();
        tick(
            &mut state,
            Input {
                jump: true,
                throttle: 1.0,
                boost: true,
                ..Input::default()
            },
        );
        state.reset([4.0, HOVER_HEIGHT, 9.0], 0.4).unwrap();
        assert_eq!(state, State::new([4.0, HOVER_HEIGHT, 9.0], 0.4).unwrap());
        tick(
            &mut state,
            Input {
                jump: true,
                ..Input::default()
            },
        );
        assert!(state.velocity[1] > 6.0);
    }

    #[test]
    fn invalid_arguments_are_explicit_and_atomic() {
        let original = racer();
        for dt in [0.0, -1.0, f32::NAN, f32::INFINITY, 0.1] {
            let mut state = original;
            assert_eq!(
                state.step(Input::default(), [None; 4], dt),
                Err(StepError::InvalidDt)
            );
            assert_eq!(state, original);
        }
        for input in [
            Input {
                throttle: f32::NAN,
                ..Input::default()
            },
            Input {
                steer: f32::INFINITY,
                ..Input::default()
            },
        ] {
            let mut state = original;
            assert_eq!(
                state.step(input, [None; 4], FIXED_DT),
                Err(StepError::InvalidInput)
            );
            assert_eq!(state, original);
        }
        for distance in [-1.0, f32::NAN, f32::INFINITY] {
            let mut state = original;
            assert_eq!(
                state.step(
                    Input::default(),
                    [None, Some(distance), None, None],
                    FIXED_DT
                ),
                Err(StepError::InvalidSupport(1))
            );
            assert_eq!(state, original);
        }
        let mut invalid = original;
        invalid.boost_reserve = 2.0;
        assert_eq!(
            invalid.step(Input::default(), [None; 4], FIXED_DT),
            Err(StepError::InvalidState)
        );
        assert_eq!(
            invalid.reset([f32::NAN, 0.0, 0.0], 0.0),
            Err(StepError::InvalidState)
        );
        assert_eq!(invalid.boost_reserve, 2.0);
        let mut invalid = original;
        invalid.velocity[0] = f32::NAN;
        assert_eq!(
            invalid.step(Input::default(), [None; 4], FIXED_DT),
            Err(StepError::InvalidState)
        );
        assert!(invalid.velocity[0].is_nan());
        assert_eq!(invalid.position, original.position);
    }

    #[test]
    fn finite_input_clamping_and_numerical_overflow_are_explicit() {
        let mut clamped = racer();
        let mut normal = clamped;
        clamped
            .step(
                Input {
                    throttle: 99.0,
                    steer: -99.0,
                    ..Input::default()
                },
                [Some(HOVER_HEIGHT); 4],
                FIXED_DT,
            )
            .unwrap();
        normal
            .step(
                Input {
                    throttle: 1.0,
                    steer: -1.0,
                    ..Input::default()
                },
                [Some(HOVER_HEIGHT); 4],
                FIXED_DT,
            )
            .unwrap();
        assert_eq!(clamped, normal);
        let mut overflow = racer();
        overflow.velocity = [f32::MAX, 0.0, f32::MAX];
        overflow
            .step(Input::default(), [None; 4], FIXED_DT)
            .unwrap();
        assert!(speed(&overflow) <= BOOST_MAX_SPEED + 0.0001);
    }

    #[test]
    fn default_tuning_matches_step_over_mixed_inputs() {
        let tuning = Tuning::default();
        assert_eq!(tuning.validate(), Ok(()));
        let mut default = racer();
        let mut configured = default;
        for frame in 0..1200 {
            let input = Input {
                throttle: if frame < 800 { 1.0 } else { -0.5 },
                steer: if frame % 240 < 120 { 0.7 } else { -0.4 },
                brake: frame >= 1000,
                boost: frame < 240,
                drift: frame % 120 < 60,
                jump: (360..420).contains(&frame),
            };
            let supports = if (600..720).contains(&frame) {
                [None; 4]
            } else {
                [Some(HOVER_HEIGHT); 4]
            };
            assert_eq!(
                default.step(input, supports, FIXED_DT),
                configured.step_with_tuning(input, supports, FIXED_DT, &tuning)
            );
            assert_eq!(default, configured, "frame {frame}");
        }
    }

    #[test]
    fn configured_speed_acceleration_and_boost_are_measurable() {
        let tuning = Tuning {
            max_speed: 10.0,
            boost_max_speed: 20.0,
            acceleration: 30.0,
            boost_acceleration: 30.0,
            ..Tuning::default()
        };
        let mut normal = racer();
        let mut boosted = normal;
        let mut baseline = normal;
        for frame in 0..180 {
            let input = Input {
                throttle: 1.0,
                ..Input::default()
            };
            normal
                .step_with_tuning(input, [Some(HOVER_HEIGHT); 4], FIXED_DT, &tuning)
                .unwrap();
            boosted
                .step_with_tuning(
                    Input {
                        boost: true,
                        ..input
                    },
                    [Some(HOVER_HEIGHT); 4],
                    FIXED_DT,
                    &tuning,
                )
                .unwrap();
            baseline
                .step(input, [Some(HOVER_HEIGHT); 4], FIXED_DT)
                .unwrap();
            assert!(speed(&normal) <= 10.0001);
            assert!(speed(&boosted) <= 20.0001);
            if frame == 29 {
                assert!(speed(&normal) > speed(&baseline) * 1.6);
            }
        }
        assert!((speed(&normal) - 10.0).abs() < 0.0001);
        assert!((speed(&boosted) - 20.0).abs() < 0.0001);
        let before = speed(&boosted);
        boosted
            .step_with_tuning(Input::default(), [Some(HOVER_HEIGHT); 4], FIXED_DT, &tuning)
            .unwrap();
        assert!((speed(&boosted) - before * (-tuning.drag * FIXED_DT).exp()).abs() < 0.0001);
        assert!(speed(&boosted) > tuning.max_speed);
    }

    #[test]
    fn configured_turn_and_braking_change_response() {
        let tuning = Tuning {
            turn_rate: 4.4,
            turn_response: 20.0,
            braking: 60.0,
            ..Tuning::default()
        };
        let mut baseline = racer();
        baseline.velocity[2] = -20.0;
        let mut configured = baseline;
        let steer = Input {
            steer: 1.0,
            ..Input::default()
        };
        for _ in 0..30 {
            baseline
                .step(steer, [Some(HOVER_HEIGHT); 4], FIXED_DT)
                .unwrap();
            configured
                .step_with_tuning(steer, [Some(HOVER_HEIGHT); 4], FIXED_DT, &tuning)
                .unwrap();
        }
        assert!(configured.yaw > baseline.yaw * 1.8);
        assert!(configured.yaw_rate > baseline.yaw_rate * 1.8);
        let mut baseline = racer();
        baseline.velocity[2] = -20.0;
        let mut configured = baseline;
        let brake = Input {
            brake: true,
            ..Input::default()
        };
        for _ in 0..30 {
            baseline
                .step(brake, [Some(HOVER_HEIGHT); 4], FIXED_DT)
                .unwrap();
            configured
                .step_with_tuning(brake, [Some(HOVER_HEIGHT); 4], FIXED_DT, &tuning)
                .unwrap();
        }
        assert!(speed(&baseline) > 11.0);
        assert!(speed(&configured) < 5.0);
    }

    #[test]
    fn configured_hover_hop_gravity_and_air_authority_are_applied() {
        let tuning = Tuning {
            hover_height: 1.5,
            hop_speed: 4.0,
            gravity: 40.0,
            air_control: 0.0,
            ..Tuning::default()
        };
        let mut state = racer();
        state
            .step_with_tuning(Input::default(), [Some(1.7); 4], FIXED_DT, &tuning)
            .unwrap();
        assert!(state.grounded);
        state.velocity = [0.0; 3];
        state
            .step_with_tuning(
                Input {
                    jump: true,
                    throttle: 1.0,
                    ..Input::default()
                },
                [Some(1.5); 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert!((state.velocity[1] - (4.0 - 40.0 * FIXED_DT)).abs() < 0.00001);
        assert_eq!(speed(&state), 0.0);
        state
            .step_with_tuning(
                Input {
                    throttle: 1.0,
                    steer: 1.0,
                    ..Input::default()
                },
                [None; 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert_eq!(speed(&state), 0.0);
        assert_eq!(state.yaw_rate, 0.0);
    }

    #[test]
    fn tuning_domains_and_nonfinite_values_are_checked_atomically() {
        type Field = fn(&mut Tuning) -> &mut f32;
        let fields: [(Field, f32, f32); 17] = [
            (|t| &mut t.max_speed, 1.0, 50.0),
            (|t| &mut t.boost_max_speed, 1.0, 50.0),
            (|t| &mut t.acceleration, 0.0, 60.0),
            (|t| &mut t.boost_acceleration, 0.0, 60.0),
            (|t| &mut t.braking, 0.0, 100.0),
            (|t| &mut t.drag, 0.01, 5.0),
            (|t| &mut t.turn_rate, 0.1, 6.0),
            (|t| &mut t.turn_response, 1.0, 30.0),
            (|t| &mut t.grip, 0.1, 30.0),
            (|t| &mut t.drift_grip, 0.1, 30.0),
            (|t| &mut t.drift_turn_multiplier, 0.1, 3.0),
            (|t| &mut t.hover_height, 0.5, 1.5),
            (|t| &mut t.spring, 10.0, 150.0),
            (|t| &mut t.damping, 1.0, 35.0),
            (|t| &mut t.gravity, 10.0, 40.0),
            (|t| &mut t.hop_speed, 2.0, 8.0),
            (|t| &mut t.air_control, 0.0, 0.5),
        ];
        let mut original = racer();
        original
            .step(
                Input {
                    jump: true,
                    ..Input::default()
                },
                [Some(HOVER_HEIGHT); 4],
                FIXED_DT,
            )
            .unwrap();
        let names = [
            "max_speed",
            "boost_max_speed",
            "acceleration",
            "boost_acceleration",
            "braking",
            "drag",
            "turn_rate",
            "turn_response",
            "grip",
            "drift_grip",
            "drift_turn_multiplier",
            "hover_height",
            "spring",
            "damping",
            "gravity",
            "hop_speed",
            "air_control",
        ];
        for ((field, min, max), name) in fields.into_iter().zip(names) {
            let positive = matches!(
                name,
                "max_speed" | "boost_max_speed" | "hover_height" | "gravity"
            );
            for value in [-1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY]
                .into_iter()
                .chain(positive.then_some(0.0))
            {
                let mut tuning = Tuning::default();
                *field(&mut tuning) = value;
                let error = tuning.validate().unwrap_err();
                let StepError::InvalidTuning(message) = error else {
                    panic!("expected field-specific tuning error");
                };
                assert_eq!(
                    message,
                    format!(
                        "{name} must be finite and {} 0",
                        if positive { ">" } else { ">=" }
                    )
                );
                assert_eq!(error.to_string(), message);
                let mut state = original;
                assert_eq!(
                    state.step_with_tuning(Input::default(), [None; 4], FIXED_DT, &tuning),
                    Err(error)
                );
                assert_eq!(state, original);
            }
            for value in [
                if positive { f32::from_bits(1) } else { 0.0 },
                min,
                max,
                f32::MAX,
            ] {
                let mut tuning = Tuning {
                    max_speed: f32::from_bits(1),
                    boost_max_speed: f32::MAX,
                    ..Tuning::default()
                };
                *field(&mut tuning) = value;
                assert_eq!(tuning.validate(), Ok(()));
            }
        }
        let tuning = Tuning {
            boost_max_speed: MAX_SPEED - 1.0,
            ..Tuning::default()
        };
        let mut state = original;
        assert_eq!(
            state.step_with_tuning(Input::default(), [None; 4], FIXED_DT, &tuning),
            Err(StepError::InvalidTuning(
                "boost_max_speed must be >= max_speed"
            ))
        );
        assert_eq!(state, original);
    }

    #[test]
    fn values_above_old_gameplay_limits_are_honored() {
        let tuning = Tuning {
            max_speed: 200.0,
            boost_max_speed: 300.0,
            acceleration: 1200.0,
            boost_acceleration: 2400.0,
            drag: 0.0,
            turn_rate: 20.0,
            turn_response: 1000.0,
            hover_height: 10.0,
            gravity: 1200.0,
            hop_speed: 100.0,
            ..Tuning::default()
        };
        assert_eq!(tuning.support_reach(), 10.8);
        let mut state = racer();
        for _ in 0..30 {
            state
                .step_with_tuning(
                    Input {
                        throttle: 1.0,
                        ..Input::default()
                    },
                    [Some(10.0); 4],
                    FIXED_DT,
                    &tuning,
                )
                .unwrap();
        }
        assert!(state.grounded);
        assert!((speed(&state) - 200.0).abs() < 0.001);
        state
            .step_with_tuning(
                Input {
                    throttle: 1.0,
                    boost: true,
                    ..Input::default()
                },
                [Some(10.0); 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert!(speed(&state) > 225.0);
        state
            .step_with_tuning(
                Input {
                    steer: 1.0,
                    ..Input::default()
                },
                [Some(10.0); 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert!(state.yaw_rate > 19.0);
        state
            .step_with_tuning(
                Input {
                    jump: true,
                    ..Input::default()
                },
                [Some(10.0); 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert!((state.velocity[1] - 90.0).abs() < 0.001);
        let mut fall = racer();
        for _ in 0..12 {
            fall.step_with_tuning(Input::default(), [None; 4], FIXED_DT, &tuning)
                .unwrap();
        }
        assert!(fall.velocity[1] < -119.0);
        let mut lift = racer();
        lift.step_with_tuning(
            Input::default(),
            [Some(0.0); 4],
            FIXED_DT,
            &Tuning {
                spring: 1200.0,
                ..tuning
            },
        )
        .unwrap();
        assert!(lift.velocity[1] > 75.0);
    }

    #[test]
    fn extreme_finite_tuning_uses_wide_intermediates_or_rejects_atomically() {
        let tuning = Tuning {
            max_speed: f32::MAX,
            boost_max_speed: f32::MAX,
            acceleration: f32::MAX,
            boost_acceleration: f32::MAX,
            drag: 0.0,
            hover_height: f32::MAX,
            ..Tuning::default()
        };
        assert_eq!(tuning.validate(), Ok(()));
        assert!(tuning.support_reach().is_finite());
        let mut state = racer();
        state
            .step_with_tuning(
                Input {
                    throttle: 1.0,
                    boost: true,
                    ..Input::default()
                },
                [Some(f32::MAX); 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert!(state.grounded);
        assert!(state.velocity[2] < -1e36);
        assert_eq!(state.velocity[1], 0.0);
        let before = state;
        let spring_overflow = Tuning {
            spring: f32::MAX,
            ..tuning
        };
        assert_eq!(
            state.step_with_tuning(Input::default(), [Some(0.0); 4], FIXED_DT, &spring_overflow),
            Err(StepError::NonFiniteResult)
        );
        assert_eq!(state, before);
        let turn_overflow = Tuning {
            turn_rate: f32::MAX,
            drift_turn_multiplier: f32::MAX,
            turn_response: f32::MAX,
            ..tuning
        };
        assert_eq!(
            state.step_with_tuning(
                Input {
                    steer: 1.0,
                    drift: true,
                    ..Input::default()
                },
                [Some(f32::MAX); 4],
                FIXED_DT,
                &turn_overflow
            ),
            Err(StepError::NonFiniteResult)
        );
        assert_eq!(state, before);
        let tiny_response = Tuning {
            turn_response: 1e-30,
            ..Tuning::default()
        };
        let mut turn = racer();
        turn.velocity[2] = -20.0;
        turn.step_with_tuning(
            Input {
                steer: 1.0,
                ..Input::default()
            },
            [Some(HOVER_HEIGHT); 4],
            FIXED_DT,
            &tiny_response,
        )
        .unwrap();
        assert!(turn.yaw_rate > 0.0);
        let mut hover = racer();
        hover
            .step_with_tuning(
                Input::default(),
                [Some(1.0); 4],
                FIXED_DT,
                &Tuning {
                    gravity: f32::MAX,
                    ..Tuning::default()
                },
            )
            .unwrap();
        assert!(hover.velocity[1] > 0.06);
        let mut ordinary_gravity = racer();
        ordinary_gravity
            .step(Input::default(), [Some(1.0); 4], FIXED_DT)
            .unwrap();
        assert_eq!(hover.velocity[1], ordinary_gravity.velocity[1]);
    }

    #[test]
    fn extreme_drag_grip_and_sustained_air_control_remain_finite() {
        let tuning = Tuning {
            max_speed: f32::MAX,
            boost_max_speed: f32::MAX,
            acceleration: f32::MAX,
            boost_acceleration: f32::MAX,
            braking: f32::MAX,
            drag: f32::MAX,
            grip: f32::MAX,
            drift_grip: f32::MAX,
            air_control: f32::MAX,
            turn_rate: 0.0,
            turn_response: 0.0,
            ..Tuning::default()
        };
        let mut state = racer();
        state.velocity[0] = f32::MAX;
        state
            .step_with_tuning(
                Input {
                    throttle: 1.0,
                    brake: true,
                    drift: true,
                    ..Input::default()
                },
                [Some(HOVER_HEIGHT); 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert_eq!(speed(&state), 0.0);
        let tuning = Tuning {
            drag: 0.0,
            acceleration: 120.0,
            air_control: 2.0,
            max_speed: 1000.0,
            boost_max_speed: 1000.0,
            ..Tuning::default()
        };
        state = racer();
        state
            .step_with_tuning(
                Input {
                    jump: true,
                    throttle: 1.0,
                    ..Input::default()
                },
                [Some(HOVER_HEIGHT); 4],
                FIXED_DT,
                &tuning,
            )
            .unwrap();
        assert!(speed(&state) > 1.9);
        for _ in 0..60 {
            state
                .step_with_tuning(
                    Input {
                        throttle: 1.0,
                        ..Input::default()
                    },
                    [None; 4],
                    FIXED_DT,
                    &tuning,
                )
                .unwrap();
        }
        let before = state.velocity;
        for _ in 0..120 {
            state
                .step_with_tuning(
                    Input {
                        throttle: 1.0,
                        boost: true,
                        ..Input::default()
                    },
                    [None; 4],
                    FIXED_DT,
                    &tuning,
                )
                .unwrap();
        }
        assert_eq!(state.velocity[0], before[0]);
        assert!(state.velocity[2] < before[2] - 200.0);
        assert!(state.velocity[1] < before[1]);
    }
}
