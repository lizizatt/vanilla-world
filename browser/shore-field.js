// Smoothed shore field for the visual beach waves (beach-waves.js). Visual only: it never feeds the physics.
// The world worker classifies a camera-centred grid (land / water / open sea) with the physics' own queries; the renderer turns the classes
// into one RGBA texture: R signed distance to the waterline (yd, + is water), G/B the seaward unit normal averaged over a coarse neighbourhood
// (so tidepools and small inlets do not steer the wave trains), A confidence of that normal x "a real body of water is nearby" (rivers and puddles drop out).
export const SHORE_N=96,SHORE_CELL=8,SHORE_REFRESH=128;
export const SHORE_D_MIN=-16,SHORE_D_MAX=80,SEA_LEVEL_TOLERANCE=3;
const NORMAL_TURN=[.06,.16],NORMAL_ALIGN=[.3,.7];
const CONTOUR_BLUR=1,NORMAL_BLUR=4,NORMAL_PASSES=3,OPEN_BLUR=8;
// The tile liquid's depth ramp V is clamp(byte/255) with the sea authored at 1.72 byte/yd (liquid.rs), so V = depth/148.3 yd. Each class byte carries it in bits 2..7 so the wave clipmap can tint like the tile water it replaces.
export const SHORE_RAMP_YD=148.3,SHORE_RAMP_LEVELS=63;
export const shoreClass=v=>v&3;
const smoothstep=(e0,e1,x)=>{const s=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return s*s*(3-2*s);};

/** Class grid rows: 0 land (or no water), 1 water (or a tile that is not resident yet, so a streaming edge never reads as a coast), 2 water where the physics wave amplitude is > 0 (offshore of tile-granular land, so informational only). Bits 2..7 hold the liquid depth ramp (63 = deep or unknown). Same slicing as buildWaveMask. */
export function buildShoreClasses(sampleBatch,surface,center,rowStart=0,rowCount=SHORE_N){
  const ox=Math.round(center[0]/SHORE_CELL-SHORE_N/2)*SHORE_CELL,oz=Math.round(center[1]/SHORE_CELL-SHORE_N/2)*SHORE_CELL;
  const total=rowCount*SHORE_N,base=rowStart*SHORE_N,data=new Uint8Array(total),points=new Float64Array(total*2);
  for(let n=0;n<total;n++){const t=base+n;points[n*2]=ox+(t%SHORE_N+.5)*SHORE_CELL;points[n*2+1]=oz+(Math.floor(t/SHORE_N)+.5)*SHORE_CELL;}
  const out=sampleBatch(points);
  for(let n=0;n<total;n++){
    const s=surface(points[n*2],points[n*2+1]),water=out[n*8];
    if(s[0]!==0){data[n]=1|SHORE_RAMP_LEVELS<<2;continue;}
    // The beach layer is drawn on the flat sea plane, so inland water at another height (basin ponds, mountain lakes) is not a shore: it would float over/under the terrain.
    if(Number.isNaN(water)||s[1]>=water||Math.abs(water)>SEA_LEVEL_TOLERANCE)continue;
    data[n]=(out[n*8+7]>0?2:1)|Math.round(Math.min(1,(water-s[1])/SHORE_RAMP_YD)*SHORE_RAMP_LEVELS)<<2;
  }
  return {origin:[ox,oz],cell:SHORE_CELL,n:SHORE_N,data,rowStart};
}

