//! Deviation: a local browser racer adapter, not a Bevy or VMaNGOS port.
use benilla_formats::{adt_to_tile_mesh, TileMesh};
use flats_racer_physics::{Input, State, FIXED_DT, HOVER_HEIGHT, PROBE_OFFSETS};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Racer {
    terrain: Option<TileMesh>,
    origin: [f32; 3],
    spawn: [f32; 3],
    state: State,
    held_at_edge: bool,
}

impl Racer {
    fn ground(&self, x: f32, z: f32) -> Option<f32> {
        if let Some(tile) = &self.terrain {
            let wow = [self.origin[0] - z, self.origin[1] - x, 0.0];
            tile.chunks.iter().find_map(|chunk| {
                if chunk.impassable {
                    None
                } else {
                    chunk.height_at(wow).map(|y| y - self.origin[2])
                }
            })
        } else {
            (x.abs() <= 256.0 && z.abs() <= 256.0).then_some(0.0)
        }
    }

    fn supports_at(&self, position: [f32; 3], yaw: f32) -> Option<[f32; 4]> {
        let (sin, cos) = yaw.sin_cos();
        let mut heights = [0.0; 4];
        for (i, [x, _, z]) in PROBE_OFFSETS.into_iter().enumerate() {
            heights[i] = self.ground(
                position[0] + x * cos + z * sin,
                position[2] - x * sin + z * cos,
            )?;
        }
        Some(heights)
    }

    fn tick_inner(&mut self, input: Input) -> Result<(), String> {
        let previous = self.state;
        let heights = self
            .supports_at(previous.position, previous.yaw)
            .ok_or("Racer has no safe terrain support; reset required")?;
        let supports = heights.map(|h| Some((previous.position[1] - h).max(0.0)));
        self.state
            .step(input, supports, FIXED_DT)
            .map_err(|e| e.to_string())?;
        let mut next = self.state.position;
        for (position, velocity) in next.iter_mut().zip(self.state.velocity) {
            *position += velocity * FIXED_DT;
        }
        // shortcut: conservative terrain-only contact; add swept model collision before props.
        let safe = self
            .supports_at(next, self.state.yaw)
            .filter(|hs| hs.iter().zip(heights).all(|(h, old)| h - old < 0.6));
        self.held_at_edge = safe.is_none();
        if let Some(hs) = safe {
            let floor = hs.into_iter().fold(f32::NEG_INFINITY, f32::max) + 0.25;
            if next[1] < floor {
                next[1] = floor;
                self.state.velocity[1] = self.state.velocity[1].max(0.0);
            }
            self.state.position = next;
        } else {
            self.state = previous;
            self.state.velocity = [0.0; 3];
        }
        Ok(())
    }
}

#[wasm_bindgen]
impl Racer {
    /// Empty bytes select the explicitly synthetic flat fixture.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<Racer, JsValue> {
        Self::from_bytes(bytes).map_err(|e| JsValue::from_str(&e))
    }

    pub fn tick(&mut self, throttle: f32, steer: f32, flags: u32) -> Result<(), JsValue> {
        self.tick_inner(Input {
            throttle,
            steer,
            brake: flags & 1 != 0,
            boost: flags & 2 != 0,
            drift: flags & 4 != 0,
            jump: flags & 8 != 0,
        })
        .map_err(|e| JsValue::from_str(&e))
    }

    pub fn reset(&mut self) {
        self.state = State::new(self.spawn, 0.0).expect("validated spawn");
        self.held_at_edge = false;
    }

    /// Saves are parked poses, not in-flight physics snapshots.
    pub fn restore(&mut self, pose: &[f32]) -> Result<(), JsValue> {
        self.restore_inner(pose).map_err(|e| JsValue::from_str(&e))
    }

    /// x/y/z, yaw, bank, speed, boost, grounded, boundary hold.
    pub fn telemetry(&self) -> Vec<f32> {
        let s = self.state;
        vec![
            s.position[0],
            s.position[1],
            s.position[2],
            s.yaw,
            s.bank,
            s.velocity[0].hypot(s.velocity[2]),
            s.boost_reserve,
            u8::from(s.grounded) as f32,
            u8::from(self.held_at_edge) as f32,
        ]
    }

    /// Expanded triangles in local Y-up coordinates: position and normal.
    pub fn vertices(&self) -> Vec<f32> {
        let mut out = Vec::new();
        let mut triangle = |points: [[f32; 3]; 3]| {
            let [a, b, c] = points;
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let mut n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let length = n.iter().map(|n| n * n).sum::<f32>().sqrt().max(0.0001);
            let sign = if n[1] < 0.0 { -1.0 } else { 1.0 };
            n.iter_mut().for_each(|n| *n *= sign / length);
            for p in points {
                out.extend(p);
                out.extend(n);
            }
        };
        if let Some(tile) = &self.terrain {
            for chunk in &tile.chunks {
                for indices in chunk.indices.as_chunks::<3>().0 {
                    triangle(std::array::from_fn(|i| {
                        let p = chunk.positions[indices[i] as usize];
                        [
                            self.origin[1] - p[1],
                            p[2] - self.origin[2],
                            self.origin[0] - p[0],
                        ]
                    }));
                }
            }
        } else {
            triangle([
                [-256.0, 0.0, -256.0],
                [256.0, 0.0, -256.0],
                [256.0, 0.0, 256.0],
            ]);
            triangle([
                [-256.0, 0.0, -256.0],
                [256.0, 0.0, 256.0],
                [-256.0, 0.0, 256.0],
            ]);
        }
        out
    }
}

