//! Writes a rig's bind and posed vertices plus triangle edges as JSON for plotting:
//! `cargo run --release -p benilla-formats --example rig_dump -- <path.m2> <anim> <seconds> <out.json>`

use benilla_formats::{M2Rig, open_chain, parse_m2_render_submeshes};

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let mut chain = open_chain(&benilla_formats::wow_data().expect("set $WOW_DATA"))?;
    let bytes = chain.read_file(&a[0])?;
    let dir = a[0].rsplit_once('\\').map_or("", |p| p.0);
    let bind = parse_m2_render_submeshes(&bytes, dir, &[None, None, None, None])?;
    let rig = M2Rig::new(&bytes, &bind, &[0, 4])?;
    let n: usize = bind.iter().map(|s| s.positions.len()).sum();
    let mut out = vec![0.0f32; n * 12];
    rig.pose_into(&bind, a[1].parse()?, a[2].parse()?, &mut out)?;
    let bp: Vec<[f32; 3]> = bind.iter().flat_map(|s| s.positions.iter().copied()).collect();
    let pp: Vec<[f32; 3]> = out.chunks(12).map(|v| [v[0], v[1], v[2]]).collect();
    let (mut tris, mut off) = (Vec::new(), 0u32);
    for s in &bind {
        tris.extend(s.indices.iter().map(|i| i + off));
        off += s.positions.len() as u32;
    }
    let jw: Vec<[Vec<f32>; 2]> = bind.iter().flat_map(|s| s.joints.iter().zip(&s.weights).map(|(j, w)| [j.iter().map(|&x| x as f32).collect(), w.to_vec()])).collect();
    std::fs::write(&a[3], format!("{{\"bind\":{bp:?},\"pose\":{pp:?},\"tris\":{tris:?},\"jw\":{jw:?}}}"))?;
    Ok(())
}
