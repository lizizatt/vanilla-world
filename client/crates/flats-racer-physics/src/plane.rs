//! Rigid-body fixed-wing dynamics for the browser plane vehicle (yards and seconds, like the hover racer).
//!
//! Attitude is an orthonormal body basis (x forward, y right, z down) turned by body rates, so roll, pitch
//! and yaw are fully coupled and loops/rolls work. Forces are linearised aerodynamics: lift from the angle of
//! attack with a stall roll-off, induced + parasitic drag, side force from sideslip, thrust along the nose and
//! gravity. Moments are stability derivatives (angle-of-attack spring, weathercock, dihedral) plus rate damping
//! and control-surface authority. Arcade aids keep it stable: lift trims to 1 g at any speed (and in a bank), and
//! a weak wing leveller returns the wings when the stick is released.
//!
//! Same contract as the racer: `step` updates attitude, speed, throttle and boost and returns the world velocity
//! but never moves the position; the caller sweeps that velocity through collision geometry, writes the resolved
//! position back, then calls `settle` with the support height under the plane.
//! Yaw zero faces -Z and positive yaw turns left; pitch up is positive; roll right is positive.
//! Boost fractions reuse the racer's constants.

use crate::{StepError, BOOST_DRAIN_PER_SEC, BOOST_RECHARGE_PER_SEC, FIXED_DT};

type V3 = [f32; 3];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaneTuning {
    /// Reference speed: dynamic pressure is (speed / cruise)^2 and the control authority fades below it.
    pub cruise: f32,
    /// Hard speed cap (boost terminal speed).
    pub boost_speed: f32,
    /// Thrust acceleration at full throttle, yd/s^2.
    pub thrust: f32,
    pub boost_thrust: f32,
    /// Ground-scrape speed bleed, yd/s^2.
    pub brake: f32,
    /// Throttle change per second while Shift / Ctrl is held.
    pub throttle_rate: f32,
    /// Angle of attack (rad) giving 1 g of lift at cruise speed.
    pub trim_alpha: f32,
    /// Lift peaks here and then falls off (stall).
    pub stall_alpha: f32,
    /// Extra angle of attack at full stick (rad).
    pub elevator: f32,
    /// Steady roll rate at full aileron, rad/s.
    pub roll_rate: f32,
    /// Dynamic-pressure ceiling for lift and moments (keeps the 1000 yd/s boost controllable).
    pub q_cap: f32,
    pub cd0: f32,
    pub cdi: f32,
    /// Side force per unit sideslip, in g at cruise.
    pub side: f32,
    /// Pitch stiffness (angle-of-attack spring), 1/s^2 per rad at cruise.
    pub m_alpha: f32,
    pub m_q: f32,
    pub l_beta: f32,
    pub l_p: f32,
    pub n_beta: f32,
    pub n_r: f32,
    /// Wing-leveller strength, 1/s^2 per rad of bank.
    pub level: f32,
    pub gravity: f32,
    /// Hover distance kept above the support surface (no-crash skim policy).
    pub clearance: f32,
    /// Rudder authority: yaw acceleration at full pedal, 1/s^2 at cruise.
    pub rudder: f32,
    /// How fast the virtual stick follows a (keyboard) input, full deflections per second.
    pub stick_rate: f32,
    /// Arcade flight-path hold: extra angle of attack (rad) per rad of climb/dive angle, applied with the stick
    /// released so the plane levels off hands-off instead of climbing or diving forever.
    pub path_hold: f32,
}

impl Default for PlaneTuning {
    fn default() -> Self {
        Self {
            cruise: 150.0,
            boost_speed: 1000.0,
            thrust: 50.0,
            boost_thrust: 250.0,
            brake: 60.0,
            throttle_rate: 0.5,
            trim_alpha: 0.06,
            stall_alpha: 0.40,
            elevator: 0.3,
            roll_rate: 1.8,
            q_cap: 6.0,
            cd0: 0.2,
            cdi: 0.06,
            side: 2.0,
            m_alpha: 14.0,
            m_q: 4.5,
            l_beta: 4.0,
            l_p: 5.0,
            n_beta: 6.0,
            n_r: 3.0,
            level: 1.0,
            gravity: 30.0,
            clearance: 3.0,
            rudder: 3.0,
            stick_rate: 4.0,
            path_hold: 0.3,
        }
    }
}

