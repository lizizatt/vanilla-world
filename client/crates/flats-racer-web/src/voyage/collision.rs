use super::*;

#[derive(Default)]
pub(super) struct CollisionTree {
    pub(super) triangles: Vec<[[f64; 3]; 3]>,
    pub(super) nodes: Vec<CollisionNode>,
}

pub(super) struct CollisionNode {
    pub(super) bounds: [f64; 6],
    pub(super) range: std::ops::Range<usize>,
    pub(super) children: Option<[usize; 2]>,
}

pub(super) struct CollisionPrimitive {
    pub(super) bounds: [f64; 6],
    pub(super) center: [f64; 3],
}

impl CollisionTree {
    pub(super) fn buffer_bytes(&self) -> usize {
        self.triangles.capacity() * std::mem::size_of::<[[f64; 3]; 3]>()
            + self.nodes.capacity() * std::mem::size_of::<CollisionNode>()
    }

    pub(super) fn from_parts(parts: &mut [&Self]) -> Self {
        let mut tree = Self {
            triangles: Vec::with_capacity(parts.iter().map(|p| p.triangles.len()).sum()),
            nodes: Vec::with_capacity(
                parts.iter().map(|p| p.nodes.len()).sum::<usize>() + parts.len().saturating_sub(1),
            ),
        };
        if !parts.is_empty() {
            tree.append_parts(parts);
        }
        tree
    }

    pub(super) fn append_parts(&mut self, parts: &mut [&Self]) -> usize {
        let index = self.nodes.len();
        let start = self.triangles.len();
        if parts.len() == 1 {
            let part = parts[0];
            self.triangles.extend_from_slice(&part.triangles);
            self.nodes.extend(part.nodes.iter().map(|n| CollisionNode {
                bounds: n.bounds,
                range: n.range.start + start..n.range.end + start,
                children: n.children.map(|c| c.map(|i| i + index)),
            }));
            return index;
        }
        let mut bounds = [f64::INFINITY; 6];
        bounds[3..].fill(f64::NEG_INFINITY);
        for part in parts.iter() {
            let b = part.nodes[0].bounds;
            for a in 0..3 {
                bounds[a] = bounds[a].min(b[a]);
                bounds[a + 3] = bounds[a + 3].max(b[a + 3]);
            }
        }
        self.nodes.push(CollisionNode {
            bounds,
            range: start..start,
            children: None,
        });
        let axis = (0..3)
            .max_by(|&a, &b| (bounds[a + 3] - bounds[a]).total_cmp(&(bounds[b + 3] - bounds[b])))
            .unwrap();
        let middle = parts.len() / 2;
        parts.select_nth_unstable_by(middle, |a, b| {
            let a = a.nodes[0].bounds;
            let b = b.nodes[0].bounds;
            (a[axis] + a[axis + 3]).total_cmp(&(b[axis] + b[axis + 3]))
        });
        let (left, right) = parts.split_at_mut(middle);
        let children = [self.append_parts(left), self.append_parts(right)];
        self.nodes[index].range.end = self.triangles.len();
        self.nodes[index].children = Some(children);
        index
    }

