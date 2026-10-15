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
    NonFiniteResult,
}

impl fmt::Display for StepError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDt => f.write_str("dt must be finite and in (0, 1/30] seconds"),
            Self::InvalidInput => f.write_str("throttle and steer must be finite"),
            Self::InvalidState => f.write_str("state must be finite with valid reserve and timers"),
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
        next.advance(input, supports, dt);
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

    fn advance(&mut self, input: Input, supports: [Option<f32>; 4], dt: f32) {
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
        self.grounded = support && height <= HOVER_HEIGHT + 0.3 && self.velocity[1] <= 2.0;
        let jump = input.jump && !self.jump_held && self.grounded && self.jump_cooldown == 0.0;
        self.jump_held = input.jump;
        if jump {
            self.velocity[1] = 7.0;
            self.jump_cooldown = 0.65;
            self.support_lockout = 0.3;
            self.air_steer_remaining = 0.45;
            self.grounded = false;
        }
        // Lift is unilateral: distant/missing ground cannot pull the racer downward or hold it up.
        let lift = if support && !jump {
            (GRAVITY + 90.0 * (HOVER_HEIGHT - height) - 18.0 * self.velocity[1]).clamp(0.0, 100.0)
        } else {
            0.0
        };
        self.velocity[1] = (self.velocity[1] + (lift - GRAVITY) * dt).clamp(-80.0, 12.0);

        let throttle = input.throttle.clamp(-1.0, 1.0);
        let steer = input.steer.clamp(-1.0, 1.0);
        let authority = if self.grounded {
            1.0
        } else if self.air_steer_remaining > 0.0 {
            0.25
        } else {
            0.0
        };
        let speed = self.velocity[0].hypot(self.velocity[2]);
        let previous_speed = speed;
        let target_turn =
            steer * 2.2 * (speed / 12.0).min(1.0) * authority * if input.drift { 1.3 } else { 1.0 };
        self.yaw_rate += (target_turn - self.yaw_rate) * (1.0 - (-10.0 * dt).exp());
        self.yaw = wrap_yaw(self.yaw + self.yaw_rate * dt);
        self.bank += ((-steer * authority * (speed / 12.0).min(1.0) * 0.35) - self.bank)
            * (1.0 - (-8.0 * dt).exp());
        let (sin, cos) = self.yaw.sin_cos();
        let forward = [-sin, -cos];
        let right = [cos, -sin];
        let mut longitudinal = self.velocity[0] * forward[0] + self.velocity[2] * forward[1];
        let lateral = (self.velocity[0] * right[0] + self.velocity[2] * right[1])
            * (-(if input.drift { 1.5 } else { 8.0 }) * authority * dt).exp();
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
        longitudinal += throttle * (18.0 + 22.0 * boost_fraction) * authority * dt;
        longitudinal *= (-0.25 * dt).exp();
        if input.brake {
            longitudinal =
                longitudinal.signum() * (longitudinal.abs() - 30.0 * authority * dt).max(0.0);
        }
        self.velocity[0] = forward[0] * longitudinal + right[0] * lateral;
        self.velocity[2] = forward[1] * longitudinal + right[1] * lateral;
        let speed = self.velocity[0].hypot(self.velocity[2]);
        // Retain excess boost momentum when released, but never accelerate past the normal cap.
        let cap = if boosting {
            BOOST_MAX_SPEED
        } else {
            MAX_SPEED.max(previous_speed * (-0.25 * dt).exp())
        };
        let cap = cap.min(BOOST_MAX_SPEED);
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
}