impl Racer {
    fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("ADT exceeds 16 MiB limit".into());
        }
        let terrain = if bytes.is_empty() {
            None
        } else {
            let tile = adt_to_tile_mesh(bytes).map_err(|e| e.to_string())?;
            if tile.chunks.len() != 256
                || tile.chunks.iter().any(|c| {
                    c.positions.len() != 145
                        || c.positions
                            .iter()
                            .flatten()
                            .any(|v| !v.is_finite() || v.abs() > 100_000.0)
                        || c.indices.iter().any(|&i| i >= 145)
                })
            {
                return Err("Expected one complete, finite vanilla ADT tile (256 chunks)".into());
            }
            Some(tile)
        };
        let origin = terrain
            .as_ref()
            .map_or([0.0; 3], |tile| tile.chunks[0].positions[0]);
        let mut racer = Self {
            terrain,
            origin,
            spawn: [0.0, HOVER_HEIGHT, 0.0],
            state: State::new([0.0, HOVER_HEIGHT, 0.0], 0.0).map_err(|e| e.to_string())?,
            held_at_edge: false,
        };
        if racer.terrain.is_some() {
            let mut spawn = None;
            let mut grid: Vec<i32> = (16..512).step_by(16).collect();
            grid.sort_by_key(|v| (v - 256).abs());
            for &z in &grid {
                for &x in &grid {
                    let p = [x as f32, 0.0, z as f32];
                    if let Some(h) = racer.supports_at(p, 0.0) {
                        let low = h.into_iter().fold(f32::INFINITY, f32::min);
                        let high = h.into_iter().fold(f32::NEG_INFINITY, f32::max);
                        if high - low < 0.5 {
                            spawn = Some([p[0], high + HOVER_HEIGHT, p[2]]);
                            break;
                        }
                    }
                }
                if spawn.is_some() {
                    break;
                }
            }
            racer.spawn = spawn.ok_or("No safe terrain-only spawn in this tile")?;
            racer.reset();
        }
        Ok(racer)
    }

    fn restore_inner(&mut self, pose: &[f32]) -> Result<(), String> {
        if pose.len() != 4 || pose.iter().any(|v| !v.is_finite()) {
            return Err("Save must contain four finite pose values".into());
        }
        let position = [pose[0], pose[1], pose[2]];
        let hs = self
            .supports_at(position, pose[3])
            .ok_or("Saved pose is outside safe terrain")?;
        let floor = hs.into_iter().fold(f32::NEG_INFINITY, f32::max);
        if position[1] < floor + 0.2 || position[1] > floor + 20.0 {
            return Err("Saved height is outside the supported range".into());
        }
        self.state = State::new(position, pose[3]).map_err(|e| e.to_string())?;
        self.held_at_edge = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_physics_drives_turns_and_boundary_holds() {
        let mut racer = Racer::from_bytes(&[]).unwrap();
        for _ in 0..120 {
            racer
                .tick_inner(Input {
                    throttle: 1.0,
                    ..Default::default()
                })
                .unwrap();
        }
        assert!(racer.state.position[2] < -3.0);
        for _ in 0..120 {
            racer
                .tick_inner(Input {
                    throttle: 1.0,
                    steer: 1.0,
                    ..Default::default()
                })
                .unwrap();
        }
        assert!(racer.state.yaw > 0.1);
        racer.reset();
        for _ in 0..2400 {
            racer
                .tick_inner(Input {
                    throttle: 1.0,
                    boost: true,
                    ..Default::default()
                })
                .unwrap();
        }
        assert!(racer.held_at_edge);
        assert!(racer.state.position[2] > -256.0);
    }

    #[test]
    fn save_validation_is_atomic_and_invalid_tiles_are_rejected() {
        let mut racer = Racer::from_bytes(&[]).unwrap();
        racer
            .restore_inner(&[10.0, HOVER_HEIGHT, 10.0, 0.5])
            .unwrap();
        let before = racer.state;
        for pose in [
            vec![f32::NAN; 4],
            vec![0.0; 3],
            vec![999.0; 4],
            vec![0.0; 4],
        ] {
            assert!(racer.restore_inner(&pose).is_err());
            assert_eq!(racer.state, before);
        }
        assert!(Racer::from_bytes(b"not an ADT").is_err());
        assert_eq!(racer.vertices().len(), 36);
    }
}