// Two-pass chamfer distance (cells) from every cell to the nearest cell where `source` is true.
function distanceTo(source,n){
  const d=new Float32Array(n*n).fill(1e9),S2=Math.SQRT2;
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const k=j*n+i;let v=source[k]?0:d[k];
    if(i>0)v=Math.min(v,d[k-1]+1);
    if(j>0){v=Math.min(v,d[k-n]+1);if(i>0)v=Math.min(v,d[k-n-1]+S2);if(i<n-1)v=Math.min(v,d[k-n+1]+S2);}
    d[k]=v;
  }
  for(let j=n-1;j>=0;j--)for(let i=n-1;i>=0;i--){
    const k=j*n+i;let v=d[k];
    if(i<n-1)v=Math.min(v,d[k+1]+1);
    if(j<n-1){v=Math.min(v,d[k+n]+1);if(i<n-1)v=Math.min(v,d[k+n+1]+S2);if(i>0)v=Math.min(v,d[k+n-1]+S2);}
    d[k]=v;
  }
  return d;
}
// Separable box blur with clamped edges.
function boxBlur(src,n,radius,passes=1){
  let a=Float32Array.from(src),b=new Float32Array(n*n);
  const w=2*radius+1;
  for(let p=0;p<passes;p++){
    for(let j=0;j<n;j++){let s=0;for(let i=-radius;i<=radius;i++)s+=a[j*n+Math.min(n-1,Math.max(0,i))];
      for(let i=0;i<n;i++){b[j*n+i]=s/w;s+=a[j*n+Math.min(n-1,i+radius+1)]-a[j*n+Math.max(0,i-radius)];}}
    for(let i=0;i<n;i++){let s=0;for(let j=-radius;j<=radius;j++)s+=b[Math.min(n-1,Math.max(0,j))*n+i];
      for(let j=0;j<n;j++){a[j*n+i]=s/w;s+=b[Math.min(n-1,j+radius+1)*n+i]-b[Math.max(0,j-radius)*n+i];}}
  }
  return a;
}

// Morphological opening: drops land features up to 2 cells wide (tile-seam sample glitches, single-cell rocks) but keeps real coast.
function openLand(land,n){
  const pass=(src,all)=>{
    const out=new Uint8Array(n*n);
    for(let j=0;j<n;j++)for(let i=0;i<n;i++){
      let hit=all?1:0;
      for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){
        const v=src[Math.min(n-1,Math.max(0,j+dj))*n+Math.min(n-1,Math.max(0,i+di))];
        if(all)hit&=v;else hit|=v;
      }
      out[j*n+i]=hit;
    }
    return out;
  };
  land.set(pass(pass(land,true),false));
}

/** Class grid -> {sdf (yd, smoothed), nx, nz (seaward, unit or 0), conf, open}, all Float32 n*n. Pure and deterministic. */
export function shoreSolve(classes,n=SHORE_N,cell=SHORE_CELL){
  const land=new Uint8Array(n*n),open=new Uint8Array(n*n);
  for(let k=0;k<n*n;k++){const c=shoreClass(classes[k]);land[k]=c===0?1:0;open[k]=c!==0?1:0;}
  openLand(land,n);
  const water=land.map(v=>1-v),toLand=distanceTo(land,n),toWater=distanceTo(water,n),signed=new Float32Array(n*n);
  for(let k=0;k<n*n;k++)signed[k]=Math.min(SHORE_D_MAX,Math.max(SHORE_D_MIN,(land[k]?-(toWater[k]-.5):toLand[k]-.5)*cell));
  const sdf=boxBlur(signed,n,CONTOUR_BLUR,2);
  // Averaged normal: gradient of the heavily blurred land indicator. Features narrower than the blur (tidepools, small inlets) cancel out.
  const L=boxBlur(Float32Array.from(land),n,NORMAL_BLUR,NORMAL_PASSES),nx=new Float32Array(n*n),nz=new Float32Array(n*n),conf=new Float32Array(n*n);
  const at=(i,j)=>L[Math.min(n-1,Math.max(0,j))*n+Math.min(n-1,Math.max(0,i))];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const gx=(at(i+1,j)-at(i-1,j))/2,gz=(at(i,j+1)-at(i,j-1))/2,m=Math.hypot(gx,gz),k=j*n+i;
    if(m>1e-6){nx[k]=-gx/m;nz[k]=-gz/m;}
    conf[k]=smoothstep(.008,.03,m);
  }
  // Low-confidence zones: where the averaged normal turns fast (converging/diverging around small islands and narrow shoals, saddles between them)
  // or disagrees with the contour's own gradient, wave phase along the coast aliases and the shoreward displacement stretches crests into spikes.
  // Both factors are ~1 on a straight or gently curved coast, so those look as before.
  const nAt=(i,j)=>{const q=Math.min(n-1,Math.max(0,j))*n+Math.min(n-1,Math.max(0,i));return q;};
  const raw=conf.slice();
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const k=j*n+i;if(raw[k]<=0)continue;
    let v=0;
    for(const [di,dj] of [[1,0],[0,1],[1,1],[1,-1]]){
      const a=nAt(i+di,j+dj),b=nAt(i-di,j-dj);
      v=Math.max(v,Math.hypot(nx[a]-nx[b],nz[a]-nz[b])/(2*Math.hypot(di,dj)));
    }
    const sx=(sdf[nAt(i+1,j)]-sdf[nAt(i-1,j)])/2,sz=(sdf[nAt(i,j+1)]-sdf[nAt(i,j-1)])/2,sm=Math.hypot(sx,sz);
    const align=sm>.5*cell?(nx[k]*sx+nz[k]*sz)/sm:1;
    conf[k]=raw[k]*(1-smoothstep(NORMAL_TURN[0],NORMAL_TURN[1],v))*smoothstep(NORMAL_ALIGN[0],NORMAL_ALIGN[1],align);
  }
  return {sdf,nx,nz,conf,open:boxBlur(Float32Array.from(open),n,OPEN_BLUR)};
}

