// Moonglade graft (design/elune.md M9): re-emit a real 1.12 ADT as another tile by integer tile translation. No resampling and nothing is stored: bytes are copied
// and only absolute positions change (MCNK header corner, MCLQ heights, MDDF/MODF placements). Pure functions; real data is only ever read at runtime.
export const TILE=533.3333333333334;
const MCNK_HEADER=128,MCLQ_LAYER=804;

const magicAt=(v,p)=>String.fromCharCode(v.getUint8(p+3),v.getUint8(p+2),v.getUint8(p+1),v.getUint8(p));
/** Top-level chunks (or sub-chunks inside `[from,to)`): `{magic,start,size}` where start is the body offset. */
export function* adtChunks(bytes,from=0,to=bytes.byteLength) {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let p=from;p+8<=to;) {
    const size=v.getUint32(p+4,true);if(p+8+size>to)return;
    yield {magic:magicAt(v,p),start:p+8,size};p+=8+size;
  }
}
/** MCNK area ids in file order. */
export function mcnkAreas(bytes) {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),out=[];
  for(const c of adtChunks(bytes))if(c.magic==='MCNK'&&c.size>=MCNK_HEADER)out.push(v.getUint32(c.start+0x34,true));
  return out;
}
const bump=(v,p,d)=>v.setFloat32(p,v.getFloat32(p,true)+d,true);

/** Copy of `bytes` (source tile sx,sy) moved to tile (nx,ny) and raised by `yOffset` yd. Axes: file x = tile x, file z = tile y, height in the middle; MCNK corner is (north, west, up). */
export function translateAdt(bytes,{from:[sx,sy],to:[nx,ny],yOffset=0}) {
  const out=bytes.slice(),v=new DataView(out.buffer,out.byteOffset,out.byteLength),dx=(nx-sx)*TILE,dz=(ny-sy)*TILE;
  for(const c of adtChunks(out)) {
    if(c.magic==='MCNK'&&c.size>=MCNK_HEADER) {
      const s=c.start;bump(v,s+0x68,-dz);bump(v,s+0x6c,-dx);bump(v,s+0x70,yOffset);
      const flags=v.getUint32(s,true),ofs=v.getUint32(s+0x60,true),size=v.getUint32(s+0x64,true),layers=bitCount(flags&0x3c);
      if(size>8&&yOffset)for(let k=0;k<layers;k++) {
        const base=s-8+ofs+8+k*MCLQ_LAYER;if(base+8+81*8>s+c.size)break;
        bump(v,base,yOffset);bump(v,base+4,yOffset);
        for(let i=0;i<81;i++){const p=base+8+i*8+4;if(Math.abs(v.getFloat32(p,true))<1e30)bump(v,p,yOffset);}
      }
    } else if(c.magic==='MDDF') {
      for(let p=c.start;p+36<=c.start+c.size;p+=36){bump(v,p+8,dx);bump(v,p+12,yOffset);bump(v,p+16,dz);}
    } else if(c.magic==='MODF') {
      for(let p=c.start;p+64<=c.start+c.size;p+=64){
        bump(v,p+8,dx);bump(v,p+12,yOffset);bump(v,p+16,dz);
        bump(v,p+32,dx);bump(v,p+36,yOffset);bump(v,p+40,dz);bump(v,p+44,dx);bump(v,p+48,yOffset);bump(v,p+52,dz);
      }
    }
  }
  return out;
}
const bitCount=n=>{let c=0;for(;n;n&=n-1)c++;return c;};

/** Copy of a (translated) tile at (tx,ty) with every terrain vertex re-heighted by `height(x,z,h)` (chart coordinates of a body whose centre tile is cx,cy).
 * Used to end the graft at the dome footprint circle and hand over to the procedural moon. */
export function reshapeAdt(bytes,{tile:[tx,ty],cx,cy,height,keep}) {
  const out=bytes.slice(),v=new DataView(out.buffer,out.byteOffset,out.byteLength),step=TILE/128;
  for(const c of adtChunks(out)) {
    // Placements outside `keep` (chart x,z) get an out-of-range name index, which the tile builder skips; sizes and offsets stay put.
    if(keep&&(c.magic==='MDDF'||c.magic==='MODF')) {
      const len=c.magic==='MDDF'?36:64;
      for(let p=c.start;p+len<=c.start+c.size;p+=len)if(!keep(v.getFloat32(p+8,true)-cx*TILE,v.getFloat32(p+16,true)-cy*TILE))v.setUint32(p,0xffffffff,true);
    }
    if(c.magic==='MCNK'&&c.size>=MCNK_HEADER) {
      const ix=v.getUint32(c.start+4,true),iy=v.getUint32(c.start+8,true),base=v.getFloat32(c.start+0x70,true),x0=(tx-cx)*TILE+ix*TILE/16,z0=(ty-cy)*TILE+iy*TILE/16;
      for(const s of adtChunks(out,c.start+MCNK_HEADER,c.start+c.size)) {
        if(s.magic!=='MCVT')continue;
        for(let i=0;i<145;i++) {
          const row=Math.floor(i/17),k=i%17,inner=k>=9,col=inner?k-9:k,x=x0+(col+(inner?.5:0))*step,z=z0+(row+(inner?.5:0))*step,p=s.start+i*4;
          v.setFloat32(p,height(x,z,base+v.getFloat32(p,true))-base,true);
        }
      }
    }
  }
  return out;
}

