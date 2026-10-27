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
export function reshapeAdt(bytes,{tile:[tx,ty],cx,cy,height,keep,lift}) {
  const out=bytes.slice(),v=new DataView(out.buffer,out.byteOffset,out.byteLength),step=TILE/128;
  for(const c of adtChunks(out)) {
    // Placements outside `keep` (chart x,z) get an out-of-range name index, which the tile builder skips; sizes and offsets stay put. `lift(x,z)` raises the ones that stay (terrain was re-heighted under them).
    if((keep||lift)&&(c.magic==='MDDF'||c.magic==='MODF')) {
      const len=c.magic==='MDDF'?36:64;
      for(let p=c.start;p+len<=c.start+c.size;p+=len) {
        const x=v.getFloat32(p+8,true)-cx*TILE,z=v.getFloat32(p+16,true)-cy*TILE;
        if(keep&&!keep(x,z)){v.setUint32(p,0xffffffff,true);continue;}
        const dy=lift?lift(x,z):0;
        if(dy){bump(v,p+12,dy);if(len===64){bump(v,p+36,dy);bump(v,p+48,dy);}}
      }
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

const ALPHA=2048,MAX_LAYERS=4;
/** Re-texture one MCNK (bytes including its 8-byte header) so the ground texture `groundIndex` covers every texel where `inside(u,v)` (0..1 across the chunk, u east, v south) is false and the
 * chunk's own layers survive only where it is true. The regolith becomes the new base layer; the old base layer turns into a masked alpha layer, and at most MAX_LAYERS layers are kept
 * (the topmost original is dropped when a chunk already has four). Header offsets and sizes are rebuilt; the 64x64 4-bit alpha maps are cut per texel, with no blend band. */
export function maskChunkTextures(raw,groundIndex,inside) {
  const body=raw.subarray(8),bv=new DataView(body.buffer,body.byteOffset,body.byteLength);
  if(body.length<MCNK_HEADER+8)return raw;
  const conv=bv.getUint32(0x14,true)-MCNK_HEADER,pos=f=>bv.getUint32(f,true)-conv;
  const mly=pos(0x1c);if(!(mly>=MCNK_HEADER)||mly+8>body.length)return raw;
  const count=bv.getUint32(mly+4,true)/16;if(!(count>=1)||mly+8+count*16>body.length)return raw;
  const malPos=pos(0x24),hasMal=bv.getUint32(0x24,true)>0&&malPos+8<=body.length&&bv.getUint32(malPos+4,true)>0,malLen=hasMal?bv.getUint32(malPos+4,true):0;
  const sizeBias=hasMal?bv.getUint32(0x28,true)-malLen:0;
  const keep=Math.min(count,MAX_LAYERS-1),layers=[],alphas=[];
  for(let k=0;k<keep;k++) {
    const p=mly+8+k*16,tex=bv.getUint32(p,true),flags=bv.getUint32(p+4,true),offs=bv.getUint32(p+8,true),eff=bv.getUint32(p+12,true),a=new Uint8Array(64*64).fill(15);
    if(k>0&&(flags&0x100)&&!(flags&0x200)&&hasMal&&offs+ALPHA<=malLen) {
      for(let i=0;i<64*64;i++){const byte=body[malPos+8+offs+(i>>1)];a[i]=i&1?byte>>4:byte&15;}
    }
    layers.push({tex,flags:flags|0x100,eff});alphas.push(a);
  }
  const mask=new Uint8Array(64*64);
  for(let r=0;r<64;r++)for(let c=0;c<64;c++)mask[r*64+c]=inside((c+.5)/64,(r+.5)/64)?15:0;
  for(const a of alphas)for(let i=0;i<a.length;i++)a[i]=a[i]&&mask[i]?a[i]:0;
  alphas[0]=mask;
  const total=layers.length+1,mlyOut=new Uint8Array(8+total*16),mv=new DataView(mlyOut.buffer);
  mlyOut.set(body.subarray(mly,mly+4));mv.setUint32(4,total*16,true);
  mv.setUint32(8,groundIndex,true);
  layers.forEach((l,k)=>{const p=8+(k+1)*16;mv.setUint32(p,l.tex,true);mv.setUint32(p+4,l.flags,true);mv.setUint32(p+8,k*ALPHA,true);mv.setUint32(p+12,l.eff,true);});
  const malOut=new Uint8Array(8+layers.length*ALPHA);
  malOut.set(hasMal?body.subarray(malPos,malPos+4):[0x4c,0x41,0x43,0x4d]);new DataView(malOut.buffer).setUint32(4,layers.length*ALPHA,true);
  alphas.forEach((a,k)=>{for(let i=0;i<4096;i+=2)malOut[8+k*ALPHA+(i>>1)]=a[i]|(a[i+1]<<4);});
  const mlyOldLen=8+count*16,edits=[{at:mly,remove:mlyOldLen,put:mlyOut}];
  let malAt;
  if(hasMal)edits.push({at:malPos,remove:8+malLen,put:malOut});
  else {
    const later=[0x58,0x60].map(f=>bv.getUint32(f,true)).filter(o=>o>0).map(o=>o-conv).filter(p=>p>mly);
    malAt=later.length?Math.min(...later):body.length;edits.push({at:malAt,remove:0,put:malOut});
  }
  edits.sort((a,b)=>a.at-b.at);
  const shift=old=>old+edits.reduce((n,e)=>n+((e.at<old||(e.at===old&&e.remove===0))?e.put.length-e.remove:0),0);
  const parts=[];let at=0;
  for(const e of edits){parts.push(body.subarray(at,e.at),e.put);at=e.at+e.remove;}
  parts.push(body.subarray(at));
  const nb=new Uint8Array(parts.reduce((n,a)=>n+a.length,0));let w=0;for(const a of parts){nb.set(a,w);w+=a.length;}
  const nv=new DataView(nb.buffer);
  for(const f of [0x14,0x18,0x1c,0x20,0x24,0x2c,0x58,0x60]) {
    const o=bv.getUint32(f,true);if(o>0)nv.setUint32(f,shift(o-conv)+conv,true);
  }
  const newMal=hasMal?shift(malPos):shift(malAt);
  nv.setUint32(0x24,newMal+conv,true);nv.setUint32(0x28,layers.length*ALPHA+sizeBias,true);
  nv.setUint32(0x0c,total,true);
  const out=new Uint8Array(8+nb.length);out.set(raw.subarray(0,8));new DataView(out.buffer).setUint32(4,nb.length,true);out.set(nb,8);
  return out;
}

/** Cut a (translated) graft tile at a boundary. Each MCNK is classified by `relation(x0,z0,x1,z1)` (its chart rectangle, yd): 'inside' keeps the graft chunk, 'outside' swaps in the same chunk of
 * `procedural` (a synthAdt of one regolith layer) whose layer points at `groundTexture` (appended to this tile's MTEX), and 'partial' keeps the graft chunk but re-textures it per texel with
 * `inside(x,z)` so ground layers end exactly on the boundary. The area id follows the chunk centre. Heights are cut per vertex by reshapeAdt, not here. */
export function cutAdt(bytes,procedural,{tile:[tx,ty],cx,cy,inside,relation,groundTexture}) {
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
      const x0=(tx-cx)*TILE+ix*TILE/16,z0=(ty-cy)*TILE+iy*TILE/16,rel=relation(x0,z0,x0+TILE/16,z0+TILE/16);
      if(rel==='outside') {
        const p=procChunks[iy*16+ix],swapped=procedural.slice(p.start-8,p.start+p.size),pv=new DataView(swapped.buffer);
        for(const s of adtChunks(swapped,8+MCNK_HEADER,swapped.length))if(s.magic==='MCLY')pv.setUint32(s.start,texIndex,true);
        parts.push(swapped);continue;
      }
      if(rel==='partial') {
        const cut=maskChunkTextures(raw,texIndex,(u,v)=>inside(x0+u*TILE/16,z0+v*TILE/16)),cv=new DataView(cut.buffer);
        if(!inside(x0+TILE/32,z0+TILE/32)){const p=procChunks[iy*16+ix];cv.setUint32(8+0x34,new DataView(procedural.buffer,procedural.byteOffset).getUint32(p.start+0x34,true),true);}
        parts.push(cut);continue;
      }
    }
    parts.push(raw);
  }
  const out=new Uint8Array(parts.reduce((n,a)=>n+a.length,0));let at=0;for(const a of parts){out.set(a,at);at+=a.length;}
  return out;
}

/** Mask a DXT1 minimap BLP2 (all mip levels) to a boundary: each 4x4 block whose centre fails `inside(u,v)` (0..1 across the tile, v south) becomes flat `rgb`. Other encodings pass through unchanged. */
export function maskMinimap(blp,inside,rgb=[140,140,140],fill) {
  const v0=new DataView(blp.buffer,blp.byteOffset,blp.byteLength);
  if(blp.length<148||blp[8]!==2||blp[9]!==0)return blp;
  const out=blp.slice(),ov=new DataView(out.buffer),w0=v0.getUint32(12,true),h0=v0.getUint32(16,true),c565=c=>((c[0]>>3)<<11)|((c[1]>>2)<<5)|(c[2]>>3),flat=c565(rgb);
  for(let m=0;m<16;m++) {
    const at=v0.getUint32(20+m*4,true),size=v0.getUint32(84+m*4,true);if(!at||!size)continue;
    const w=Math.max(1,w0>>m),h=Math.max(1,h0>>m),bw=Math.max(1,w>>2),bh=Math.max(1,h>>2);
    for(let by=0;by<bh;by++)for(let bx=0;bx<bw;bx++) {
      const p=at+(by*bw+bx)*8;if(p+8>out.length)continue;
      const u=Math.min(1,(bx*4+2)/w),vv=Math.min(1,(by*4+2)/h);if(inside(u,vv))continue;const f=fill?c565(fill(u,vv)):flat;
      ov.setUint16(p,f,true);ov.setUint16(p+2,f,true);ov.setUint32(p+4,0,true);
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
