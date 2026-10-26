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