/** Cut a (translated) graft tile at a boundary: every MCNK whose centre fails `inside(x,z)` (chart yd) is replaced by the same chunk of `procedural` (a synthAdt of one regolith layer), whose
 * layer then points at `groundTexture`, appended to this tile's MTEX. Terrain, ground layers, alpha, liquids and area id all switch together, chunk by chunk, so no graft texture is left outside. */
export function cutAdt(bytes,procedural,{tile:[tx,ty],cx,cy,inside,groundTexture}) {
  const src=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),procChunks=[];
  for(const c of adtChunks(procedural))if(c.magic==='MCNK')procChunks.push(c);
  const parts=[];let texIndex=0;
  for(const c of adtChunks(bytes)) {
    const raw=bytes.subarray(c.start-8,c.start+c.size);
    if(c.magic==='MTEX') {
      const names=new TextDecoder().decode(bytes.subarray(c.start,c.start+c.size)).split('\0').filter(Boolean);texIndex=names.length;
      const body=new TextEncoder().encode(names.concat(groundTexture).join('\0')+'\0'),out=new Uint8Array(8+body.length);
      out.set(raw.subarray(0,4));new DataView(out.buffer).setUint32(4,body.length,true);out.set(body,8);parts.push(out);continue;
    }
    if(c.magic==='MCNK'&&c.size>=MCNK_HEADER) {
      const ix=src.getUint32(c.start+4,true),iy=src.getUint32(c.start+8,true);
      if(!inside((tx-cx)*TILE+(ix+.5)*TILE/16,(ty-cy)*TILE+(iy+.5)*TILE/16)) {
        const p=procChunks[iy*16+ix],swapped=procedural.slice(p.start-8,p.start+p.size),pv=new DataView(swapped.buffer);
        for(const s of adtChunks(swapped,8+MCNK_HEADER,swapped.length))if(s.magic==='MCLY')pv.setUint32(s.start,texIndex,true);
        parts.push(swapped);continue;
      }
    }
    parts.push(raw);
  }
  const out=new Uint8Array(parts.reduce((n,a)=>n+a.length,0));let at=0;for(const a of parts){out.set(a,at);at+=a.length;}
  return out;
}

/** Mask a DXT1 minimap BLP2 (all mip levels) to a boundary: each 4x4 block whose centre fails `inside(u,v)` (0..1 across the tile, v south) becomes flat `rgb`. Other encodings pass through unchanged. */
export function maskMinimap(blp,inside,rgb=[165,152,112]) {
  const v0=new DataView(blp.buffer,blp.byteOffset,blp.byteLength);
  if(blp.length<148||blp[8]!==2||blp[9]!==0)return blp;
  const out=blp.slice(),ov=new DataView(out.buffer),w0=v0.getUint32(12,true),h0=v0.getUint32(16,true),flat=((rgb[0]>>3)<<11)|((rgb[1]>>2)<<5)|(rgb[2]>>3);
  for(let m=0;m<16;m++) {
    const at=v0.getUint32(20+m*4,true),size=v0.getUint32(84+m*4,true);if(!at||!size)continue;
    const w=Math.max(1,w0>>m),h=Math.max(1,h0>>m),bw=Math.max(1,w>>2),bh=Math.max(1,h>>2);
    for(let by=0;by<bh;by++)for(let bx=0;bx<bw;bx++) {
      const p=at+(by*bw+bx)*8;if(p+8>out.length)continue;
      if(inside(Math.min(1,(bx*4+2)/w),Math.min(1,(by*4+2)/h)))continue;
      ov.setUint16(p,flat,true);ov.setUint16(p+2,flat,true);ov.setUint32(p+4,0,true);
    }
  }
  return out;
}

/** Height range of an ADT's terrain (posZ + MCVT), used to pick the graft's yOffset. Returns {min,max,mean}. */
export function adtHeights(bytes) {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let min=Infinity,max=-Infinity,sum=0,n=0;
  for(const c of adtChunks(bytes)) {
    if(c.magic!=='MCNK'||c.size<MCNK_HEADER)continue;
    const z=v.getFloat32(c.start+0x70,true);
    for(const s of adtChunks(bytes,c.start+MCNK_HEADER,c.start+c.size)) {
      if(s.magic!=='MCVT')continue;
      for(let i=0;i<145;i++){const h=z+v.getFloat32(s.start+i*4,true);min=Math.min(min,h);max=Math.max(max,h);sum+=h;n++;}
    }
  }
  return {min,max,mean:n?sum/n:0};
}
