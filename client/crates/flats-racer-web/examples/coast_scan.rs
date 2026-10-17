//! Read-only coastal inspection; outputs measurements, never install contents.
use benilla_formats::{load_tile_mesh, Chain, LiquidKind};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 6 {
        return Err("usage: coast_scan DATA MAP TILE_Y FIRST_X LAST_X".into());
    }
    let mut chain = Chain::open(Path::new(&args[1]))?;
    let row: u32 = args[3].parse()?;
    for x in args[4].parse::<u32>()?..=args[5].parse()? {
        let tile = load_tile_mesh(&mut chain, &args[2], x, row)?;
        let nw = tile.chunks[0].positions[0];
        println!("{}_{x}_{row} NW={nw:?}", args[2]);
        for south in [64.0, 160.0, 256.0, 352.0, 448.0] {
            let mut samples = Vec::new();
            for east in (0..=512).step_by(32) {
                let wow = [nw[0] - south, nw[1] - east as f32, 0.0];
                let ground = tile.chunks.iter().find_map(|c| c.height_at(wow));
                let water = tile
                    .chunks
                    .iter()
                    .flat_map(|c| &c.liquids)
                    .filter(|l| matches!(l.kind, LiquidKind::Still | LiquidKind::Ocean))
                    .flat_map(|l| {
                        l.indices.as_chunks::<3>().0.iter().map(|t| {
                            let triangle = t.map(|i| l.positions[i as usize]);
                            benilla_formats::triangle_z_at(&triangle, wow[0], wow[1])
                        })
                    })
                    .flatten()
                    .next();
                samples.push(format!(
                    "{east}:{:.1}/{}",
                    ground.unwrap_or(f32::NAN),
                    water.map_or("-".into(), |w| format!("{w:.1}"))
                ));
            }
            println!("south={south} {}", samples.join(" "));
        }
    }
    Ok(())
}
