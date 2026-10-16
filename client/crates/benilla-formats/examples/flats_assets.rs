//! Read-only custom racer preflight; prints metadata, never writes install bytes.
use anyhow::{Context, Result};
use benilla_formats::{load_creature_catalog, Chain};
use std::{io::Cursor, path::Path};

fn main() -> Result<()> {
    let data = std::env::args()
        .nth(1)
        .context("usage: flats_assets <Data>")?;
    let mut chain = Chain::open(Path::new(&data))?;
    let catalog = load_creature_catalog(&mut chain)?;
    let rider = catalog
        .model(49)
        .context("offline rider display 49 unavailable")?;
    println!("probe_rider display=49 path={}", rider.model_path);
    let tiles = benilla_formats::load_tiles_around(&mut chain, "Kalimdor", -6235.0, -3945.0, 0)?;
    let chunks: Vec<_> = tiles
        .into_iter()
        .flat_map(|(_, tile)| tile.chunks)
        .collect();
    for (dx, dy) in [
        (0.0, 0.0),
        (-3.0, -1.7),
        (-3.0, 1.7),
        (3.0, -1.7),
        (3.0, 1.7),
    ] {
        let point = [-6235.0 + dx, -3945.0 + dy, 0.0];
        let height = benilla_formats::terrain_height_at(&chunks, point)
            .context("Flats preflight has no terrain support")?;
        println!(
            "flats_support x={} y={} terrain_z={height:.4}",
            point[0], point[1]
        );
    }
    for (display, model) in catalog.display_models() {
        if model != 1471 && model != 2195 {
            continue;
        }
        let resolved = catalog.model(display).context("missing model")?;
        let path = resolved
            .model_path
            .replace(".mdx", ".m2")
            .replace(".MDX", ".m2");
        let bytes = chain.read(&path)?;
        let parsed = benilla_m2::parse_m2(&mut Cursor::new(bytes.as_slice()))?;
        let m2 = parsed.model();
        println!(
            "display={display} model={model} path={path} scale={} textures={:?}",
            resolved.scale, resolved.textures
        );
        println!(
            "bounds={:?}..{:?} rider_attachment={}",
            m2.header.bounding_box_min,
            m2.header.bounding_box_max,
            m2.attachment(0).is_some()
        );
    }
    Ok(())
}
