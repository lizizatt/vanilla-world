use super::math::contains;
use super::TILE;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub id: String,
    pub map: String,
    pub tile_origin: [u32; 2],
    pub tile_count: [u32; 2],
    /// Global east/south position of the region's northwest source tile corner.
    pub placement: [f64; 2],
}

impl Region {
    pub fn bounds(&self) -> [f64; 4] {
        [
            self.placement[0],
            self.placement[1],
            self.placement[0] + f64::from(self.tile_count[0]) * TILE,
            self.placement[1] + f64::from(self.tile_count[1]) * TILE,
        ]
    }

    pub fn source(&self, global: [f64; 2]) -> [f32; 3] {
        [
            -(global[1] - self.placement[1] + (f64::from(self.tile_origin[1]) - 32.0) * TILE)
                as f32,
            -(global[0] - self.placement[0] + (f64::from(self.tile_origin[0]) - 32.0) * TILE)
                as f32,
            0.0,
        ]
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TileEntry {
    pub region: usize,
    pub x: u32,
    pub y: u32,
    pub file: String,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HorizonEntry {
    pub region: usize,
    pub file: String,
    pub bytes: usize,
    pub sha256: String,
    /// Inclusive minimum, exclusive maximum authored WDL tile coordinates.
    pub source_bounds: [u32; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub label: String,
    pub regions: Vec<Region>,
    pub tiles: Vec<TileEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub horizons: Vec<HorizonEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_bounds: Option<[[u32; 4]; 2]>,
    /// Explicit connecting ocean only, never a fallback for missing continent data.
    pub ocean: [f64; 4],
    pub sea_level: f32,
    pub spawn: [f64; 4],
    pub destination: [f64; 2],
}

impl Manifest {
    /// Version 4: a single airless body (Elune): one region, no ocean, no second continent.
    fn validate_body(&self) -> Result<(), String> {
        let [r] = self.regions.as_slice() else {
            return Err("A body manifest has exactly one region".into());
        };
        let [h] = self.horizons.as_slice() else {
            return Err("A body manifest has exactly one horizon".into());
        };
        if r.id.is_empty()
            || r.id.len() > 64
            || r.map != "Elune"
            || r.tile_count.contains(&0)
            || r.tile_count.iter().any(|&n| n > 64)
            || r.tile_origin
                .iter()
                .zip(r.tile_count)
                .any(|(&a, n)| a >= 64 || a + n > 64)
            || r.placement.iter().any(|v| !v.is_finite() || v.abs() > 1.0e12)
            || self.tiles.is_empty()
            || self.tiles.len() > 4096
            || self.label.len() > 120
            || !self.sea_level.is_finite()
            || self.spawn[1].abs() > 10_000.0
            || self.spawn.iter().any(|v| !v.is_finite() || v.abs() > 1.0e12)
            || !contains(r.bounds(), [self.spawn[0], self.spawn[2]])
        {
            return Err("Invalid body manifest".into());
        }
        if h.region != 0
            || h.file != format!("{}.wdl", r.map)
            || h.bytes == 0
            || h.bytes > 5 * 1024 * 1024
            || h.sha256.len() != 64
            || !h.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || h.source_bounds.iter().any(|&n| n > 64)
            || h.source_bounds[0] >= h.source_bounds[2]
            || h.source_bounds[1] >= h.source_bounds[3]
        {
            return Err("Invalid WDL horizon descriptor".into());
        }
        let mut names = std::collections::HashSet::new();
        for t in &self.tiles {
            if t.region != 0
                || t.file != format!("{}_{}_{}.adt", r.map, t.x, t.y)
                || !names.insert(&t.file)
                || t.bytes > 16 * 1024 * 1024
                || !t.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || t.x < r.tile_origin[0]
                || t.x >= r.tile_origin[0] + r.tile_count[0]
                || t.y < r.tile_origin[1]
                || t.y >= r.tile_origin[1] + r.tile_count[1]
            {
                return Err("Invalid body tile descriptor".into());
            }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version == 4 {
            return self.validate_body();
        }
        if let Some(bounds) = self.world_bounds {
            if bounds
                .iter()
                .any(|b| b.iter().any(|&n| n > 64) || b[0] >= b[2] || b[1] >= b[3])
                || self.horizons.iter().enumerate().any(|(i, h)| {
                    i >= 2
                        || h.source_bounds[0] < bounds[i][0]
                        || h.source_bounds[1] < bounds[i][1]
                        || h.source_bounds[2] > bounds[i][2]
                        || h.source_bounds[3] > bounds[i][3]
                })
            {
                return Err("Invalid combined authored world bounds".into());
            }
        }
        if !matches!(self.version, 1..=3)
            || (self.version == 1 && !self.horizons.is_empty())
            || (self.version >= 2 && self.horizons.len() != 2)
            || (self.version == 3 && self.world_bounds.is_none())
            || self.regions.len() != 2
            || self.tiles.is_empty()
            || self.tiles.len() > if self.version == 3 { 8192 } else { 16 }
            || self.label.len() > 120
            || self.spawn[1].abs() > 10_000.0
            || !self.sea_level.is_finite()
            || self.sea_level.abs() > 10_000.0
            || self
                .ocean
                .iter()
                .chain(self.spawn.iter())
                .chain(self.destination.iter())
                .any(|v| !v.is_finite() || v.abs() > 1.0e12)
        {
            return Err("Unsupported or non-finite route manifest".into());
        }
        for (i, r) in self.regions.iter().enumerate() {
            if r.id.is_empty()
                || r.id.len() > 64
                || !matches!(r.map.as_str(), "Kalimdor" | "Azeroth")
                || r.tile_count.contains(&0)
                || r.tile_count
                    .iter()
                    .any(|&n| n > if self.version == 3 { 64 } else { 4 })
                || r.tile_origin
                    .iter()
                    .zip(r.tile_count)
                    .any(|(&a, n)| a >= 64 || a + n > 64)
                || r.placement
                    .iter()
                    .any(|v| !v.is_finite() || v.abs() > 1.0e12)
            {
                return Err("Invalid region dimensions or placement".into());
            }
            if self.version < 3 {
                for y in r.tile_origin[1]..r.tile_origin[1] + r.tile_count[1] {
                    for x in r.tile_origin[0]..r.tile_origin[0] + r.tile_count[0] {
                        if self
                            .tiles
                            .iter()
                            .filter(|t| t.region == i && t.x == x && t.y == y)
                            .count()
                            != 1
                        {
                            return Err("Every corridor tile must be listed exactly once".into());
                        }
                    }
                }
            }
        }
        let a = self.regions[0].bounds();
        let b = self.regions[1].bounds();
        let expected = if self.version == 1 {
            [a[2], a[1], b[0], a[3]]
        } else {
            let bounds = |i: usize| {
                let r = &self.regions[i];
                let source_bounds = self
                    .world_bounds
                    .map_or(self.horizons[i].source_bounds, |b| b[i]);
                [
                    r.placement[0]
                        + (f64::from(source_bounds[0]) - f64::from(r.tile_origin[0])) * TILE,
                    r.placement[1]
                        + (f64::from(source_bounds[1]) - f64::from(r.tile_origin[1])) * TILE,
                    r.placement[0]
                        + (f64::from(source_bounds[2]) - f64::from(r.tile_origin[0])) * TILE,
                    r.placement[1]
                        + (f64::from(source_bounds[3]) - f64::from(r.tile_origin[1])) * TILE,
                ]
            };
            let (west, east) = (bounds(0), bounds(1));
            if west[2] >= east[0] {
                return Err("Full authored continent bounds overlap".into());
            }
            [west[2], west[1].min(east[1]), east[0], west[3].max(east[3])]
        };
        if self.regions[0].id == self.regions[1].id
            || (self.version < 3
                && (a[2] >= b[0] || (a[1] - b[1]).abs() > 0.001 || (a[3] - b[3]).abs() > 0.001))
            || self
                .ocean
                .iter()
                .zip(expected)
                .any(|(v, e)| (v - e).abs() > 0.001)
            || !contains(a, [self.spawn[0], self.spawn[2]])
            || !contains(b, self.destination)
        {
            return Err("Regions must bracket one explicit ocean and valid coast endpoints".into());
        }
        let mut total = 0usize;
        let mut names = std::collections::HashSet::new();
        for (index, h) in self.horizons.iter().enumerate() {
            let r = self.regions.get(h.region).ok_or("Unknown horizon region")?;
            if h.region != index
                || h.file != format!("{}.wdl", r.map)
                || !names.insert(&h.file)
                || h.bytes == 0
                || h.bytes > 5 * 1024 * 1024
                || h.sha256.len() != 64
                || !h.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || h.source_bounds.iter().any(|&n| n > 64)
                || h.source_bounds[0] >= h.source_bounds[2]
                || h.source_bounds[1] >= h.source_bounds[3]
            {
                return Err("Invalid WDL horizon descriptor".into());
            }
            total += h.bytes;
        }
        for t in &self.tiles {
            let r = self.regions.get(t.region).ok_or("Unknown tile region")?;
            let expected = format!("{}_{}_{}.adt", r.map, t.x, t.y);
            if t.file != expected
                || !names.insert(&t.file)
                || (self.version < 3 && t.bytes == 0)
                || t.bytes > 16 * 1024 * 1024
                || (self.version < 3 && t.sha256.len() != 64)
                || !t.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || t.x < r.tile_origin[0]
                || t.x >= r.tile_origin[0] + r.tile_count[0]
                || t.y < r.tile_origin[1]
                || t.y >= r.tile_origin[1] + r.tile_count[1]
            {
                return Err("Invalid route tile descriptor".into());
            }
            total += t.bytes;
        }
        if total > 128 * 1024 * 1024 {
            return Err("Route pack exceeds 128 MiB".into());
        }
        Ok(())
    }

    pub fn tile_placement(&self, index: usize) -> [f64; 2] {
        let t = &self.tiles[index];
        let r = &self.regions[t.region];
        [
            r.placement[0] + f64::from(t.x - r.tile_origin[0]) * TILE,
            r.placement[1] + f64::from(t.y - r.tile_origin[1]) * TILE,
        ]
    }
}
