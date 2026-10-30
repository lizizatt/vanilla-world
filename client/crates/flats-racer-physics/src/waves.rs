//! Deterministic analytic Gerstner sea (design/ocean.md section 4). Mirrors `browser/wave-math.js`; the numbers
//! come from `browser/wave-config.js` through `Params::from_array` (the single source is JS).
//!
//! The surface is a pure function of (x, z, tick): no state, no randomness. A Gerstner crest moves vertices
//! horizontally, so the height at a fixed (x, z) needs the rest point p0 with `p0 + D(p0, t) = (x, z)`; it is
//! found by exactly `INVERSION_ITERATIONS` fixed-point steps (never "until converged") so every implementation has
//! the same structure and the same bits. Amplitude scale and shore fade are evaluated at p0.

use std::f64::consts::TAU;

pub const MAX_COMPONENTS: usize = 6;
pub const MAX_DISCS: usize = 16;
pub const INVERSION_ITERATIONS: usize = 3;
/// Sum of steepness*k*amplitude (times the largest region scale) must stay below this: the displacement map is then
/// a contraction, so crests never loop.
pub const CONTRACTION_LIMIT: f64 = 0.9;
/// Wave clock rate; equals the fixed physics tick rate.
pub const TICKS_PER_SECOND: u64 = 120;
pub const PARAMS_VERSION: f64 = 1.0;
const FLOATS_PER_COMPONENT: usize = 7;
const FLOATS_PER_DISC: usize = 6;
const HEADER: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Component {
    /// Wavenumber (rad/yd) and angular frequency (rad/s); `omega * period / 2pi` must be an integer.
    pub k: f64,
    pub omega: f64,
    pub dir: [f64; 2],
    pub amp: f64,
    pub steepness: f64,
    pub phase: f64,
}

/// A radial amplitude region: `scale` inside `inner`, 1 beyond `outer`, smoothstep between. Discs are blended in order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Disc {
    pub centre: [f64; 2],
    pub inner: f64,
    pub outer: f64,
    pub scale: f64,
    pub slope_cap: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Master period (s); the wave clock wraps here with zero discontinuity.
    pub period: f64,
    /// Waves grow from nothing over this many yd of open sea beyond `shore_margin` from land.
    pub shore_fade: f64,
    pub shore_margin: f64,
    pub default_slope_cap: f64,
    pub components: Vec<Component>,
    pub discs: Vec<Disc>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub height: f64,
    pub normal: [f64; 3],
    /// Velocity of the water surface point (horizontal orbital motion and dh/dt).
    pub velocity: [f64; 3],
    /// Amplitude multiplier at the rest point: region scale times shore fade.
    pub amp_k: f64,
}

pub const FLAT: Sample = Sample {
    height: 0.0,
    normal: [0.0, 1.0, 0.0],
    velocity: [0.0; 3],
    amp_k: 0.0,
};

fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    let s = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    s * s * (3.0 - 2.0 * s)
}

impl Params {
    /// Layout: `[version, period, shore_fade, shore_margin, default_slope_cap, n, n*(k, omega, dx, dz, amp,
    /// steepness, phase), m, m*(cx, cz, inner, outer, scale, slope_cap)]`.
    pub fn from_array(a: &[f64]) -> Result<Self, String> {
        if a.len() < HEADER + 1 || a[0] != PARAMS_VERSION {
            return Err("Unsupported wave parameters".into());
        }
        let n = a[5];
        if !(1.0..=MAX_COMPONENTS as f64).contains(&n) || n.fract() != 0.0 {
            return Err("Wave component count out of range".into());
        }
        let n = n as usize;
        let disc_at = HEADER + n * FLOATS_PER_COMPONENT;
        if a.len() <= disc_at || a[disc_at] < 0.0 || a[disc_at] > MAX_DISCS as f64 || a[disc_at].fract() != 0.0 {
            return Err("Wave region count out of range".into());
        }
        let m = a[disc_at] as usize;
        if a.len() != disc_at + 1 + m * FLOATS_PER_DISC {
            return Err("Wave parameter length mismatch".into());
        }
        let components = a[HEADER..disc_at]
            .chunks(FLOATS_PER_COMPONENT)
            .map(|c| Component {
                k: c[0],
                omega: c[1],
                dir: [c[2], c[3]],
                amp: c[4],
                steepness: c[5],
                phase: c[6],
            })
            .collect();
        let discs = a[disc_at + 1..]
            .chunks(FLOATS_PER_DISC)
            .map(|d| Disc {
                centre: [d[0], d[1]],
                inner: d[2],
                outer: d[3],
                scale: d[4],
                slope_cap: d[5],
            })
            .collect();
        let params = Self {
            period: a[1],
            shore_fade: a[2],
            shore_margin: a[3],
            default_slope_cap: a[4],
            components,
            discs,
        };
        params.validate()?;
        Ok(params)
    }

