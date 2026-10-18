//! The racer's distant water: the same authored MCLQ liquid data an ADT tile's near-field terrain
//! already renders, parsed without building the tile's far larger height/normal/alpha/shadow
//! structures. Reuses [`benilla_adt::scan_adt_liquids`] (header + MCLQ offset walk only) and
//! [`crate::liquid`]'s existing `MclqChunk → LiquidMesh` mesher, so the racer's coarse water
//! shares its real coverage, shore gaps and kind (still/ocean/magma) with what the streamed
//! near-field would draw for the same tile — just without ever parsing that tile's terrain.
//!
//! "Liquid-only" is a CPU-parse saving, not an I/O one: the whole ADT file (MPQ decompression
//! included) is read either way, the same bytes a full parse would read; this module skips
//! turning most of them into Rust structures, not reading them off disk. [`adt_bytes_to_liquid_only`]
//! takes already-read bytes, so a caller on an async asset-loading path (`benilla_assets`'s
//! `AdtLiquidTile`, off the main thread) and a caller with a synchronous [`Chain`] handle
//! ([`load_adt_liquid_only`]) share the same scan.
//!
//! [`adt_bytes_to_racer_features`] additionally resolves the tile's doodad/WMO placements
//! ([`benilla_adt::scan_adt_placements`], another MCNK-free top-level scan) into the same
//! [`crate::Doodad`]/[`crate::WmoInstance`] types the near-field terrain already produces — one
//! read of the tile serves water, vegetation and building LOD together, instead of three separate
//! whole-ADT requests for the same bytes.

use std::io::Cursor;

use anyhow::{Context, Result};
use benilla_adt::{scan_adt_liquids, scan_adt_placements};

use crate::liquid::build_liquid_mesh;
use crate::terrain::TILE_SIZE;
use crate::Chain;
use crate::{Doodad, LiquidMesh, WmoInstance};

/// Every liquid surface one already-read ADT file's MCNKs carry, in raw WoW coords. `Err` only on
/// bytes that do not parse as an ADT at all; a dry tile parses fine to an empty `Vec`.
pub fn adt_bytes_to_liquid_only(bytes: &[u8]) -> Result<Vec<LiquidMesh>> {
    let summaries = scan_adt_liquids(&mut Cursor::new(bytes))
        .map_err(|e| anyhow::anyhow!("scanning ADT for liquid: {e}"))?;
    Ok(summaries
        .iter()
        .flat_map(|s| {
            s.liquids
                .iter()
                .filter_map(move |mclq| build_liquid_mesh(mclq, s.position))
        })
        .collect())
}

/// [`adt_bytes_to_liquid_only`] plus the tile's resolved doodad/WMO placements, from one already-
/// read ADT's bytes. The placement transform (corner-origin remap, MDDF's ×1024 scale) is the
/// same one [`crate::adt_to_tile_mesh`] applies; a placement whose `name_id` does not resolve in
/// the name table is dropped, same as there.
pub fn adt_bytes_to_racer_features(bytes: &[u8]) -> Result<(Vec<LiquidMesh>, Vec<Doodad>, Vec<WmoInstance>)> {
    let liquids = adt_bytes_to_liquid_only(bytes)?;
    let placements = scan_adt_placements(&mut Cursor::new(bytes))
        .map_err(|e| anyhow::anyhow!("scanning ADT for placements: {e}"))?;

    const MAP_CENTER: f32 = 32.0 * TILE_SIZE;
    let doodads = placements
        .doodad_placements
        .iter()
        .filter_map(|d| {
            let model = placements.models.get(d.name_id as usize)?.clone();
            Some(Doodad {
                model,
                position: [
                    MAP_CENTER - d.position[2],
                    MAP_CENTER - d.position[0],
                    d.position[1],
                ],
                rotation: d.rotation,
                scale: d.scale as f32 / 1024.0,
                unique_id: d.unique_id,
            })
        })
        .collect();
    let wmos = placements
        .wmo_placements
        .iter()
        .filter_map(|w| {
            let model = placements.wmos.get(w.name_id as usize)?.clone();
            Some(WmoInstance {
                model,
                position: [
                    MAP_CENTER - w.position[2],
                    MAP_CENTER - w.position[0],
                    w.position[1],
                ],
                rotation: w.rotation,
                unique_id: w.unique_id,
                doodad_set: w.doodad_set,
                name_set: w.name_set,
            })
        })
        .collect();

    Ok((liquids, doodads, wmos))
}