/** RGBA8 texture bytes of the shore field (row-major, texel (i,j) covers cell (i,j) of the class grid). */
export function shoreTexture(classes,n=SHORE_N,cell=SHORE_CELL){
  const f=shoreSolve(classes,n,cell),out=new Uint8Array(n*n*4),q=v=>Math.round(Math.min(1,Math.max(0,v))*255);
  for(let k=0;k<n*n;k++){
    out[k*4]=q((f.sdf[k]-SHORE_D_MIN)/(SHORE_D_MAX-SHORE_D_MIN));out[k*4+1]=q(.5+.5*f.nx[k]);out[k*4+2]=q(.5+.5*f.nz[k]);
    out[k*4+3]=q(f.conf[k]*smoothstep(.12,.35,f.open[k]));
  }
  return out;
}
/** R8 texture bytes of the liquid depth ramp (0 shore .. 255 deep) per cell; land cells are 0, like the tile ramp at the waterline. */
export function shoreDepthTexture(classes,n=SHORE_N){
  const out=new Uint8Array(n*n);
  for(let k=0;k<n*n;k++)out[k]=Math.round((classes[k]>>2)/SHORE_RAMP_LEVELS*255);
  return out;
}
/** CPU mirror of the shader read: bilinear shore field at chart (x,z) -> {d, n:[x,z], weight}; weight 0 outside the window. */
export function shoreAt(tex,origin,x,z,n=SHORE_N,cell=SHORE_CELL){
  const u=(x-origin[0])/cell-.5,v=(z-origin[1])/cell-.5;
  if(u<-.5||v<-.5||u>n-.5||v>n-.5)return {d:SHORE_D_MAX,n:[0,0],weight:0};
  const i=Math.floor(u),j=Math.floor(v),fx=u-i,fz=v-j,out=[0,0,0,0];
  for(const [di,dj,w] of [[0,0,(1-fx)*(1-fz)],[1,0,fx*(1-fz)],[0,1,(1-fx)*fz],[1,1,fx*fz]]){
    const k=(Math.min(n-1,Math.max(0,j+dj))*n+Math.min(n-1,Math.max(0,i+di)))*4;
    for(let c=0;c<4;c++)out[c]+=w*tex[k+c]/255;
  }
  const nx=out[1]*2-1,nz=out[2]*2-1,len=Math.hypot(nx,nz)||1;
  return {d:SHORE_D_MIN+out[0]*(SHORE_D_MAX-SHORE_D_MIN),n:[nx/len,nz/len],weight:out[3]};
}