    /// Sum of amplitude*k: the largest slope of the unscaled field.
    pub fn slope_sum(&self) -> f64 {
        self.components.iter().map(|c| c.amp * c.k).sum()
    }

    fn contraction_sum(&self) -> f64 {
        self.components.iter().map(|c| c.steepness * c.amp * c.k).sum()
    }

    fn displacement_sum(&self) -> f64 {
        self.components.iter().map(|c| c.steepness * c.amp).sum()
    }

    pub fn max_scale(&self) -> f64 {
        self.discs.iter().fold(1.0, |s, d| s.max(d.scale))
    }

    /// Largest horizontal rest-to-surface offset any query can see (yd).
    pub fn max_displacement(&self) -> f64 {
        self.displacement_sum() * self.max_scale()
    }

    pub fn validate(&self) -> Result<(), String> {
        let finite = |v: f64| v.is_finite();
        if !(finite(self.period) && self.period > 0.0 && self.period <= 86_400.0)
            || (self.period * TICKS_PER_SECOND as f64).fract() != 0.0
        {
            return Err("Wave period must be a whole number of ticks".into());
        }
        if !(finite(self.shore_fade) && self.shore_fade > 0.0 && finite(self.shore_margin) && self.shore_margin >= 0.0)
            || !(finite(self.default_slope_cap) && self.default_slope_cap > 0.0)
        {
            return Err("Invalid wave shore or slope settings".into());
        }
        if self.components.is_empty() || self.components.len() > MAX_COMPONENTS {
            return Err("Wave component count out of range".into());
        }
        for c in &self.components {
            let n = c.omega * self.period / TAU;
            if ![c.k, c.omega, c.dir[0], c.dir[1], c.amp, c.steepness, c.phase].iter().all(|v| finite(*v))
                || c.k <= 0.0
                || c.omega <= 0.0
                || c.amp < 0.0
                || c.amp > 100.0
                || !(0.0..=1.0).contains(&c.steepness)
                || (c.dir[0].hypot(c.dir[1]) - 1.0).abs() > 1e-9
                || (n - n.round()).abs() > 1e-6
            {
                return Err("Invalid wave component".into());
            }
        }
        if self.discs.len() > MAX_DISCS {
            return Err("Too many wave regions".into());
        }
        for d in &self.discs {
            if ![d.centre[0], d.centre[1], d.inner, d.outer, d.scale, d.slope_cap].iter().all(|v| finite(*v))
                || d.centre.iter().any(|v| v.abs() > 1.0e8)
                || d.inner < 0.0
                || d.outer <= d.inner
                || !(0.0..=20.0).contains(&d.scale)
                || d.slope_cap <= 0.0
            {
                return Err("Invalid wave region".into());
            }
            if self.slope_sum() * d.scale > d.slope_cap + 1e-12 {
                return Err("Wave region exceeds its slope cap".into());
            }
        }
        if self.slope_sum() > self.default_slope_cap + 1e-12 {
            return Err("Default sea exceeds its slope cap".into());
        }
        if self.contraction_sum() * self.max_scale() > CONTRACTION_LIMIT {
            return Err("Waves would loop (contraction limit exceeded)".into());
        }
        Ok(())
    }

    /// Clock value (s, in [0, period)) for a tick count; the modulo is exact in integers.
    pub fn time_at(&self, ticks: u64) -> f64 {
        let wrap = (self.period * TICKS_PER_SECOND as f64) as u64;
        (ticks % wrap) as f64 / TICKS_PER_SECOND as f64
    }

