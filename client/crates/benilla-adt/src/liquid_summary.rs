//! Header/MCLQ-only scan; terrain, textures and placements are deliberately not validated or decoded.
use crate::{Error, MCLQ_BLOCK, MCNK_LIQUID_BITS, MclqChunk, Result, read_mclq_blocks};
use benilla_bytes::ByteExt;
use std::io::Cursor;

#[derive(Debug, Clone)]
pub struct McnkLiquidSummary {
    pub index_x: u32,
    pub index_y: u32,
    pub position: [f32; 3],
    pub liquids: Vec<MclqChunk>,
}

pub fn scan_adt_liquids(cursor: &mut Cursor<&[u8]>) -> Result<Vec<McnkLiquidSummary>> {
    let bytes = *cursor.get_ref();
    if bytes.bytes_at(0, 4) != Some(b"REVM")
        || bytes.u32_at(4) != Some(4)
        || bytes.u32_at(8) != Some(18)
    {
        return Err(Error::Invalid("expected version-18 root ADT"));
    }
    let mut offset = 12usize;
    let mut seen = [false; 256];
    let mut out = Vec::new();
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset + 8)
            .ok_or(Error::Truncated("chunk header"))?;
        let length = header.u32_at(4).unwrap() as usize;
        offset += 8;
        let end = offset
            .checked_add(length)
            .ok_or(Error::Invalid("chunk length"))?;
        let data = bytes
            .get(offset..end)
            .ok_or(Error::Truncated("chunk payload"))?;
        offset = end;
        if &header[..4] != b"KNCM" {
            continue;
        }
        if data.len() < 128 {
            return Err(Error::Truncated("MCNK header"));
        }
        let index_x = data.u32_at(4).unwrap();
        let index_y = data.u32_at(8).unwrap();
        if index_x >= 16 || index_y >= 16 || seen[(index_y * 16 + index_x) as usize] {
            return Err(Error::Invalid("duplicate or out-of-range MCNK"));
        }
        seen[(index_y * 16 + index_x) as usize] = true;
        let position = [
            data.f32_at(0x68).unwrap(),
            data.f32_at(0x6c).unwrap(),
            data.f32_at(0x70).unwrap(),
        ];
        if !position.iter().all(|n| n.is_finite()) {
            return Err(Error::Invalid("MCNK position"));
        }
        let ofs = data.u32_at(0x60).unwrap() as usize;
        let size = data.u32_at(0x64).unwrap() as usize;
        let mut liquids = Vec::new();
        if ofs != 0 || size != 0 {
            let start = [Some(ofs), ofs.checked_sub(8)]
                .into_iter()
                .flatten()
                .find(|&p| p >= 128 && data.bytes_at(p, 4) == Some(b"QLCM"))
                .ok_or(Error::Invalid("MCLQ offset"))?;
            let payload = start.checked_add(8).ok_or(Error::Invalid("MCLQ offset"))?;
            let flags = data.u32_at(0).unwrap();
            let count = (flags & MCNK_LIQUID_BITS).count_ones().max(1) as usize;
            let needed = (count - 1) * MCLQ_BLOCK + 8 + 81 * 8 + 64;
            // Legacy size fields can include the eight-byte subchunk header.
            let available = data
                .len()
                .checked_sub(payload)
                .ok_or(Error::Truncated("MCLQ header"))?;
            let length = if size <= available {
                size
            } else {
                size.checked_sub(8)
                    .filter(|&n| n <= available)
                    .ok_or(Error::Truncated("MCLQ payload"))?
            };
            if size == 8 && flags & MCNK_LIQUID_BITS == 0 && data.u32_at(start + 4) == Some(0) {
                // Shipped dry chunks carry an empty MCLQ header with size_liquid = 8.
            } else {
                if length < needed {
                    return Err(Error::Truncated("MCLQ grid"));
                }
                liquids = read_mclq_blocks(&data[payload..payload + length], flags);
                if liquids.len() != count
                    || liquids
                        .iter()
                        .any(|l| l.vertices.iter().any(|v| !v.height.is_finite()))
                {
                    return Err(Error::Invalid("MCLQ heights"));
                }
            }
        }
        out.push(McnkLiquidSummary {
            index_x,
            index_y,
            position,
            liquids,
        });
    }
    if out.is_empty() {
        return Err(Error::Invalid("root ADT has no MCNK headers"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(wet: bool) -> Vec<u8> {
        let mut data = vec![0u8; 128];
        if wet {
            data[..4].copy_from_slice(&12u32.to_le_bytes());
            data[0x60..0x64].copy_from_slice(&128u32.to_le_bytes());
            data[0x64..0x68].copy_from_slice(&(2 * MCLQ_BLOCK as u32 + 8).to_le_bytes());
            data.extend(b"QLCM\0\0\0\0");
            data.resize(128 + 8 + 2 * MCLQ_BLOCK, 0);
        }
        let mut bytes = b"REVM\x04\0\0\0\x12\0\0\0KNCM".to_vec();
        bytes.extend((data.len() as u32).to_le_bytes());
        bytes.extend(data);
        bytes
    }
    #[test]
    fn scans_dry_headers_and_both_river_mouth_blocks_without_terrain() {
        for wet in [false, true] {
            let bytes = fixture(wet);
            let parsed = scan_adt_liquids(&mut Cursor::new(bytes.as_slice())).unwrap();
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0].liquids.len(), if wet { 2 } else { 0 });
        }
    }
    #[test]
    fn malformed_liquid_is_not_successfully_empty_water() {
        let wet = fixture(true);
        for end in [0, 11, 19, wet.len() - 1] {
            assert!(scan_adt_liquids(&mut Cursor::new(&wet[..end])).is_err());
        }
        let mut bad = wet.clone();
        bad[20 + 0x60..20 + 0x64].copy_from_slice(&127u32.to_le_bytes());
        assert!(scan_adt_liquids(&mut Cursor::new(bad.as_slice())).is_err());
        let mut bad = wet.clone();
        bad[20 + 0x64..20 + 0x68].copy_from_slice(&32u32.to_le_bytes());
        assert!(scan_adt_liquids(&mut Cursor::new(bad.as_slice())).is_err());
        let mut bad = wet;
        bad[20 + 136 + 12..20 + 136 + 16].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(scan_adt_liquids(&mut Cursor::new(bad.as_slice())).is_err());
    }
    #[test]
    fn authored_empty_mclq_header_is_dry_but_a_claimed_wet_grid_must_exist() {
        let mut bytes = fixture(false);
        bytes[16..20].copy_from_slice(&136u32.to_le_bytes());
        bytes[20 + 0x60..20 + 0x64].copy_from_slice(&128u32.to_le_bytes());
        bytes[20 + 0x64..20 + 0x68].copy_from_slice(&8u32.to_le_bytes());
        bytes.extend(b"QLCM\0\0\0\0");
        assert!(
            scan_adt_liquids(&mut Cursor::new(bytes.as_slice())).unwrap()[0]
                .liquids
                .is_empty()
        );
        bytes[20..24].copy_from_slice(&4u32.to_le_bytes());
        assert!(scan_adt_liquids(&mut Cursor::new(bytes.as_slice())).is_err());
    }
}
