//! Pure Y-up hover-racer dynamics; collision detection and position integration belong to the caller.
//!
//! Deviation: this opt-in fork uses custom spring-supported racer physics, not stock 1.12 walking.
//! Call `step` at a fixed timestep, sweep its intended velocity through collision geometry, then
//! write the resolved position and velocity back. No step advances position or queries geometry.

use std::{error::Error, fmt};

pub const FIXED_DT: f32 = 1.0 / 120.0;
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

/// Runtime dynamics, bounded to the existing server safety envelope.
///
/// All bounds are inclusive and values must be finite. Speed caps are [1, 50], with boost
/// at least the normal cap; acceleration and boost acceleration are [0, 60], braking [0, 100],
/// drag [0.01, 5], turn rate [0.1, 6], turn response [1, 30], both grips [0.1, 30],
/// drift turn multiplier [0.1, 3], hover height [0.5, 1.5], spring [10, 150],
/// damping [1, 35], gravity [10, 40], hop speed [2, 8], and air control [0, 0.5].
/// Support reach, lift/vertical safety caps, boost consumption/recharge and timers stay fixed.
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
    /// Fraction of ground authority during the fixed, brief hop-control window.
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
            air_control: 0.25,
        }
    }
}

impl Tuning {
    /// Rejects the entire configuration, reporting the first invalid field and its allowed range.
    pub fn validate(&self) -> Result<(), StepError> {
        let bounds = [
            (
                self.max_speed,
                1.0,
                50.0,
                "max_speed must be finite and in [1, 50]",
            ),
            (
                self.boost_max_speed,
                1.0,
                50.0,
                "boost_max_speed must be finite and in [1, 50]",
            ),
            (
                self.acceleration,
                0.0,
                60.0,
                "acceleration must be finite and in [0, 60]",
            ),
            (
                self.boost_acceleration,
                0.0,
                60.0,
                "boost_acceleration must be finite and in [0, 60]",
            ),
            (
                self.braking,
                0.0,
                100.0,
                "braking must be finite and in [0, 100]",
            ),
            (self.drag, 0.01, 5.0, "drag must be finite and in [0.01, 5]"),
            (
                self.turn_rate,
                0.1,
                6.0,
                "turn_rate must be finite and in [0.1, 6]",
            ),
            (
                self.turn_response,
                1.0,
                30.0,
                "turn_response must be finite and in [1, 30]",
            ),
            (self.grip, 0.1, 30.0, "grip must be finite and in [0.1, 30]"),
            (
                self.drift_grip,
                0.1,
                30.0,
                "drift_grip must be finite and in [0.1, 30]",
            ),
            (
                self.drift_turn_multiplier,
                0.1,
                3.0,
                "drift_turn_multiplier must be finite and in [0.1, 3]",
            ),
            (
                self.hover_height,
                0.5,
                1.5,
                "hover_height must be finite and in [0.5, 1.5]",
            ),
            (
                self.spring,
                10.0,
                150.0,
                "spring must be finite and in [10, 150]",
            ),
            (
                self.damping,
                1.0,
                35.0,
                "damping must be finite and in [1, 35]",
            ),
            (
                self.gravity,
                10.0,
                40.0,
                "gravity must be finite and in [10, 40]",
            ),
            (
                self.hop_speed,
                2.0,
                8.0,
                "hop_speed must be finite and in [2, 8]",
            ),
            (
                self.air_control,
                0.0,
                0.5,
                "air_control must be finite and in [0, 0.5]",
            ),
        ];
        for (value, min, max, message) in bounds {
            if !value.is_finite() || !(min..=max).contains(&value) {
                return Err(StepError::InvalidTuning(message));
            }
        }
        if self.boost_max_speed < self.max_speed {
            return Err(StepError::InvalidTuning(
                "boost_max_speed must be in [1, 50] and >= max_speed",
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
    /// Fraction in [0, 1], consumed only by supported forward boost.
    pub boost_reserve: f32,
    jump_held: bool,
    air_steer_remaining: f32,
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
            Self::InvalidInput => f.write_str("throttle and steer must be finite"),
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
            air_steer_remaining: 0.0,
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

    /// Like `step`, with caller-selected dynamics; invalid tuning leaves all state unchanged.
    pub fn step_with_tuning(
        &mut self,
        input: Input,
        supports: [Option<f32>; 4],
        dt: f32,
        tuning: &Tuning,
    ) -> Result<[f32; 3], StepError> {
        tuning.validate()?;
        if !dt.is_finite() || dt <= 0.0 || dt > 1.0 / 30.0 {
            return Err(StepError::InvalidDt);
        }
        if !input.throttle.is_finite() || !input.steer.is_finite() {
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
        if !self.velocity[0].hypot(self.velocity[2]).is_finite() {
            return Err(StepError::NonFiniteResult);
        }
        let mut next = *self;
        next.advance(input, supports, dt, tuning);
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
            && [
                self.jump_cooldown,
                self.air_steer_remaining,
                self.support_lockout,
            ]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0)
    }

    fn advance(&mut self, input: Input, supports: [Option<f32>; 4], dt: f32, tuning: &Tuning) {
        self.jump_cooldown = (self.jump_cooldown - dt).max(0.0);
        self.air_steer_remaining = (self.air_steer_remaining - dt).max(0.0);
        self.support_lockout = (self.support_lockout - dt).max(0.0);
        let mut height = 0.0;
        let mut count = 0;
        for distance in supports
            .into_iter()
            .flatten()
            .filter(|v| *v <= SUPPORT_REACH)
        {
            height += distance;
            count += 1;
        }
        let support = count > 0 && self.support_lockout == 0.0;
        if count > 0 {
            height /= count as f32;
        }
        self.grounded = support && height <= tuning.hover_height + 0.3 && self.velocity[1] <= 2.0;
        let jump = input.jump && !self.jump_held && self.grounded && self.jump_cooldown == 0.0;
        self.jump_held = input.jump;
        if jump {
            self.velocity[1] = tuning.hop_speed;
            self.jump_cooldown = 0.65;
            self.support_lockout = 0.3;
            self.air_steer_remaining = 0.45;
            self.grounded = false;
        }
        // Lift is unilateral: distant/missing ground cannot pull the racer downward or hold it up.
        let lift = if support && !jump {
            (tuning.gravity + tuning.spring * (tuning.hover_height - height)
                - tuning.damping * self.velocity[1])
                .clamp(0.0, 100.0)
        } else {
            0.0
        };
        self.velocity[1] = (self.velocity[1] + (lift - tuning.gravity) * dt).clamp(-80.0, 12.0);

        let throttle = input.throttle.clamp(-1.0, 1.0);
        let steer = input.steer.clamp(-1.0, 1.0);
        let authority = if self.grounded {
            1.0
        } else if self.air_steer_remaining > 0.0 {
            tuning.air_control
        } else {
            0.0
        };
        let speed = self.velocity[0].hypot(self.velocity[2]);
        let previous_speed = speed;
        let target_turn = steer
            * tuning.turn_rate
            * (speed / 12.0).min(1.0)
            * authority
            * if input.drift {
                tuning.drift_turn_multiplier
            } else {
                1.0
            };
        self.yaw_rate += (target_turn - self.yaw_rate) * (1.0 - (-tuning.turn_response * dt).exp());
        self.yaw = wrap_yaw(self.yaw + self.yaw_rate * dt);
        self.bank += ((-steer * authority * (speed / 12.0).min(1.0) * 0.35) - self.bank)
            * (1.0 - (-8.0 * dt).exp());
        let (sin, cos) = self.yaw.sin_cos();
        let forward = [-sin, -cos];
        let right = [cos, -sin];
        let mut longitudinal = self.velocity[0] * forward[0] + self.velocity[2] * forward[1];
        let lateral = (self.velocity[0] * right[0] + self.velocity[2] * right[1])
            * (-(if input.drift {
                tuning.drift_grip
            } else {
                tuning.grip
            }) * authority
                * dt)
                .exp();
        let boosting = input.boost
            && throttle > 0.0
            && !input.brake
            && self.grounded
            && self.boost_reserve > 0.0;
        // Prorate the final fraction of boost rather than granting a whole free last tick.
        let boost_fraction = if boosting {
            (self.boost_reserve / (0.4 * dt)).min(1.0)
        } else {
            0.0
        };
        if boosting {
            self.boost_reserve = (self.boost_reserve - 0.4 * dt).max(0.0);
        } else if !input.boost {
            self.boost_reserve = (self.boost_reserve + 0.2 * dt).min(1.0);
        }
        longitudinal += throttle
            * (tuning.acceleration + tuning.boost_acceleration * boost_fraction)
            * authority
            * dt;
        longitudinal *= (-tuning.drag * dt).exp();
        if input.brake {
            longitudinal = longitudinal.signum()
                * (longitudinal.abs() - tuning.braking * authority * dt).max(0.0);
        }
        self.velocity[0] = forward[0] * longitudinal + right[0] * lateral;
        self.velocity[2] = forward[1] * longitudinal + right[1] * lateral;
        let speed = self.velocity[0].hypot(self.velocity[2]);
        // Retain excess boost momentum when released, but never accelerate past the normal cap.
        let cap = if boosting {
            tuning.boost_max_speed
        } else {
            tuning
                .max_speed
                .max(previous_speed * (-tuning.drag * dt).exp())
        };
        let cap = cap.min(tuning.boost_max_speed);
        if speed > cap {
            self.velocity[0] *= cap / speed;
            self.velocity[2] *= cap / speed;
        }
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
        assert_eq!(stopped.yaw, 0.0);
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
        assert!((compressed.velocity[1] - (-50.0 + 76.0 * FIXED_DT)).abs() < 0.00001);
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
    fn airborne_throttle_has_only_brief_hop_authority() {
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
                        steer: 1.0,
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
                        steer: 1.0,
                        ..Input::default()
                    },
                    [None; 4],
                    FIXED_DT,
                )
                .unwrap();
        }
        assert!(speed(&state) < before);
        assert_eq!(state.boost_reserve, reserve);
        assert!(state.velocity[1] < -20.0);
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
        for _ in 0..600 {
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
        let before = overflow;
        assert_eq!(
            overflow.step(Input::default(), [None; 4], FIXED_DT),
            Err(StepError::NonFiniteResult)
        );
        assert_eq!(overflow, before);
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
    fn every_tuning_bound_and_nonfinite_value_is_rejected_atomically() {
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
            for value in [
                min - 0.001,
                max + 0.001,
                f32::NAN,
                f32::INFINITY,
                f32::NEG_INFINITY,
            ] {
                let mut tuning = Tuning::default();
                *field(&mut tuning) = value;
                let error = tuning.validate().unwrap_err();
                let StepError::InvalidTuning(message) = error else {
                    panic!("expected field-specific tuning error");
                };
                assert_eq!(
                    message,
                    format!("{name} must be finite and in [{min}, {max}]")
                );
                assert_eq!(error.to_string(), message);
                let mut state = original;
                assert_eq!(
                    state.step_with_tuning(Input::default(), [None; 4], FIXED_DT, &tuning),
                    Err(error)
                );
                assert_eq!(state, original);
            }
            for value in [min, max] {
                let mut tuning = Tuning {
                    max_speed: 1.0,
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
                "boost_max_speed must be in [1, 50] and >= max_speed"
            ))
        );
        assert_eq!(state, original);
    }
}