    pub(super) fn new(vertices: &[f64]) -> Result<Self, &'static str> {
        if !vertices.len().is_multiple_of(9)
            || vertices.len() > 200_000 * 9
            || vertices.iter().any(|v| !v.is_finite() || v.abs() > 1e12)
        {
            return Err("Invalid or oversized authored collision payload");
        }
        let triangles = vertices
            .as_chunks::<9>()
            .0
            .iter()
            .map(|v| std::array::from_fn(|i| std::array::from_fn(|a| v[i * 3 + a])))
            .collect();
        let mut tree = Self {
            triangles,
            nodes: vec![],
        };
        let count = tree.triangles.len();
        if count > 0 {
            let primitives: Vec<_> = tree
                .triangles
                .iter()
                .map(|triangle| {
                    let mut bounds = [f64::INFINITY; 6];
                    bounds[3..].fill(f64::NEG_INFINITY);
                    for p in triangle {
                        for a in 0..3 {
                            bounds[a] = bounds[a].min(p[a]);
                            bounds[a + 3] = bounds[a + 3].max(p[a]);
                        }
                    }
                    CollisionPrimitive {
                        bounds,
                        center: std::array::from_fn(|a| triangle.iter().map(|v| v[a]).sum()),
                    }
                })
                .collect();
            let mut order: Vec<_> = (0..count).collect();
            tree.build(0..count, &mut order, &primitives);
            drop(primitives);
            // Partition small indices, then apply the resulting permutation once in place.
            for start in 0..count {
                if order[start] == usize::MAX {
                    continue;
                }
                let saved = tree.triangles[start];
                let mut at = start;
                loop {
                    let next = order[at];
                    order[at] = usize::MAX;
                    if next == start {
                        tree.triangles[at] = saved;
                        break;
                    }
                    tree.triangles[at] = tree.triangles[next];
                    at = next;
                }
            }
        }
        Ok(tree)
    }

    pub(super) fn build(
        &mut self,
        range: std::ops::Range<usize>,
        order: &mut [usize],
        primitives: &[CollisionPrimitive],
    ) -> usize {
        let mut bounds = [f64::INFINITY; 6];
        bounds[3..].fill(f64::NEG_INFINITY);
        for &i in &order[range.clone()] {
            let b = primitives[i].bounds;
            for a in 0..3 {
                bounds[a] = bounds[a].min(b[a]);
                bounds[a + 3] = bounds[a + 3].max(b[a + 3]);
            }
        }
        let index = self.nodes.len();
        self.nodes.push(CollisionNode {
            bounds,
            range: range.clone(),
            children: None,
        });
        if range.len() > 8 {
            let axis = (0..3)
                .max_by(|&a, &b| {
                    (bounds[a + 3] - bounds[a]).total_cmp(&(bounds[b + 3] - bounds[b]))
                })
                .unwrap();
            let half = range.len() / 2;
            order[range.clone()].select_nth_unstable_by(half, |&a, &b| {
                primitives[a].center[axis].total_cmp(&primitives[b].center[axis])
            });
            let middle = range.start + half;
            let left = self.build(range.start..middle, order, primitives);
            let right = self.build(middle..range.end, order, primitives);
            self.nodes[index].children = Some([left, right]);
        }
        index
    }

    pub(super) fn any(
        &self,
        node: usize,
        broad: &impl Fn([f64; 6]) -> bool,
        narrow: &mut impl FnMut(&[[f64; 3]; 3]) -> bool,
    ) -> bool {
        let n = &self.nodes[node];
        if !broad(n.bounds) {
            return false;
        }
        if let Some([a, b]) = n.children {
            self.any(a, broad, narrow) || self.any(b, broad, narrow)
        } else {
            self.triangles[n.range.clone()].iter().any(narrow)
        }
    }

    pub(super) fn height(&self, p: [f64; 2], ceiling: f64) -> Option<f64> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut height: Option<f64> = None;
        self.any(
            0,
            &|b| p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[2] && p[1] <= b[5] && b[1] <= ceiling,
            &mut |tri| {
                // Translate before f32 conversion to retain precision after floating-origin rebases.
                let local = tri.map(|v| [(v[0] - p[0]) as f32, (v[2] - p[1]) as f32, v[1] as f32]);
                if let Some(h) = triangle_z_at(&local, 0.0, 0.0)
                    .map(f64::from)
                    .filter(|h| *h <= ceiling)
                {
                    height = Some(height.map_or(h, |old| old.max(h)));
                }
                false
            },
        );
        height
    }

    pub(super) fn swept(&self, start: [f64; 3], end: [f64; 3]) -> bool {
        !self.nodes.is_empty()
            && self.any(0, &|b| swept_box(start, end, b), &mut |tri| {
                swept_triangle(start, end, tri)
            })
    }
}
