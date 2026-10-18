//! Async racer water + vegetation/building placements: an ADT's liquid-only *and* placement-only
//! data as one Bevy [`Asset`], loaded through the same `mpq://` pipeline [`crate::AdtTile`] uses.
//! A second [`AssetLoader`] sharing `AdtTile`'s `.adt` extension, selected by the requested asset
//! type (`asset_server.load::<AdtLiquidTile>`), so the MPQ read/decompress this format still needs
//! runs on Bevy's asset task pool, off the frame that requests it, instead of blocking it.
//!
//! The parse itself is `benilla_formats::adt_bytes_to_racer_features` — the same liquid- and
//! placement-only scans a synchronous caller can use directly; this loader only supplies the
//! async front door. One read of the tile serves water, vegetation and building LOD together, so
//! the racer never issues three separate whole-ADT requests for the same bytes.

use benilla_formats::{adt_bytes_to_racer_features, Doodad, LiquidMesh, WmoInstance};
use bevy::asset::io::Reader;
use bevy::asset::{Asset, AssetLoader, LoadContext};
use bevy::reflect::TypePath;

/// One ADT tile's liquid, doodad and WMO placement data — everything the racer's distant water
/// and model-LOD systems need, in raw WoW coords; empty vecs on a tile with none of a kind.
#[derive(Asset, TypePath)]
pub struct AdtLiquidTile {
    pub liquids: Vec<LiquidMesh>,
    pub doodads: Vec<Doodad>,
    pub wmos: Vec<WmoInstance>,
}

/// Loads a `*.adt`'s liquid blocks and placement records into an [`AdtLiquidTile`].
#[derive(Default, TypePath)]
pub struct AdtLiquidLoader;

impl AssetLoader for AdtLiquidLoader {
    type Asset = AdtLiquidTile;
    type Settings = ();
    type Error = std::io::Error;

    async fn load(
        &self,
        reader: &mut dyn Reader,
        _settings: &(),
        _ctx: &mut LoadContext<'_>,
    ) -> Result<AdtLiquidTile, Self::Error> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        let (liquids, doodads, wmos) = adt_bytes_to_racer_features(&bytes)
            .map_err(|e| std::io::Error::other(format!("{e:#}")))?;
        Ok(AdtLiquidTile {
            liquids,
            doodads,
            wmos,
        })
    }

    fn extensions(&self) -> &[&str] {
        &["adt"]
    }
}
