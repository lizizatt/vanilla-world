// Procedural terrain tile in the 1.12 ADT layout (MVER, MTEX, 256 MCNK with MCVT/MCNR/MCLY). Generated, no game data; used by the demo world.
export const ADT_TILE=533.3333333333334,ADT_CHUNK=ADT_TILE/16;

const chunk=(magic,body)=>{const out=new Uint8Array(8+body.length),v=new DataView(out.buffer);
  for(let i=0;i<4;i++)out[i]=magic.charCodeAt(3-i);// stored reversed on disk
  v.setUint32(4,body.length,true);out.set(body,8);return out;};

/** MCVT order: 9 outer then 8 inner vertices per row pair; returns [x,z] offsets in yd from the chunk corner. */
export const mcvtOffsets=()=>{const o=[],s=ADT_CHUNK/8;
  for(let r=0;r<17;r++)for(let c=0;c<(r%2?8:9);c++)o.push([c*s+(r%2?s/2:0),(r>>1)*s+(r%2?s/2:0)]);return o;};

/** `height(x,z)` takes tile-local yd (x east, z south) and returns yd above sea level. */
export function synthAdt(height,tx=0,ty=0,texture='Tileset\\Generic\\Black.blp',areaId=0,normal) {
  const parts=[],ver=new Uint8Array(4);ver[0]=18;parts.push(chunk('MVER',ver));
  parts.push(chunk('MTEX',new TextEncoder().encode(texture+'\0')));
  const offs=mcvtOffsets();
  for(let cy=0;cy<16;cy++)for(let cx=0;cx<16;cx++) {
    const mcvt=new Uint8Array(145*4),mv=new DataView(mcvt.buffer);
    offs.forEach(([dx,dz],i)=>mv.setFloat32(i*4,height(cx*ADT_CHUNK+dx,cy*ADT_CHUNK+dz),true));
    const mcnr=new Uint8Array(435);
    // Bytes are WoW [north, west, up]; flat unless the caller supplies a unit normal [north, west, up] per tile-local point.
    offs.forEach(([dx,dz],i)=>{const n=normal?normal(cx*ADT_CHUNK+dx,cy*ADT_CHUNK+dz):[0,0,1];for(let k=0;k<3;k++)mcnr[i*3+k]=Math.round(127*n[k])&255;});
    const mcly=new Uint8Array(16);
    const sub=[chunk('MCVT',mcvt),chunk('MCNR',mcnr),chunk('MCLY',mcly)];
    const head=new Uint8Array(128),hv=new DataView(head.buffer);
    hv.setUint32(4,cx,true);hv.setUint32(8,cy,true);hv.setUint32(0x34,areaId>>>0,true);
    let at=128;[0x14,0x18,0x1c].forEach((slot,i)=>{hv.setUint32(slot,at,true);at+=sub[i].length;});
    // header position is the chunk's north-west corner in WoW axes (x north, y west)
    hv.setFloat32(0x68,(32-ty)*ADT_TILE-cy*ADT_CHUNK,true);hv.setFloat32(0x6c,(32-tx)*ADT_TILE-cx*ADT_CHUNK,true);hv.setFloat32(0x70,0,true);
    const body=new Uint8Array(at);body.set(head);let p=128;for(const s of sub){body.set(s,p);p+=s.length;}
    parts.push(chunk('MCNK',body));
  }
  const out=new Uint8Array(parts.reduce((n,a)=>n+a.length,0));let p=0;for(const a of parts){out.set(a,p);p+=a.length;}
  return out;
}