/// [`adt_bytes_to_liquid_only`] over one ADT tile read synchronously off a patch [`Chain`]. Empty
/// for a fully dry tile (most inland tiles); `Err` only on a missing or unreadable ADT. Prefer
/// `benilla_assets`'s `AdtLiquidTile` asset (the same `mpq://` pipeline `AdtTile` uses) wherever a
/// caller can request it asynchronously instead of blocking on this.
pub fn load_adt_liquid_only(
    chain: &mut Chain,
    map: &str,
    tile_x: u32,
    tile_y: u32,
) -> Result<Vec<LiquidMesh>> {
    let path = format!("World\\Maps\\{map}\\{map}_{tile_x}_{tile_y}.adt");
    let bytes = chain
        .read_file(&path)
        .with_context(|| format!("reading {path}"))?;
    adt_bytes_to_liquid_only(&bytes).with_context(|| format!("scanning {path} for liquid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lightweight scan must find real liquid surfaces on a known tile — Crystal Lake, the
    /// same fixture `liquid::tests::parses_elwynn_lake_tile` uses for the full mesher.
    #[test]
    fn finds_still_water_on_crystal_lake_tile() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let light = load_adt_liquid_only(&mut chain, "Azeroth", 32, 48).expect("liquid-only scan");
        assert_eq!(
            light.len(),
            42,
            "Crystal Lake (Azeroth_32_48) has 42 liquid chunks, same as the full mesher"
        );
        assert!(
            light.iter().all(|lq| lq.kind == crate::LiquidKind::Still),
            "Crystal Lake is all still water"
        );
    }

    /// Hillsbrad's river-mouth tile carries both a stream (Still) and the sea (Ocean), the same
    /// fixture `liquid::tests::a_river_mouth_chunk_builds_both_its_river_and_its_sea` uses.
    #[test]
    fn finds_both_kinds_on_a_river_mouth_tile() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let light = load_adt_liquid_only(&mut chain, "Azeroth", 33, 33).expect("liquid-only scan");
        assert!(
            light.iter().any(|lq| lq.kind == crate::LiquidKind::Still),
            "Azeroth_33_33 carries a river"
        );
        assert!(
            light.iter().any(|lq| lq.kind == crate::LiquidKind::Ocean),
            "Azeroth_33_33 carries the sea"
        );
    }

    /// A tile at the map's unauthored edge has no ADT file at all; the scan must fail cleanly
    /// (`Err`, not a panic), so the racer ring simply skips water for that tile, the same way
    /// `WdlStreamer` already skips an absent `.wdl` tile.
    #[test]
    fn an_unauthored_tile_errors_cleanly_not_a_panic() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        assert!(
            load_adt_liquid_only(&mut chain, "Azeroth", 0, 0).is_err(),
            "Azeroth_0_0.adt is off the authored map and should not exist"
        );
    }

    /// The async loader (`AdtLiquidTile`) and the synchronous `Chain` path must agree: both are
    /// `adt_bytes_to_liquid_only` under a different front door.
    #[test]
    fn bytes_and_chain_paths_agree_on_crystal_lake() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let bytes = chain
            .read_file("World\\Maps\\Azeroth\\Azeroth_32_48.adt")
            .expect("read adt");
        let via_bytes = adt_bytes_to_liquid_only(&bytes).expect("bytes scan");
        let via_chain =
            load_adt_liquid_only(&mut chain, "Azeroth", 32, 48).expect("chain scan");
        assert_eq!(via_bytes.len(), via_chain.len());
        assert_eq!(via_bytes.len(), 42);
    }

    /// The combined racer-features scan's doodad/WMO placements must match the full near-field
    /// parse (`adt_to_tile_mesh`) exactly — same models, same resolved world positions — while its
    /// liquids stay the Crystal Lake fixture (42, all Still).
    #[test]
    fn racer_features_placements_match_the_full_parse() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let bytes = chain
            .read_file("World\\Maps\\Azeroth\\Azeroth_32_48.adt")
            .expect("read adt");

        let (liquids, doodads, wmos) =
            adt_bytes_to_racer_features(&bytes).expect("racer-features scan");
        assert_eq!(liquids.len(), 42);

        let full = crate::adt_to_tile_mesh(&bytes).expect("full parse");
        assert_eq!(doodads.len(), full.doodads.len());
        assert_eq!(wmos.len(), full.wmos.len());
        assert!(!doodads.is_empty(), "Crystal Lake's shore has authored doodads");
        for (lite, real) in doodads.iter().zip(&full.doodads) {
            assert_eq!(lite.model, real.model);
            assert_eq!(lite.position, real.position);
            assert_eq!(lite.scale, real.scale);
        }
        for (lite, real) in wmos.iter().zip(&full.wmos) {
            assert_eq!(lite.model, real.model);
            assert_eq!(lite.position, real.position);
        }
    }
}
