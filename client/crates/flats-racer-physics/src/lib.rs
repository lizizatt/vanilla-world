//! Pure Y-up hover-racer dynamics; collision detection and position integration belong to the caller.
//!
//! Deviation: this opt-in fork uses custom spring-supported racer physics, not stock 1.12 walking.
//! Call `step` at a fixed timestep, sweep its intended velocity through collision geometry, then
//! write the resolved position and velocity back. No step advances position or queries geometry.

use std::{error::Error, fmt};

pub mod wreck;


pub const FIXED_DT: f32 = 1.0 / 120.0;
/// Engine heat per second while boosting (7.5 s from cold to 1.0) and while cooling (10 s from full). Boost has no
/// reserve: it is always available and heat is the only limiter.
pub const HEAT_RISE_PER_SEC: f32 = 0.4 / 3.0;
pub const HEAT_COOL_PER_SEC: f32 = 0.1;
/// Heat at or above this fraction is the warning zone (about 6 s of continuous boost); 1.0 is overheated.
pub const HEAT_WARN: f32 = 0.8;
/// Durability: each engine (left pod, right pod) has health in [0, 1]. From HEAT_DAMAGE_START heat, damage ramps to
/// HEAT_DAMAGE_PER_SEC at 1.0 (about 7 s to kill one engine at full heat). Impact damage ramps linearly from 0 at
/// IMPACT_SAFE_SPEED to a whole engine at the lethal (instant-wreck) speed.
pub const HEAT_DAMAGE_START: f32 = 0.9;
pub const HEAT_DAMAGE_PER_SEC: f32 = 0.15;
pub const IMPACT_SAFE_SPEED: f32 = 20.0;

/// Engine health lost per second at this heat.
pub fn heat_damage_rate(heat: f32) -> f32 {
    ((heat - HEAT_DAMAGE_START) / (1.0 - HEAT_DAMAGE_START)).clamp(0.0, 1.0) * HEAT_DAMAGE_PER_SEC
}

/// Health fraction one engine loses from an impact at `speed`.
pub fn impact_damage(speed: f32, lethal: f32) -> f32 {
    if !speed.is_finite() || !(lethal > IMPACT_SAFE_SPEED) {
        return 0.0;
    }
    ((speed - IMPACT_SAFE_SPEED) / (lethal - IMPACT_SAFE_SPEED)).clamp(0.0, 1.0)
}
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
pub const GRAVITY: f32 = 48.0;

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
    /// Engine heat in [0, 1]: rises while forward boost has nonzero control authority, cools when boost is released.
    /// It caps at 1.0; whether that destroys the craft is the client's decision.
    pub heat: f32,
    /// Left and right engine health in [0, 1]; the client wrecks the craft when either reaches 0.
    pub health: [f32; 2],
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
            Self::InvalidState => f.write_str("state must be finite with valid heat and timers"),
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
            heat: 0.0,
            health: [1.0; 2],
            jump_held: false,
            support_lockout: 0.0,
        })
    }

    /// Atomically clears momentum, jump latch, all timers, bank and engine heat.
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
            && (0.0..=1.0).contains(&self.heat)
            && self.health.iter().all(|h| (0.0..=1.0).contains(h))
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
            && authority > 0.0;
        let boost_fraction = if boosting { 1.0 } else { 0.0 };
        if boosting {
            self.heat = (self.heat + HEAT_RISE_PER_SEC * dt).min(1.0);
        } else if !input.boost {
            self.heat = (self.heat - HEAT_COOL_PER_SEC * dt).max(0.0);
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
mod tests;

#[cfg(test)]
mod durability_tests;