impl PlaneTuning {
    pub fn validate(&self) -> Result<(), StepError> {
        let all = [
            self.cruise, self.boost_speed, self.thrust, self.boost_thrust, self.brake, self.throttle_rate,
            self.trim_alpha, self.stall_alpha, self.elevator, self.roll_rate, self.q_cap, self.cd0, self.cdi,
            self.side, self.m_alpha, self.m_q, self.l_beta, self.l_p, self.n_beta, self.n_r, self.level,
            self.gravity, self.clearance, self.rudder, self.stick_rate,
            self.path_hold,
        ];
        if all.iter().any(|v| !v.is_finite() || *v < 0.0) {
            return Err(StepError::InvalidTuning("plane tuning must be finite and nonnegative"));
        }
        if self.cruise <= 0.0 || self.boost_speed < self.cruise || self.q_cap < 1.0 {
            return Err(StepError::InvalidTuning("plane cruise must be positive, boost >= cruise, q_cap >= 1"));
        }
        if self.trim_alpha <= 0.0 || self.stall_alpha <= self.trim_alpha || self.stall_alpha >= 1.0 {
            return Err(StepError::InvalidTuning("plane trim alpha must be positive and below stall alpha (< 1 rad)"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlaneInput {
    /// [-1, 1]; throttle change rate (Shift up, Ctrl down).
    pub throttle: f32,
    /// [-1, 1]; positive banks right.
    pub roll: f32,
    /// [-1, 1]; positive pulls the nose up.
    pub pitch: f32,
    /// [-1, 1]; rudder, positive yaws the nose right.
    pub yaw: f32,
    pub boost: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaneState {
    pub position: V3,
    /// World velocity, yd/s.
    pub velocity: V3,
    /// Body axes in world coordinates: forward, right, down.
    pub axes: [V3; 3],
    /// Body rates: roll p, pitch q (nose up), yaw r (nose right), rad/s.
    pub rates: V3,
    /// Euler views of `axes`, refreshed after every step.
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
    pub speed: f32,
    pub alpha: f32,
    pub beta: f32,
    /// Engine setting in [0, 1].
    pub throttle: f32,
    pub boost_reserve: f32,
    /// Filtered roll / pitch / yaw stick actually applied.
    pub stick: V3,
}

fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    v.max(lo).min(hi)
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn norm(a: V3) -> f32 {
    dot(a, a).sqrt()
}
fn unit(a: V3) -> V3 {
    scale(a, 1.0 / norm(a))
}

/// Rotates `v` about the unit `axis` by `angle` (right-handed).
fn rotate(v: V3, axis: V3, angle: f32) -> V3 {
    let (s, c) = angle.sin_cos();
    add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1.0 - c)))
}

fn turn_axes(axes: &mut [V3; 3], axis: V3, angle: f32) {
    for a in axes.iter_mut() {
        *a = rotate(*a, axis, angle);
    }
}

/// Lift coefficient relative to the trim angle (1 at `trim_alpha`): linear to the stall angle, then a
/// buffeting roll-off that keeps a third of the peak so the nose can always fall through.
fn lift_ratio(alpha: f32, t: &PlaneTuning) -> f32 {
    let x = alpha.abs();
    let peak = t.stall_alpha;
    let cl = if x <= peak { x } else { peak * (0.35 + 0.65 * (-(x - peak) / 0.25).exp()) };
    cl.copysign(alpha) / t.trim_alpha
}

impl PlaneState {
    /// Level flight at `speed` heading `yaw`, nose raised by the trim angle of attack.
    pub fn new(position: V3, yaw: f32, speed: f32) -> Result<Self, StepError> {
        if position.iter().chain([&yaw, &speed]).any(|v| !v.is_finite()) || speed < 0.0 {
            return Err(StepError::InvalidState);
        }
        let t = PlaneTuning::default();
        let level = [-yaw.sin(), 0.0, -yaw.cos()];
        let mut axes = [level, [level[2] * -1.0, 0.0, level[0]], [0.0, -1.0, 0.0]];
        axes[1] = cross(axes[2], axes[0]);
        let qp = ((speed / t.cruise).powi(2)).min(t.q_cap).max(0.05);
        let alpha = (t.trim_alpha / qp).min(t.stall_alpha * 0.8);
        let right = axes[1];
        turn_axes(&mut axes, right, alpha);
        let mut s = Self {
            position,
            velocity: scale(level, speed),
            axes,
            rates: [0.0; 3],
            yaw,
            pitch: 0.0,
            roll: 0.0,
            speed,
            alpha,
            beta: 0.0,
            throttle: 0.16,
            boost_reserve: 1.0,
            stick: [0.0; 3],
        };
        s.refresh();
        Ok(s)
    }

    pub fn forward(&self) -> V3 {
        self.axes[0]
    }

    /// Replaces the attitude (radians) keeping the velocity; used for spawning and tests.
    pub fn set_attitude(&mut self, yaw: f32, pitch: f32, roll: f32) {
        let level = [-yaw.sin(), 0.0, -yaw.cos()];
        let mut axes = [level, [0.0; 3], [0.0, -1.0, 0.0]];
        axes[1] = cross(axes[2], axes[0]);
        let right = axes[1];
        turn_axes(&mut axes, right, pitch);
        let f = axes[0];
        turn_axes(&mut axes, f, roll);
        self.axes = axes;
        self.refresh();
    }

    fn refresh(&mut self) {
        let [f, r, d] = self.axes;
        self.yaw = (-f[0]).atan2(-f[2]);
        self.pitch = clamp(f[1], -1.0, 1.0).asin();
        self.roll = (-r[1]).atan2(-d[1]);
        self.speed = norm(self.velocity);
        let (u, v, w) = (dot(self.velocity, f), dot(self.velocity, r), dot(self.velocity, d));
        let moving = self.speed > 1.0;
        self.alpha = if moving { w.atan2(u) } else { 0.0 };
        self.beta = if moving { clamp(v / self.speed, -1.0, 1.0).asin() } else { 0.0 };
    }

    fn orthonormalize(&mut self) {
        let f = unit(self.axes[0]);
        let d = unit(add(self.axes[2], scale(f, -dot(self.axes[2], f))));
        self.axes = [f, cross(d, f), d];
    }

    fn substep(&mut self, input: PlaneInput, boosting: bool, h: f32, t: &PlaneTuning) {
        let [f, r, d] = self.axes;
        let v = self.velocity;
        let speed = norm(v);
        let vhat = if speed > 1e-3 { scale(v, 1.0 / speed) } else { f };
        let vp = speed / t.cruise;
        let qs = vp * vp;
        let ql = qs.min(t.q_cap);
        let qm = ql.max(0.25);
        let e = clamp(vp, 0.25, 1.0);
        let dq = clamp(vp, 0.5, t.q_cap.sqrt());
        let (alpha, beta) = (self.alpha, self.beta);
        let cos_roll = self.roll.cos();
        let n = lift_ratio(alpha, t);
        let g = t.gravity;

        // Pitch: the angle-of-attack spring is aimed at the 1 g trim angle (also while banked) plus the stick.
        let alpha_ref = (t.trim_alpha / (ql.max(0.05) * cos_roll.max(0.4))).min(t.stall_alpha * 0.8);
        let gamma = if speed > 1.0 { (v[1] / speed).clamp(-1.0, 1.0).asin() } else { 0.0 };
        let hold = clamp(-t.path_hold * gamma, -0.12, 0.12) * (1.0 - input.pitch.abs()) * cos_roll.max(0.0)
            * (1.0 - alpha.abs() / t.stall_alpha).max(0.0);
        let target = clamp(alpha_ref + hold + input.pitch * t.elevator, -t.stall_alpha * 0.8, t.stall_alpha * 0.8);
        let excess = (alpha.abs() - t.stall_alpha).max(0.0);
        let [p, q, w] = self.rates;
        let q_dot = t.m_alpha * qm * (target - alpha) - t.m_q * dq * q - 20.0 * qm * excess.copysign(alpha);
        let p_dot = e * t.l_p * (t.roll_rate * input.roll - p) - t.l_beta * e * beta
            - t.level * self.roll.sin() * (1.0 - input.roll.abs());
        let r_dot = t.n_beta * qm * beta - t.n_r * dq * w + t.rudder * qm * input.yaw;
        self.rates = [p + p_dot * h, q + q_dot * h, w + r_dot * h];

        let lift_dir = {
            let up = add(scale(d, -1.0), scale(vhat, dot(d, vhat)));
            if norm(up) > 1e-3 { unit(up) } else { scale(d, -1.0) }
        };
        let thrust = self.throttle * t.thrust + if boosting { t.boost_thrust } else { 0.0 };
        let drag = g * (qs * t.cd0 + ql * t.cdi * n * n);
        let mut a = [0.0, -g, 0.0];
        a = add(a, scale(lift_dir, g * ql * n));
        a = add(a, scale(vhat, -drag));
        a = add(a, scale(r, -g * t.side * ql * beta));
        a = add(a, scale(f, thrust));
        let mut nv = add(v, scale(a, h));
        let nspeed = norm(nv);
        if nspeed > t.boost_speed {
            nv = scale(nv, t.boost_speed / nspeed);
        }
        self.velocity = nv;

        let w_world = add(add(scale(f, self.rates[0]), scale(r, self.rates[1])), scale(d, self.rates[2]));
        let rate = norm(w_world);
        if rate > 1e-9 {
            turn_axes(&mut self.axes, scale(w_world, 1.0 / rate), rate * h);
        }
        self.orthonormalize();
        self.refresh();
    }

    /// Returns the intended world velocity; state is unchanged on error. Roll/pitch/yaw inputs are a stick target:
    /// the applied deflection ramps toward it at `stick_rate` so digital keys are gentle.
    pub fn step(&mut self, input: PlaneInput, dt: f32, t: &PlaneTuning) -> Result<V3, StepError> {
        if !dt.is_finite() || dt <= 0.0 || dt > 1.0 / 30.0 {
            return Err(StepError::InvalidDt);
        }
        if ![input.throttle, input.roll, input.pitch, input.yaw].iter().all(|v| v.is_finite()) {
            return Err(StepError::InvalidInput);
        }
        let input = PlaneInput {
            throttle: clamp(input.throttle, -1.0, 1.0),
            roll: clamp(input.roll, -1.0, 1.0),
            pitch: clamp(input.pitch, -1.0, 1.0),
            yaw: clamp(input.yaw, -1.0, 1.0),
            boost: input.boost,
        };
        let mut s = *self;
        let reach = t.stick_rate * dt;
        for (stick, goal) in s.stick.iter_mut().zip([input.roll, input.pitch, input.yaw]) {
            *stick += clamp(goal - *stick, -reach, reach);
        }
        let applied = PlaneInput { roll: s.stick[0], pitch: s.stick[1], yaw: s.stick[2], ..input };
        let boosting = input.boost && s.boost_reserve > 0.0;
        let drain = if boosting { -BOOST_DRAIN_PER_SEC } else { BOOST_RECHARGE_PER_SEC };
        s.boost_reserve = clamp(s.boost_reserve + drain * dt, 0.0, 1.0);
        s.throttle = clamp(s.throttle + input.throttle * t.throttle_rate * dt, 0.0, 1.0);
        let n = (dt / FIXED_DT - 1e-3).ceil().max(1.0) as u32;
        let h = dt / n as f32;
        for _ in 0..n {
            s.substep(applied, boosting, h, t);
        }
        let finite = s.velocity.iter().chain(&s.rates).chain(s.axes.iter().flatten()).chain([&s.alpha, &s.beta, &s.roll]).all(|v| v.is_finite());
        if !finite {
            return Err(StepError::NonFiniteResult);
        }
        *self = s;
        Ok(s.velocity)
    }

    /// Keeps the plane `clearance` above the support height and reports whether it was scraping.
    pub fn settle(&mut self, support: Option<f32>, t: &PlaneTuning, dt: f32) -> bool {
        let Some(floor) = support.map(|h| h + t.clearance) else { return false };
        if self.position[1] >= floor {
            return false;
        }
        self.position[1] = floor;
        let speed = norm(self.velocity);
        self.velocity[1] = self.velocity[1].max(0.0);
        // Scraping never drags the plane below flying speed, so the pilot can always pull up and away.
        let slowed = (speed - t.brake * dt).max((t.cruise * 0.5).min(speed));
        let now = norm(self.velocity);
        if now > 1e-6 {
            self.velocity = scale(self.velocity, slowed.min(now) / now);
        }
        let right = self.axes[1];
        let nose = self.axes[0][1];
        if nose < 0.0 {
            turn_axes(&mut self.axes, right, -nose.asin());
        }
        self.rates[1] = self.rates[1].max(0.0);
        self.orthonormalize();
        self.refresh();
        true
    }

    /// Scenery strike: the caller keeps the pre-sweep position; the plane bleeds speed and noses up
    /// instead of crashing.
    pub fn collide(&mut self) {
        self.velocity = scale(self.velocity, 0.8);
        self.rates = [self.rates[0] * 0.5, 0.0, self.rates[2] * 0.5];
        let lift = 0.15 - self.pitch;
        if lift > 0.0 {
            let right = self.axes[1];
            turn_axes(&mut self.axes, right, lift);
        }
        self.orthonormalize();
        self.refresh();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fly_dt(p: &mut PlaneState, input: PlaneInput, seconds: f32, ground: Option<f32>, dt: f32) -> u32 {
        let t = PlaneTuning::default();
        let mut contacts = 0;
        for _ in 0..(seconds / dt).round() as u32 {
            let v = p.step(input, dt, &t).unwrap();
            for i in 0..3 {
                p.position[i] += v[i] * dt;
            }
            contacts += u32::from(p.settle(ground, &t, dt));
        }
        contacts
    }
    fn fly(p: &mut PlaneState, input: PlaneInput, seconds: f32, ground: Option<f32>) -> u32 {
        fly_dt(p, input, seconds, ground, FIXED_DT)
    }
    const IDLE: PlaneInput = PlaneInput { throttle: 0.0, roll: 0.0, pitch: 0.0, yaw: 0.0, boost: false };
    fn plane(speed: f32) -> PlaneState {
        PlaneState::new([0.0, 5000.0, 0.0], 0.0, speed).unwrap()
    }
    fn energy(p: &PlaneState) -> f32 {
        30.0 * p.position[1] + 0.5 * p.speed * p.speed
    }
    fn orthonormal(p: &PlaneState) -> bool {
        let [f, r, d] = p.axes;
        (dot(f, f) - 1.0).abs() < 1e-4 && (dot(r, r) - 1.0).abs() < 1e-4 && (dot(d, d) - 1.0).abs() < 1e-4
            && dot(f, r).abs() < 1e-4 && dot(f, d).abs() < 1e-4 && dot(cross(f, r), d) > 0.999
    }

    #[test]
    fn new_plane_is_level_with_trim_alpha_and_euler_views_round_trip() {
        let p = PlaneState::new([0.0; 3], 0.0, 150.0).unwrap();
        assert!(p.yaw.abs() < 1e-5 && p.roll.abs() < 1e-5 && (p.pitch - 0.06).abs() < 1e-4 && (p.alpha - 0.06).abs() < 1e-4);
        assert!(p.velocity[1] == 0.0 && (p.velocity[2] + 150.0).abs() < 1e-3, "flies toward -Z");
        let mut q = p;
        q.set_attitude(0.7, 0.3, -0.4);
        assert!((q.yaw - 0.7).abs() < 1e-4 && (q.pitch - 0.3).abs() < 1e-4 && (q.roll + 0.4).abs() < 1e-4);
        assert!(orthonormal(&q) && q.forward()[1] > 0.0);
    }

    #[test]
    fn trimmed_cruise_holds_altitude_speed_and_heading() {
        let mut p = plane(150.0);
        fly(&mut p, IDLE, 20.0, None);
        assert!((p.position[1] - 5000.0).abs() < 60.0 && (p.speed - 150.0).abs() < 15.0, "{} {}", p.position[1], p.speed);
        assert!(p.yaw.abs() < 1e-3 && p.roll.abs() < 1e-3 && orthonormal(&p));
    }

    #[test]
    fn lift_trims_to_one_g_at_other_speeds_too() {
        for speed in [100.0, 300.0, 700.0] {
            let mut p = plane(speed);
            p.throttle = 0.0;
            let y0 = p.position[1];
            fly(&mut p, IDLE, 1.0, None);
            let sink = y0 - p.position[1];
            assert!(sink < 0.6 * 0.5 * 30.0 + speed * 0.3, "speed {speed} sank {sink}");
            assert!(p.alpha.abs() < 0.3);
        }
    }

    #[test]
    fn angle_of_attack_is_statically_stable_and_damped() {
        let mut p = plane(150.0);
        p.set_attitude(0.0, 0.06 + 0.12, 0.0);
        let mut peak_late = 0.0f32;
        let mut peak_early = 0.0f32;
        for i in 0..(8.0 / FIXED_DT) as u32 {
            fly(&mut p, IDLE, FIXED_DT, None);
            let dev = (p.alpha - 0.06).abs();
            if i < (2.0 / FIXED_DT) as u32 { peak_early = peak_early.max(dev) } else if i > (5.0 / FIXED_DT) as u32 { peak_late = peak_late.max(dev) }
        }
        assert!(peak_early > 0.02, "the perturbation was felt");
        assert!(peak_late < 0.03, "alpha settles back to trim: {peak_late}");
    }

    #[test]
    fn roll_pitch_and_yaw_rates_damp_out() {
        for axis in 0..3 {
            let mut p = plane(150.0);
            p.rates[axis] = 1.5;
            fly(&mut p, IDLE, 3.0, None);
            if axis == 1 {
                assert!(p.rates[1].abs() < 0.2, "pitch rate {}", p.rates[1]);
            } else {
                assert!(p.rates[axis].abs() < 0.3, "axis {axis} rate {}", p.rates[axis]);
            }
        }
    }

    #[test]
    fn sideslip_is_removed_by_weathercock_and_dihedral() {
        let mut p = plane(150.0);
        let mut yawed = p;
        yawed.rates[2] = 0.0;
        yawed.set_attitude(0.15, 0.06, 0.0);
        yawed.velocity = p.velocity;
        yawed.refresh();
        assert!(yawed.beta.abs() > 0.1);
        fly(&mut yawed, IDLE, 5.0, None);
        assert!(yawed.beta.abs() < 0.03, "{}", yawed.beta);
        fly(&mut p, IDLE, 0.1, None);
    }

    #[test]
    fn steady_aileron_gives_the_commanded_roll_rate_and_right_roll_is_positive() {
        let mut p = plane(150.0);
        fly(&mut p, PlaneInput { roll: 1.0, ..IDLE }, 1.0, None);
        assert!(p.roll > 0.5 && (p.rates[0] - 1.8).abs() < 0.3, "roll {} p {}", p.roll, p.rates[0]);
        let mut l = plane(150.0);
        fly(&mut l, PlaneInput { roll: -1.0, ..IDLE }, 1.0, None);
        assert!(l.roll < -0.5);
    }

    #[test]
    fn roll_authority_is_the_same_at_boost_speed() {
        let rate = |speed: f32| {
            let mut p = plane(speed);
            fly(&mut p, PlaneInput { roll: 1.0, ..IDLE }, 0.6, None);
            p.rates[0]
        };
        let (slow, fast) = (rate(150.0), rate(1000.0));
        assert!((fast / slow - 1.0).abs() < 0.3, "{slow} vs {fast}");
    }

    #[test]
    fn banked_turn_is_coordinated_and_holds_altitude() {
        let mut p = plane(150.0);
        p.set_attitude(0.0, 0.06, 0.5);
        p.velocity = [0.0, 0.0, -150.0];
        p.refresh();
        let y0 = p.position[1];
        let yaw0 = p.yaw;
        fly(&mut p, IDLE, 1.0, None);
        let (settle_yaw, settle_roll) = (p.yaw, p.roll);
        fly(&mut p, IDLE, 2.0, None);
        let mean_roll = (settle_roll + p.roll) / 2.0;
        let measured = (p.yaw - settle_yaw) / 2.0;
        let expected = 30.0 * mean_roll.tan() / p.speed;
        assert!(settle_yaw != yaw0 && measured < 0.0, "a right bank turns right (yaw falls): {measured}");
        assert!((measured.abs() / expected - 1.0).abs() < 0.25, "turn rate {measured} vs g*tan(bank)/V {expected}");
        assert!(p.beta.abs() < 0.05, "beta {}", p.beta);
        assert!((p.position[1] - y0).abs() < 60.0, "altitude {}", p.position[1] - y0);
    }

    #[test]
    fn pulling_back_climbs_and_pushing_dives() {
        let mut up = plane(150.0);
        fly(&mut up, PlaneInput { pitch: 1.0, ..IDLE }, 2.0, None);
        assert!(up.pitch > 0.3 && up.position[1] > 5000.0 + 30.0, "{} {}", up.pitch, up.position[1]);
        let mut down = plane(150.0);
        fly(&mut down, PlaneInput { pitch: -1.0, ..IDLE }, 2.0, None);
        assert!(down.pitch < -0.1 && down.position[1] < 5000.0);
    }

    #[test]
    fn stall_drops_the_nose_and_recovers_once_speed_returns() {
        let mut p = plane(45.0);
        p.set_attitude(0.0, 0.9, 0.0);
        p.throttle = 0.0;
        let (mut min_pitch, mut peak_alpha) = (1.0f32, 0.0f32);
        for _ in 0..(20.0 / FIXED_DT) as u32 {
            fly(&mut p, IDLE, FIXED_DT, None);
            min_pitch = min_pitch.min(p.pitch);
            peak_alpha = peak_alpha.max(p.alpha.abs());
            assert!(p.alpha.is_finite() && orthonormal(&p));
        }
        assert!(peak_alpha > 0.3 || min_pitch < 0.0, "stalled: alpha {peak_alpha} pitch {min_pitch}");
        assert!(min_pitch < 0.2, "the nose fell through: {min_pitch}");
        assert!(p.speed > 55.0 && p.alpha.abs() < PlaneTuning::default().stall_alpha, "recovered: speed {} alpha {}", p.speed, p.alpha);
    }

    #[test]
    fn throttle_follows_shift_and_ctrl_and_sets_the_speed() {
        let mut p = plane(150.0);
        fly(&mut p, PlaneInput { throttle: 1.0, ..IDLE }, 3.0, None);
        assert!((p.throttle - 1.0).abs() < 1e-3 || p.throttle > 0.9, "{}", p.throttle);
        fly(&mut p, IDLE, 25.0, None);
        assert!(p.speed > 300.0 && p.speed < 600.0, "full throttle: {}", p.speed);
        fly(&mut p, PlaneInput { throttle: -1.0, ..IDLE }, 4.0, None);
        assert!(p.throttle == 0.0);
        fly(&mut p, IDLE, 20.0, None);
        assert!(p.speed < 250.0, "idle slows the plane: {}", p.speed);
    }

    #[test]
    fn boost_exceeds_full_throttle_drains_and_caps() {
        let boost = PlaneInput { boost: true, throttle: 1.0, ..IDLE };
        let mut p = plane(150.0);
        fly(&mut p, boost, 3.0, None);
        assert!(p.speed > 300.0 && p.boost_reserve < 1.0, "{} {}", p.speed, p.boost_reserve);
        fly(&mut p, boost, 30.0, None);
        assert!(p.speed <= 1000.0 + 1e-2 && p.boost_reserve < 0.01);
        fly(&mut p, PlaneInput { throttle: 1.0, ..IDLE }, 40.0, None);
        assert!(p.speed < 600.0, "drag pulls speed back: {}", p.speed);
        assert!(p.boost_reserve > 0.0);
    }

    #[test]
    fn unpowered_flight_never_gains_energy() {
        let mut p = plane(300.0);
        p.throttle = 0.0;
        p.set_attitude(0.0, 0.3, 0.7);
        let mut last = energy(&p);
        for _ in 0..(20.0 / FIXED_DT) as u32 {
            fly(&mut p, PlaneInput { roll: 0.2, pitch: 0.3, ..IDLE }, FIXED_DT, None);
            let e = energy(&p);
            assert!(e <= last + 0.05 * last.abs().max(1.0) * 1e-3 + 1.0, "energy rose {last} -> {e}");
            last = e;
        }
    }

    #[test]
    fn results_agree_across_time_steps() {
        let run = |dt: f32| {
            let mut p = plane(150.0);
            fly_dt(&mut p, PlaneInput { roll: 0.5, pitch: 0.4, throttle: 0.3, ..IDLE }, 4.0, None, dt);
            p
        };
        let (a, b, c) = (run(1.0 / 120.0), run(1.0 / 60.0), run(1.0 / 30.0));
        for o in [b, c] {
            assert!((a.speed - o.speed).abs() < 8.0 && (a.yaw - o.yaw).abs() < 0.08 && (a.pitch - o.pitch).abs() < 0.08, "{a:?}\n{o:?}");
            assert!((a.position[1] - o.position[1]).abs() < 25.0);
        }
    }

    #[test]
    fn violent_input_never_produces_nan_or_breaks_the_basis() {
        let mut p = plane(150.0);
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        };
        for i in 0..(120.0 / FIXED_DT) as u32 {
            let input = PlaneInput { throttle: rnd(), roll: rnd().signum(), pitch: rnd().signum(), yaw: rnd().signum(), boost: i % 700 < 300 };
            let dt = [FIXED_DT, 1.0 / 60.0, 1.0 / 30.0][(i % 3) as usize];
            let t = PlaneTuning::default();
            let v = p.step(input, dt, &t).unwrap();
            for k in 0..3 {
                p.position[k] += v[k] * dt;
            }
            assert!(p.speed <= 1000.0 + 1e-2 && orthonormal(&p) && p.position.iter().all(|x| x.is_finite()));
        }
    }

    // Time (s) a held pull takes to first reach `target` pitch, and the peak pitch rate on the way.
    fn pull_to(speed: f32, boost: bool, target: f32, ground: Option<f32>) -> (f32, f32) {
        let mut p = if ground.is_some() { PlaneState::new([0.0, 3.0, 0.0], 0.0, speed).unwrap() } else { plane(speed) };
        let (mut peak_rate, mut prev) = (0.0f32, p.pitch);
        for i in 0..(15.0 / FIXED_DT) as u32 {
            fly(&mut p, PlaneInput { pitch: 1.0, throttle: 1.0, boost, ..IDLE }, FIXED_DT, ground);
            peak_rate = peak_rate.max((p.pitch - prev) / FIXED_DT);
            prev = p.pitch;
            if p.pitch >= target {
                return (i as f32 * FIXED_DT, peak_rate);
            }
        }
        (f32::INFINITY, peak_rate)
    }

    #[test]
    fn held_pull_rotates_quickly_at_cruise_and_boost() {
        for (speed, boost) in [(150.0, false), (300.0, true)] {
            let (t30, rate) = pull_to(speed, boost, 0.52, None);
            assert!(t30 < 1.4, "30 deg climb in {t30}s at {speed}");
            assert!(rate > 0.45, "pitch rate {rate} rad/s at {speed}");
        }
    }

    #[test]
    fn takeoff_rotation_from_the_airfield_climbs_out() {
        let (t, _) = pull_to(90.0, false, 0.35, Some(0.0));
        assert!(t < 2.5, "rotation to 20 deg took {t}s");
    }

    #[test]
    fn held_pull_completes_a_loop_in_bounded_time() {
        for (speed, boost, limit) in [(150.0, false, 10.5), (400.0, true, 10.5)] {
            let mut p = plane(speed);
            let (mut passed_top, mut done) = (false, None);
            for i in 0..(14.0 / FIXED_DT) as u32 {
                fly(&mut p, PlaneInput { pitch: 1.0, throttle: 1.0, boost, ..IDLE }, FIXED_DT, None);
                passed_top |= p.axes[2][1] > 0.5;
                if passed_top && p.axes[0][1].abs() < 0.2 && p.axes[2][1] < -0.5 {
                    done = Some(i as f32 * FIXED_DT);
                    break;
                }
            }
            assert!(done.is_some_and(|t| t < limit), "loop at {speed}: {done:?}");
        }
    }
    #[test]
    fn loops_pass_through_the_vertical() {
        let mut p = plane(300.0);
        let mut peak = 0.0f32;
        for _ in 0..(12.0 / FIXED_DT) as u32 {
            fly(&mut p, PlaneInput { pitch: 1.0, throttle: 1.0, ..IDLE }, FIXED_DT, None);
            peak = peak.max(p.pitch);
        }
        assert!(peak > 1.2 && orthonormal(&p), "{peak}");
    }

    #[test]
    fn ground_is_never_penetrated_and_scrape_reports_contact() {
        let mut p = PlaneState::new([0.0, 10.0, 0.0], 0.0, 150.0).unwrap();
        let contacts = fly(&mut p, PlaneInput { pitch: -1.0, ..IDLE }, 3.0, Some(0.0));
        assert!(contacts > 0 && p.position[1] >= 3.0 - 1e-4 && p.pitch >= -1e-4 && p.velocity[1] >= -1e-4, "{contacts} {p:?}");
        assert!(orthonormal(&p));
    }

    #[test]
    fn slow_plane_settles_onto_the_skim_height() {
        let mut p = PlaneState::new([0.0, 20.0, 0.0], 0.0, 10.0).unwrap();
        fly(&mut p, IDLE, 6.0, Some(0.0));
        assert!((p.position[1] - 3.0).abs() < 1e-3);
    }

    #[test]
    fn scenery_strike_bleeds_speed_and_noses_up() {
        let mut p = PlaneState::new([0.0, 100.0, 0.0], 0.0, 200.0).unwrap();
        p.set_attitude(0.0, -0.3, 0.0);
        p.collide();
        assert!((p.speed - 160.0).abs() < 1e-3 && p.pitch >= 0.15 - 1e-4 && orthonormal(&p));
    }

    #[test]
    fn invalid_input_and_tuning_are_rejected_atomically() {
        let t = PlaneTuning::default();
        let mut p = plane(100.0);
        let before = p;
        assert_eq!(p.step(PlaneInput { throttle: f32::NAN, ..IDLE }, FIXED_DT, &t), Err(StepError::InvalidInput));
        assert_eq!(p.step(IDLE, 0.0, &t), Err(StepError::InvalidDt));
        assert_eq!(p.step(IDLE, 0.1, &t), Err(StepError::InvalidDt));
        assert_eq!(p, before);
        assert!(PlaneTuning { stall_alpha: 0.01, ..t }.validate().is_err());
        assert!(PlaneTuning { cruise: 0.0, ..t }.validate().is_err());
        assert!(t.validate().is_ok());
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut p = PlaneState::new([1.0, 300.0, 2.0], 0.3, 120.0).unwrap();
            fly(&mut p, PlaneInput { roll: 0.5, pitch: 0.2, ..IDLE }, 5.0, None);
            p
        };
        assert_eq!(run(), run());
    }

    // ---- keyboard pilot: digital -1/0/1 keys held for whole seconds, like the browser sends them ----
    fn hold(p: &mut PlaneState, input: PlaneInput, seconds: f32, ground: Option<f32>, dt: f32) {
        fly_dt(p, input, seconds, ground, dt);
    }
    fn keys(roll: f32, pitch: f32, yaw: f32) -> PlaneInput {
        PlaneInput { roll, pitch, yaw, ..IDLE }
    }
    fn alt(p: &PlaneState) -> f32 {
        p.position[1] - 5000.0
    }
    /// Signed heading change in radians, positive to the right.
    fn turned(from: f32, p: &PlaneState) -> f32 {
        let d = from - p.yaw;
        (d + std::f32::consts::PI).rem_euclid(2.0 * std::f32::consts::PI) - std::f32::consts::PI
    }
    const DTS: [f32; 3] = [1.0 / 30.0, 1.0 / 60.0, 1.0 / 120.0];

    #[test]
    fn every_axis_has_the_documented_sign() {
        let mut up = plane(150.0);
        hold(&mut up, keys(0.0, 1.0, 0.0), 0.5, None, FIXED_DT);
        assert!(up.rates[1] > 0.1 && up.pitch > 0.1, "W pitches up: {:?}", up.rates);
        hold(&mut up, IDLE, 2.0, None, FIXED_DT);
        assert!(alt(&up) > 5.0, "and climbs");
        let mut down = plane(150.0);
        hold(&mut down, keys(0.0, -1.0, 0.0), 0.5, None, FIXED_DT);
        assert!(down.rates[1] < -0.1 && down.pitch < 0.0, "S pitches down: {:?}", down.rates);
        hold(&mut down, IDLE, 2.0, None, FIXED_DT);
        assert!(alt(&down) < -5.0, "and descends");
        let mut right = plane(150.0);
        hold(&mut right, keys(1.0, 0.0, 0.0), 0.4, None, FIXED_DT);
        assert!(right.rates[0] > 0.3 && right.roll > 0.0, "D rolls right");
        hold(&mut right, IDLE, 2.0, None, FIXED_DT);
        assert!(turned(0.0, &right) > 0.0, "a right bank turns right");
        let mut left = plane(150.0);
        hold(&mut left, keys(-1.0, 0.0, 0.0), 0.4, None, FIXED_DT);
        assert!(left.rates[0] < -0.3 && left.roll < 0.0, "A rolls left");
        hold(&mut left, IDLE, 2.0, None, FIXED_DT);
        assert!(turned(0.0, &left) < 0.0, "a left bank turns left");
        let mut e = plane(150.0);
        hold(&mut e, keys(0.0, 0.0, 1.0), 0.6, None, FIXED_DT);
        assert!(e.rates[2] > 0.1 && turned(0.0, &e) > 0.02, "E yaws right");
        let mut q = plane(150.0);
        hold(&mut q, keys(0.0, 0.0, -1.0), 0.6, None, FIXED_DT);
        assert!(q.rates[2] < -0.1 && turned(0.0, &q) < -0.02, "Q yaws left");
    }

    #[test]
    fn digital_keys_ramp_instead_of_snapping() {
        let mut p = plane(150.0);
        let t = PlaneTuning::default();
        p.step(keys(1.0, 1.0, 1.0), FIXED_DT, &t).unwrap();
        assert!(p.stick.iter().all(|s| *s > 0.0 && *s < 0.1), "{:?}", p.stick);
        hold(&mut p, keys(1.0, 1.0, 1.0), 1.0, None, FIXED_DT);
        assert!(p.stick.iter().all(|s| (*s - 1.0).abs() < 1e-5));
    }

    #[test]
    fn releasing_the_sticks_returns_to_steady_level_flight() {
        for (name, input) in [
            ("roll", keys(1.0, 0.0, 0.0)),
            ("climb", keys(0.0, 1.0, 0.0)),
            ("dive", keys(0.0, -1.0, 0.0)),
            ("yaw", keys(0.0, 0.0, 1.0)),
            ("mixed", keys(-1.0, 1.0, 1.0)),
        ] {
            for dt in DTS {
                let mut p = plane(150.0);
                hold(&mut p, input, 0.5, None, dt);
                hold(&mut p, IDLE, 25.0, None, dt);
                let gamma = (p.velocity[1] / p.speed).asin();
                assert!(p.roll.abs() < 0.1 && gamma.abs() < 0.03, "{name} dt {dt}: roll {} gamma {gamma}", p.roll);
                assert!(p.beta.abs() < 0.02 && p.rates.iter().all(|r| r.abs() < 0.02), "{name} dt {dt}: {:?}", p.rates);
                assert!((p.speed - 150.0).abs() < 40.0 && alt(&p).abs() < 120.0, "{name}: speed {} alt {}", p.speed, alt(&p));
            }
        }
    }

    #[test]
    fn hands_off_cruise_holds_altitude_heading_and_speed_for_a_minute() {
        for dt in DTS {
            let mut p = plane(150.0);
            p.throttle = 0.4;
            hold(&mut p, IDLE, 20.0, None, dt);
            let (a0, s0, y0) = (alt(&p), p.speed, p.yaw);
            let (mut amin, mut amax, mut smin, mut smax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
            for _ in 0..60 {
                hold(&mut p, IDLE, 1.0, None, dt);
                amin = amin.min(alt(&p));
                amax = amax.max(alt(&p));
                smin = smin.min(p.speed);
                smax = smax.max(p.speed);
            }
            assert!(amax - amin < 25.0 && (alt(&p) - a0).abs() < 25.0, "dt {dt}: altitude {amin}..{amax}");
            assert!(smax - smin < 15.0 && (p.speed - s0).abs() < 15.0, "dt {dt}: speed {smin}..{smax}");
            assert!((p.yaw - y0).abs() < 1e-3 && p.roll.abs() < 1e-3, "no drift in heading or bank");
        }
    }

    #[test]
    fn hands_off_recovers_from_perturbations() {
        let mut p = plane(150.0);
        p.set_attitude(0.0, 0.4, 0.8);
        p.rates = [0.5, -0.3, 0.2];
        hold(&mut p, IDLE, 30.0, None, FIXED_DT);
        let gamma = (p.velocity[1] / p.speed).asin();
        assert!(p.roll.abs() < 0.1 && gamma.abs() < 0.05 && p.rates.iter().all(|r| r.abs() < 0.02), "{} {gamma}", p.roll);
        let mut sideways = plane(150.0);
        sideways.velocity = [60.0, 0.0, -140.0];
        sideways.set_attitude(0.0, 0.0, 0.0);
        hold(&mut sideways, IDLE, 20.0, None, FIXED_DT);
        assert!(sideways.beta.abs() < 0.03, "{}", sideways.beta);
    }

    #[test]
    fn full_throttle_and_boost_stay_controllable() {
        for boost in [false, true] {
            let go = PlaneInput { throttle: 1.0, boost, ..IDLE };
            let mut p = plane(150.0);
            hold(&mut p, go, 8.0, None, FIXED_DT);
            assert!(p.speed > 300.0, "fast: {}", p.speed);
            let (r0, a0) = (p.roll, alt(&p));
            hold(&mut p, PlaneInput { roll: 1.0, ..go }, 0.3, None, FIXED_DT);
            assert!(p.roll > r0 + 0.1 && p.rates[0] > 0.3, "ailerons work at {} yd/s", p.speed);
            hold(&mut p, PlaneInput { roll: -1.0, ..go }, 0.3, None, FIXED_DT);
            hold(&mut p, go, 6.0, None, FIXED_DT);
            assert!(p.roll.abs() < 0.2 && p.alpha.abs() < p_stall() && (alt(&p) - a0).abs() < 500.0, "{} {} {}", p.roll, p.alpha, alt(&p));
            let mut nose = p;
            hold(&mut nose, PlaneInput { pitch: 1.0, ..go }, 0.5, None, FIXED_DT);
            assert!(nose.rates[1] > 0.05, "elevator works at {} yd/s: {:?}", p.speed, nose.rates);
        }
    }
    fn p_stall() -> f32 {
        PlaneTuning::default().stall_alpha
    }

    #[test]
    fn a_keyboard_tap_makes_a_gentle_coordinated_turn_that_holds_altitude() {
        for dt in DTS {
            let mut p = plane(150.0);
            p.throttle = 0.4;
            let y0 = p.yaw;
            hold(&mut p, keys(1.0, 0.0, 0.0), 0.4, None, dt);
            let a0 = alt(&p);
            let mut worst_beta = 0.0f32;
            for _ in 0..8 {
                hold(&mut p, IDLE, 1.0, None, dt);
                worst_beta = worst_beta.max(p.beta.abs());
            }
            assert!(turned(y0, &p) > 0.2, "dt {dt}: heading change {}", turned(y0, &p));
            assert!(worst_beta < 0.08 && p.roll.abs() < 0.5, "slip {worst_beta} bank {}", p.roll);
            assert!((alt(&p) - a0).abs() < 30.0, "altitude drift {}", alt(&p) - a0);
        }
    }

    #[test]
    fn held_roll_and_hold_pitch_is_a_coordinated_sustained_turn() {
        let mut p = plane(150.0);
        p.throttle = 0.4;
        let y0 = p.yaw;
        hold(&mut p, keys(1.0, 0.0, 0.0), 0.5, None, FIXED_DT);
        hold(&mut p, keys(0.0, 0.2, 0.0), 6.0, None, FIXED_DT);
        assert!(turned(y0, &p) > 0.4 && p.beta.abs() < 0.1, "{} {}", turned(y0, &p), p.beta);
        assert!(alt(&p).abs() < 200.0, "{}", alt(&p));
    }

    #[test]
    fn holding_pull_loops_and_holding_roll_barrel_rolls_without_nan() {
        let mut p = plane(220.0);
        p.throttle = 1.0;
        let mut peak = -1.0f32;
        for _ in 0..(12.0 / FIXED_DT) as u32 {
            hold(&mut p, PlaneInput { throttle: 0.0, pitch: 1.0, ..IDLE }, FIXED_DT, None, FIXED_DT);
            peak = peak.max(alt(&p));
            assert!(orthonormal(&p) && p.position.iter().all(|v| v.is_finite()));
        }
        assert!(peak > 150.0, "the loop went up: {peak}");
        let mut r = plane(150.0);
        let mut turns = 0.0;
        let mut last = r.roll;
        for _ in 0..(5.0 / FIXED_DT) as u32 {
            hold(&mut r, keys(1.0, 0.0, 0.0), FIXED_DT, None, FIXED_DT);
            turns += (r.roll - last + std::f32::consts::PI).rem_euclid(2.0 * std::f32::consts::PI) - std::f32::consts::PI;
            last = r.roll;
        }
        assert!(turns > 2.0 * std::f32::consts::PI, "a full aileron roll: {turns}");
    }

    #[test]
    fn climb_and_dive_entries_recover_hands_off() {
        for sign in [1.0f32, -1.0] {
            let mut p = plane(150.0);
            p.throttle = 0.5;
            hold(&mut p, keys(0.0, sign, 0.0), 1.2, None, FIXED_DT);
            let entry = (p.velocity[1] / p.speed).asin();
            assert!(entry * sign > 0.1, "entered: {entry}");
            hold(&mut p, IDLE, 15.0, None, FIXED_DT);
            assert!((p.velocity[1] / p.speed).asin().abs() < 0.04, "levelled: {}", p.velocity[1] / p.speed);
        }
    }

    #[test]
    fn keyboard_stall_entry_and_recovery() {
        let mut p = plane(110.0);
        p.throttle = 0.0;
        let mut stalled = false;
        for _ in 0..(10.0 / FIXED_DT) as u32 {
            hold(&mut p, PlaneInput { throttle: -1.0, pitch: 1.0, ..IDLE }, FIXED_DT, None, FIXED_DT);
            stalled |= p.alpha > p_stall() * 0.9;
        }
        assert!(stalled, "holding the nose up stalls");
        hold(&mut p, PlaneInput { throttle: 1.0, pitch: -1.0, ..IDLE }, 4.0, None, FIXED_DT);
        hold(&mut p, PlaneInput { throttle: 1.0, ..IDLE }, 12.0, None, FIXED_DT);
        assert!(p.alpha.abs() < p_stall() && p.speed > 100.0 && orthonormal(&p), "recovered {} {}", p.alpha, p.speed);
    }

    #[test]
    fn yaw_only_turns_flat_and_settles() {
        let mut p = plane(150.0);
        p.throttle = 0.4;
        hold(&mut p, keys(0.0, 0.0, 1.0), 2.0, None, FIXED_DT);
        assert!(turned(0.0, &p) > 0.2 && p.roll.abs() < 0.5, "{} {}", turned(0.0, &p), p.roll);
        hold(&mut p, IDLE, 12.0, None, FIXED_DT);
        assert!(p.beta.abs() < 0.02 && p.rates[2].abs() < 0.02);
    }

    #[test]
    fn low_speed_flight_stays_flyable() {
        let mut p = plane(90.0);
        p.throttle = 0.0;
        hold(&mut p, keys(1.0, 0.0, 0.0), 0.3, None, FIXED_DT);
        hold(&mut p, IDLE, 10.0, None, FIXED_DT);
        assert!(p.speed.is_finite() && p.alpha.abs() < 0.4 && orthonormal(&p));
        let mut climb = plane(90.0);
        hold(&mut climb, PlaneInput { throttle: 1.0, ..IDLE }, 8.0, None, FIXED_DT);
        assert!(climb.speed > 130.0, "throttle recovers speed: {}", climb.speed);
    }

    #[test]
    fn bang_bang_key_mashing_stays_bounded_and_lets_go_cleanly() {
        for dt in DTS {
            let mut p = plane(150.0);
            let (mut seed, mut worst) = (7u32, 0.0f32);
            for step in 0..(30.0 / dt) as u32 {
                if step % (0.25 / dt).round() as u32 == 0 {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                }
                let k = |shift: u32| (((seed >> shift) % 3) as f32) - 1.0;
                hold(&mut p, PlaneInput { roll: k(8), pitch: k(12) * 0.5, yaw: k(16), throttle: k(20), boost: seed & 4 != 0 }, dt, None, dt);
                worst = worst.max(p.speed);
                assert!(orthonormal(&p) && p.position.iter().all(|v| v.is_finite()) && p.speed <= 1000.5);
            }
            hold(&mut p, PlaneInput { throttle: -1.0, ..IDLE }, 20.0, None, dt);
            hold(&mut p, IDLE, 40.0, None, dt);
            assert!(p.rates.iter().all(|r| r.abs() < 0.05), "dt {dt}: {:?}", p.rates);
        }
    }

    #[test]
    fn a_keyboard_dive_into_the_ground_skims_without_crashing() {
        let mut p = plane(150.0);
        p.position[1] = 60.0;
        let t = PlaneTuning::default();
        let mut contacts = 0;
        for i in 0..(10.0 / FIXED_DT) as u32 {
            let input = if i < 360 { keys(0.0, -1.0, 0.0) } else { keys(0.0, 0.0, 0.0) };
            contacts += fly_dt_ground(&mut p, input, &t);
            assert!(p.position[1] >= t.clearance - 1e-3, "never below the skim height: {}", p.position[1]);
        }
        assert!(contacts > 0 && orthonormal(&p), "{contacts}");
        for _ in 0..(8.0 / FIXED_DT) as u32 {
            fly_dt_ground(&mut p, PlaneInput { throttle: 1.0, pitch: 0.5, ..IDLE }, &t);
        }
        assert!(p.position[1] > 20.0, "takes off again: {:?}", p.position);
    }
    fn fly_dt_ground(p: &mut PlaneState, input: PlaneInput, t: &PlaneTuning) -> u32 {
        let v = p.step(input, FIXED_DT, t).unwrap();
        for i in 0..3 {
            p.position[i] += v[i] * FIXED_DT;
        }
        u32::from(p.settle(Some(0.0), t, FIXED_DT))
    }

    #[test]
    fn scraping_never_drags_a_flying_plane_below_flying_speed() {
        let t = PlaneTuning::default();
        let mut p = plane(150.0);
        p.position[1] = 3.0;
        for _ in 0..600 {
            p.step(keys(0.0, -1.0, 0.0), FIXED_DT, &t).unwrap();
            p.settle(Some(0.0), &t, FIXED_DT);
        }
        assert!(p.speed >= t.cruise * 0.5 - 1.0, "{}", p.speed);
    }
}