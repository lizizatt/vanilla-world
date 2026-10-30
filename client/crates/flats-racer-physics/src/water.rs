//! Water-contact / buoyancy API (design/ocean.md sections 5-6). API only: no hull. A body is a set of sample points;
//! each point reports how deep it sits below the water surface and the water pushes back. `WaterField` is the
//! single query seam (wave height, normal, surface velocity, local amplitude, depth).

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WaterSample {
    pub height: f64,
    pub normal: [f64; 3],
    pub surface_velocity: [f64; 3],
    /// Wave amplitude multiplier here (region scale times shore fade); 0 = flat water.
    pub amp_k: f64,
    /// Water depth over the ground (yd); `f64::INFINITY` over open sea.
    pub depth: f64,
}

pub trait WaterField {
    fn sample(&self, x: f64, z: f64) -> WaterSample;
    fn sample_batch(&self, points: &[[f64; 2]], out: &mut Vec<WaterSample>) {
        out.clear();
        out.extend(points.iter().map(|p| self.sample(p[0], p[1])));
    }
}

/// Immersion of one sample point: `depth` below the surface (negative = above), `fraction` partial 0..1 over `cell_height`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contact {
    pub depth: f64,
    pub fraction: f64,
    pub normal: [f64; 3],
    pub surface_velocity: [f64; 3],
}

/// Fixed-capacity result a caller owns, so a per-tick query allocates nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct Submerged<const N: usize> {
    pub contacts: [Contact; N],
    pub volume: f64,
}

pub const DRY: Contact = Contact {
    depth: f64::NEG_INFINITY,
    fraction: 0.0,
    normal: [0.0, 1.0, 0.0],
    surface_velocity: [0.0; 3],
};

/// Fill `out` for body points in world space. Each point stands for a vertical slab `cell_height` tall and
/// `cell_area` wide; its submerged fraction is `clamp(depth / cell_height + 0.5, 0, 1)`.
pub fn query<const N: usize>(
    field: &impl WaterField,
    points: &[[f64; 3]; N],
    cell_height: f64,
    cell_area: f64,
    out: &mut Submerged<N>,
) {
    out.volume = 0.0;
    for (point, contact) in points.iter().zip(out.contacts.iter_mut()) {
        let w = field.sample(point[0], point[2]);
        let depth = w.height - point[1];
        let fraction = (depth / cell_height + 0.5).clamp(0.0, 1.0);
        *contact = Contact { depth, fraction, normal: w.normal, surface_velocity: w.surface_velocity };
        out.volume += fraction * cell_height * cell_area;
    }
}

/// Archimedes: force (N-like units) and torque about `pivot` from the contacts. Each point pushes along +y by the
/// displaced weight of water.
pub fn buoyancy<const N: usize>(
    points: &[[f64; 3]; N],
    sub: &Submerged<N>,
    density: f64,
    gravity: f64,
    cell_height: f64,
    cell_area: f64,
    pivot: [f64; 3],
) -> ([f64; 3], [f64; 3]) {
    let mut force = [0.0; 3];
    let mut torque = [0.0; 3];
    for (p, c) in points.iter().zip(sub.contacts.iter()) {
        let f = density * gravity * c.fraction * cell_height * cell_area;
        let r = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
        force[1] += f;
        // torque = r x (0, f, 0)
        torque[0] -= r[2] * f;
        torque[2] += r[0] * f;
    }
    (force, torque)
}

/// Quadratic drag of submerged points against the moving water, `body_velocity` per point in world space.
pub fn drag<const N: usize>(
    sub: &Submerged<N>,
    body_velocity: [f64; 3],
    coefficient: f64,
    cell_area: f64,
) -> [f64; 3] {
    let mut force = [0.0; 3];
    for c in sub.contacts.iter() {
        let rel = [
            c.surface_velocity[0] - body_velocity[0],
            c.surface_velocity[1] - body_velocity[1],
            c.surface_velocity[2] - body_velocity[2],
        ];
        let speed = (rel[0] * rel[0] + rel[1] * rel[1] + rel[2] * rel[2]).sqrt();
        for i in 0..3 {
            force[i] += coefficient * c.fraction * cell_area * speed * rel[i];
        }
    }
    force
}

#[cfg(test)]
mod tests;
