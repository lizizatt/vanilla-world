//! Private four-tile coastal corridor; no assets or generated pack belong in Git.
use benilla_formats::{adt_to_tile_mesh, Chain};
use flats_racer_web::voyage::{Manifest, Region, TileEntry, TILE};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: export_route DATA OUTPUT_DIRECTORY".into());
    }
    let data = Path::new(&args[1]).canonicalize()?;
    let out = Path::new(&args[2]);
    fs::create_dir_all(out)?;
    let out = out.canonicalize()?;
    if out.starts_with(&data) || out.join("route.json").exists() {
        return Err(
            "Output must be outside the install and must not contain an existing route.json".into(),
        );
    }
    let mut manifest = Manifest {
        version: 1,
        label: "Durotar to Westfall / four-tile test corridor / provisional 512 yd ocean".into(),
        regions: vec![
            Region {
                id: "kalimdor".into(),
                map: "Kalimdor".into(),
                tile_origin: [41, 33],
                tile_count: [2, 1],
                placement: [0.0, 0.0],
            },
            Region {
                id: "eastern-kingdoms".into(),
                map: "Azeroth".into(),
                tile_origin: [27, 51],
                tile_count: [2, 1],
                placement: [2.0 * TILE + 512.0, 0.0],
            },
        ],
        tiles: vec![],
        ocean: [2.0 * TILE, 0.0, 2.0 * TILE + 512.0, TILE],
        sea_level: 0.0,
        spawn: [288.0, 0.0, 160.0, -std::f64::consts::FRAC_PI_2],
        destination: [3.0 * TILE + 512.0 + 96.0, 160.0],
    };
    let chain = Chain::open(&data)?;
    for (region, r) in manifest.regions.iter().enumerate() {
        for x in r.tile_origin[0]..r.tile_origin[0] + r.tile_count[0] {
            let y = r.tile_origin[1];
            let file = format!("{}_{x}_{y}.adt", r.map);
            let bytes = chain.read(&format!("World\\Maps\\{}\\{file}", r.map))?;
            let mesh = adt_to_tile_mesh(&bytes)?;
            if region == 0 && x == r.tile_origin[0] {
                let wow = r.source([manifest.spawn[0], manifest.spawn[2]]);
                let height = mesh
                    .chunks
                    .iter()
                    .find_map(|c| c.height_at(wow))
                    .ok_or("No ground at route departure")?;
                manifest.spawn[1] = f64::from(height) + 1.8;
            }
            let sha256 = format!("{:x}", Sha256::digest(&bytes));
            fs::write(out.join(&file), &bytes)?;
            println!(
                "{file}: {} bytes; source retained; {} chunks",
                bytes.len(),
                mesh.chunks.len()
            );
            manifest.tiles.push(TileEntry {
                region,
                x,
                y,
                file,
                bytes: bytes.len(),
                sha256,
            });
        }
    }
    manifest.validate()?;
    fs::write(
        out.join("route.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!(
        "Private pack: {}. Select route.json and all four ADTs in the browser.",
        out.display()
    );
    println!(
        "Start {:?}; destination {:?}. New ocean spacing is provisional, not canonical geography.",
        manifest.spawn, manifest.destination
    );
    Ok(())
}
