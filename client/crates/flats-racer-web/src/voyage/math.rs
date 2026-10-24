use super::HULL_HALF_HEIGHT;

/// Whirlpool surface drop (yd, >= 0) at p for [cx, cz, radius, depth]: depth*(1-(r/radius)^2)^2, zero value and slope at the rim.
/// Mirrors dipDepth in browser/ocean-mesh.js; constants live in browser/clouds.js WHIRLPOOL_DIP.
pub fn whirlpool_dip(p: [f64; 2], w: [f64; 4]) -> f32 {
    let r = (p[0] - w[0]).hypot(p[1] - w[1]);
    if r >= w[2] {
        return 0.0;
    }
    (w[3] * (1.0 - (r / w[2]).powi(2)).powi(2)) as f32
}

pub(super) fn contains(b: [f64; 4], p: [f64; 2]) -> bool {
    p[0] >= b[0] && p[0] < b[2] && p[1] >= b[1] && p[1] < b[3]
}

pub(super) fn swept_triangle(start: [f64; 3], end: [f64; 3], triangle: &[[f64; 3]; 3]) -> bool {
    let sub = |a: [f64; 3], b: [f64; 3]| std::array::from_fn::<_, 3, _>(|i| a[i] - b[i]);
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let dot = |a: [f64; 3], b: [f64; 3]| (0..3).map(|i| a[i] * b[i]).sum::<f64>();
    let tri = triangle.map(|p| sub(p, start));
    let edges = [
        sub(tri[1], tri[0]),
        sub(tri[2], tri[1]),
        sub(tri[0], tri[2]),
    ];
    let normal = cross(edges[0], edges[1]);
    if dot(normal, normal) < 1e-20 {
        return false;
    }
    let basis = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let axes = basis
        .into_iter()
        .chain([normal])
        .chain(edges.into_iter().flat_map(|e| basis.map(|a| cross(e, a))));
    let motion = sub(end, start);
    let (mut enter, mut exit) = (0.0_f64, 1.0_f64);
    for axis in axes {
        if dot(axis, axis) < 1e-20 {
            continue;
        }
        let values = tri.map(|p| dot(p, axis));
        let radius = axis[0].abs() * 1.1 + axis[1].abs() * HULL_HALF_HEIGHT + axis[2].abs() * 1.1;
        let low = values.into_iter().fold(f64::INFINITY, f64::min) - radius;
        let high = values.into_iter().fold(f64::NEG_INFINITY, f64::max) + radius;
        let delta = dot(motion, axis);
        if delta.abs() < 1e-12 {
            if low > 0.0 || high < 0.0 {
                return false;
            }
        } else {
            enter = enter.max((low / delta).min(high / delta));
            exit = exit.min((low / delta).max(high / delta));
            if enter > exit {
                return false;
            }
        }
    }
    true
}

pub(super) fn swept_box(start: [f64; 3], end: [f64; 3], bounds: [f64; 6]) -> bool {
    if start[1].min(end[1]) - HULL_HALF_HEIGHT >= bounds[4] {
        return false;
    }
    let mut enter: f64 = 0.0;
    let mut exit: f64 = 1.0;
    for axis in 0..3 {
        let margin = if axis == 1 { HULL_HALF_HEIGHT } else { 1.1 };
        let low = bounds[axis] - margin;
        let high = bounds[axis + 3] + margin;
        let delta = end[axis] - start[axis];
        if delta.abs() < 1e-12 {
            if start[axis] < low || start[axis] > high {
                return false;
            }
        } else {
            let a = (low - start[axis]) / delta;
            let b = (high - start[axis]) / delta;
            enter = enter.max(a.min(b));
            exit = exit.min(a.max(b));
            if enter > exit {
                return false;
            }
        }
    }
    true
}