    /// Blended region amplitude scale at p (before shore fade).
    pub fn region_scale(&self, p: [f64; 2]) -> f64 {
        let mut s = 1.0;
        for d in &self.discs {
            let w = 1.0 - smoothstep(d.inner, d.outer, (p[0] - d.centre[0]).hypot(p[1] - d.centre[1]));
            s += (d.scale - s) * w;
        }
        s
    }

    pub fn shore_k(&self, land_distance: f64) -> f64 {
        if land_distance.is_infinite() && land_distance > 0.0 {
            return 1.0;
        }
        smoothstep(0.0, self.shore_fade, land_distance - self.shore_margin)
    }

    /// Hook for a later animated whirlpool: an offset (yd) added to the query before the surface is evaluated.
    /// Always zero today. A real swirl must also correct the normal and velocity for the warp's Jacobian.
    pub fn swirl(&self, _p: [f64; 2], _t: f64) -> [f64; 2] {
        [0.0, 0.0]
    }

    fn amp_k(&self, p0: [f64; 2], land: &impl Fn([f64; 2]) -> f64) -> f64 {
        self.region_scale(p0) * self.shore_k(land(p0))
    }

    /// Surface sample at (x, z) and wave-clock time `t` (seconds in [0, period)). `land` is the distance in yd from a
    /// point to the nearest land or authored water (`f64::INFINITY` for none); it is 1-Lipschitz by construction.
    pub fn sample(&self, p: [f64; 2], t: f64, land: &impl Fn([f64; 2]) -> f64) -> Sample {
        let warp = self.swirl(p, t);
        let p = [p[0] + warp[0], p[1] + warp[1]];
        // Fully faded: even the farthest rest point is inside the shore margin, so the surface is exactly flat.
        if land(p) - self.max_displacement() <= self.shore_margin {
            return FLAT;
        }
        let mut p0 = p;
        for _ in 0..INVERSION_ITERATIONS {
            let m = self.amp_k(p0, land);
            let mut d = [0.0, 0.0];
            for c in &self.components {
                let theta = c.k * (c.dir[0] * p0[0] + c.dir[1] * p0[1]) - c.omega * t + c.phase;
                let f = m * c.steepness * c.amp * theta.cos();
                d[0] += f * c.dir[0];
                d[1] += f * c.dir[1];
            }
            p0 = [p[0] - d[0], p[1] - d[1]];
        }
        let m = self.amp_k(p0, land);
        let mut height = 0.0;
        let mut grad = [0.0, 0.0];
        let mut s = [0.0, 0.0, 0.0];
        let mut vel = [0.0, 0.0, 0.0];
        for c in &self.components {
            let theta = c.k * (c.dir[0] * p0[0] + c.dir[1] * p0[1]) - c.omega * t + c.phase;
            let (sin, cos) = theta.sin_cos();
            let a = m * c.amp;
            height += a * sin;
            grad[0] += a * c.k * cos * c.dir[0];
            grad[1] += a * c.k * cos * c.dir[1];
            let q = c.steepness * a * c.k * sin;
            s[0] += q * c.dir[0] * c.dir[0];
            s[1] += q * c.dir[0] * c.dir[1];
            s[2] += q * c.dir[1] * c.dir[1];
            vel[0] += c.steepness * a * c.omega * sin * c.dir[0];
            vel[1] -= a * c.omega * cos;
            vel[2] += c.steepness * a * c.omega * sin * c.dir[1];
        }
        // Gradient of the height field at fixed (x, z): (I - S)^-1 grad(h), S symmetric.
        let (ja, jb, jc) = (1.0 - s[0], -s[1], 1.0 - s[2]);
        let det = ja * jc - jb * jb;
        let gx = (jc * grad[0] - jb * grad[1]) / det;
        let gz = (-jb * grad[0] + ja * grad[1]) / det;
        let inv = 1.0 / (gx * gx + 1.0 + gz * gz).sqrt();
        Sample {
            height,
            normal: [-gx * inv, inv, -gz * inv],
            velocity: vel,
            amp_k: m,
        }
    }

    pub fn height(&self, p: [f64; 2], t: f64, land: &impl Fn([f64; 2]) -> f64) -> f64 {
        self.sample(p, t, land).height
    }
}

/// No land anywhere.
pub fn open_sea(_: [f64; 2]) -> f64 {
    f64::INFINITY
}

#[cfg(test)]
mod tests;
