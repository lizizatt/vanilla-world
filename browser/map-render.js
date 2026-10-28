// Procedural parchment world map, generated entirely in code from the far terrain the player's own data has already streamed
// (WDL heights and tile minimap colour). Nothing here is, or is derived from, shipped art: the parchment, hatching, frame,
// Maelstrom swirl and moon are drawn from formulas. The chart is the panel's own frame (worldmap.js mapFrame/toMap), so icons align by construction.
const TILE=1600/3;
export const MAP_CELL=TILE/8;
const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const mix=(a,b,t)=>a+(b-a)*t;
const hash=(x,y)=>{let h=Math.imul(x|0,374761393)+Math.imul(y|0,668265263);h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967296;};
const noise=(x,y)=>{const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
  return mix(mix(hash(ix,iy),hash(ix+1,iy),sx),mix(hash(ix,iy+1),hash(ix+1,iy+1),sx),sy);};

/** Chart-space accumulation grid (one cell = 1/8 tile) fed by the far-terrain events: mean height and mean minimap colour per cell. */
export class MapRaster {
  constructor(manifest) {
    const rs=manifest.regions,span=(r,i)=>(r.tile_count?.[i]??64)*TILE;
    this.x0=Math.min(...rs.map(r=>r.placement[0]));this.z0=Math.min(...rs.map(r=>r.placement[1]));
    const x1=Math.max(...rs.map(r=>r.placement[0]+span(r,0))),z1=Math.max(...rs.map(r=>r.placement[1]+span(r,1)));
    this.w=Math.ceil((x1-this.x0)/MAP_CELL);this.h=Math.ceil((z1-this.z0)/MAP_CELL);
    this.hsum=new Float32Array(this.w*this.h);this.hn=new Uint16Array(this.w*this.h);
    this.csum=new Float32Array(this.w*this.h*3);this.cn=new Uint16Array(this.w*this.h);
    this.tiles=new Set();this.revision=0;
  }
  cell(x,z) {
    const cx=Math.floor((x-this.x0)/MAP_CELL),cz=Math.floor((z-this.z0)/MAP_CELL);
    return cx<0||cz<0||cx>=this.w||cz>=this.h?-1:cz*this.w+cx;
  }
  /** Horizon mesh vertices (x,y,z,... stride 7, relative to the tile placement). */
  addHeights(vertices,placement) {
    for(let i=0;i<vertices.length;i+=7){const k=this.cell(placement[0]+vertices[i],placement[1]+vertices[i+2]);if(k<0)continue;this.hsum[k]+=vertices[i+1];this.hn[k]++;}
    this.tiles.add(`${placement[0]|0},${placement[1]|0}`);this.revision++;
  }
  /** One tile's size x size RGBA minimap; tiles are 533.33 yd squares starting at placement. */
  addMinimap(rgba,placement,size=32) {
    for(let py=0;py<size;py++)for(let px=0;px<size;px++){
      const i=(py*size+px)*4;if(rgba[i+3]<128)continue;
      const k=this.cell(placement[0]+(px+.5)/size*TILE,placement[1]+(py+.5)/size*TILE);if(k<0)continue;
      this.csum[k*3]+=rgba[i]/255;this.csum[k*3+1]+=rgba[i+1]/255;this.csum[k*3+2]+=rgba[i+2]/255;this.cn[k]++;
    }
    this.revision++;
  }
}

/** Separable box blur (edge-clamped) of an interleaved array, in place via a scratch copy. */
export function boxBlur(src,w,h,r,stride=1) {
  const it=boxBlurSteps(src,w,h,r,stride);let v;while(!(v=it.next()).done);return v.value;
}
/** Generator form of boxBlur: yields every few rows/columns so callers can slice it. */
export function* boxBlurSteps(src,w,h,r,stride=1) {
  const out=new Float32Array(src.length),tmp=new Float32Array(src.length),n=2*r+1;
  for(let y=0;y<h;y++)for(let c=0;c<stride;c++){
    if(y%32===0&&c===0)yield;
    let s=0;for(let k=-r;k<=r;k++)s+=src[(y*w+Math.min(w-1,Math.max(0,k)))*stride+c];
    for(let x=0;x<w;x++){tmp[(y*w+x)*stride+c]=s/n;s+=src[(y*w+Math.min(w-1,x+r+1))*stride+c]-src[(y*w+Math.max(0,x-r))*stride+c];}
  }
  for(let x=0;x<w;x++)for(let c=0;c<stride;c++){
    if(x%32===0&&c===0)yield;
    let s=0;for(let k=-r;k<=r;k++)s+=tmp[(Math.min(h-1,Math.max(0,k))*w+x)*stride+c];
    for(let y=0;y<h;y++){out[(y*w+x)*stride+c]=s/n;s+=tmp[(Math.min(h-1,y+r+1)*w+x)*stride+c]-tmp[(Math.max(0,y-r)*w+x)*stride+c];}
  }
  return out;
}

const PARCHMENT=[226,208,158],SEA_NEAR=[208,208,182],SEA_DEEP=[170,184,176],INK=[62,40,24];
/** Terrain colour by height (yd) when no minimap colour is known: lowland green, foothill ochre, highland brown, peaks pale. */
export function heightColour(h) {
  const t=Math.min(1,Math.max(0,h/1800)),stops=[[0,[128,152,80]],[.3,[176,160,92]],[.65,[150,116,82]],[1,[230,224,210]]];
  for(let i=1;i<stops.length;i++)if(t<=stops[i][0]){const [a,ca]=stops[i-1],[b,cb]=stops[i],f=(t-a)/(b-a);return ca.map((v,k)=>mix(v,cb[k],f));}
  return stops[3][1];
}

/**
 * Per-cell fields from a raster: `land` (blurred 0..1 coast field), `reach` (wide blur for sea ripples), and `rgb` (final land colour with
 * minimap/height tint and hillshade baked in). Pure: typed arrays in, typed arrays out.
 */
export function mapFields(raster,sea=0) {
  const it=mapFieldsSteps(raster,sea);let r;while(!(r=it.next()).done);return r.value;
}
/** Generator form of mapFields: yields between stages and every few rows so a caller can slice the work across frames. */
export function* mapFieldsSteps(raster,sea=0) {
  const {w,h,hsum,hn,csum,cn}=raster,n=w*h,H=new Float32Array(n),L=new Float32Array(n),Cs=new Float32Array(n*3),M=new Float32Array(n);
  for(let k=0;k<n;k++){
    if(k%16384===0)yield;
    if(hn[k]){const v=hsum[k]/hn[k];if(v>sea+1){L[k]=1;H[k]=v;}}
    if(cn[k]&&L[k]){M[k]=1;for(let c=0;c<3;c++)Cs[k*3+c]=csum[k*3+c]/cn[k];}
  }
  const land=yield* boxBlurSteps(L,w,h,1);
  let reach=yield* boxBlurSteps(L,w,h,10);reach=yield* boxBlurSteps(reach,w,h,10);reach=yield* boxBlurSteps(reach,w,h,10);
  const Hs=yield* boxBlurSteps(yield* boxBlurSteps(H,w,h,1),w,h,1);
  const Cb=yield* boxBlurSteps(Cs,w,h,2,3),Mb=yield* boxBlurSteps(M,w,h,2),rgb=new Float32Array(n*3);
  for(let y=0;y<h;y++){if(y%6===0)yield;for(let x=0;x<w;x++){
    const k=y*w+x;
    if(land[k]<.05){rgb.set(PARCHMENT,k*3);continue;}
    const base=Mb[k]>.04?[Cb[k*3]/Mb[k]*255,Cb[k*3+1]/Mb[k]*255,Cb[k*3+2]/Mb[k]*255]:heightColour(Hs[k]);
    const dx=(Hs[y*w+Math.min(w-1,x+1)]-Hs[y*w+Math.max(0,x-1)])/(2*MAP_CELL)*2.4,dz=(Hs[Math.min(h-1,y+1)*w+x]-Hs[Math.max(0,y-1)*w+x])/(2*MAP_CELL)*2.4;
    const lit=(.45*dx+.8+.45*dz)/Math.hypot(dx,1,dz)/.8,shade=Math.min(1.5,Math.max(.55,lit));
    for(let c=0;c<3;c++)rgb[k*3+c]=Math.min(255,mix(base[c],PARCHMENT[c],.34)*shade);
  }}
  return {w,h,land,reach,rgb};
}

const bilinear=(a,w,h,fx,fy,stride=1,c=0)=>{
  const x=Math.min(w-1,Math.max(0,fx)),y=Math.min(h-1,Math.max(0,fy)),x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),tx=x-x0,ty=y-y0;
  return mix(mix(a[(y0*w+x0)*stride+c],a[(y0*w+x1)*stride+c],tx),mix(a[(y1*w+x0)*stride+c],a[(y1*w+x1)*stride+c],tx),ty);
};

/** Shade the fields into an RGBA map for `frame` ({x0,z0,width,height} in render space) at width x height pixels: land tint + hillshade, ink coast, ripple-hatched sea, paper grain and vignette. */
export function shadeMap(fields,raster,frame,width,height,out=new Uint8ClampedArray(width*height*4)) {
  const it=shadeSteps(fields,raster,frame,width,height,out);while(!it.next().done);return out;
}
export function* shadeSteps(fields,raster,frame,width,height,out) {
  const {w,h,land,reach,rgb}=fields,sx=frame.width/width,sz=frame.height/height;
  for(let py=0;py<height;py++){
    if(py%4===0)yield;
    const fy=(frame.z0+(py+.5)*sz-raster.z0)/MAP_CELL-.5,vy=(py+.5)/height-.5;
    for(let px=0;px<width;px++){
      const fx=(frame.x0+(px+.5)*sx-raster.x0)/MAP_CELL-.5,vx=(px+.5)/width-.5;
      const L=bilinear(land,w,h,fx,fy),F=bilinear(reach,w,h,fx,fy);
      const side=smooth(.42,.58,L),col=[0,0,0];
      // sea: lighter wash near the coast, ripple lines following the coast outward
      const wash=smooth(0,.35,F),ripple=F>.015&&F<.42?Math.max(0,Math.cos(F*70))**6*.22*smooth(.015,.06,F)*(1-smooth(.3,.42,F)):0;
      for(let c=0;c<3;c++)col[c]=mix(SEA_DEEP[c],SEA_NEAR[c],wash)*(1-ripple)+INK[c]*ripple*.5;
      if(side>0){
        for(let c=0;c<3;c++){const g=bilinear(rgb,w,h,fx,fy,3,c);col[c]=mix(col[c],g>0?g:PARCHMENT[c],side);}
      }
      const coast=1-smooth(0,.11,Math.abs(L-.5));
      for(let c=0;c<3;c++)col[c]=mix(col[c],INK[c],coast*.78);
      const paper=.94+.06*(noise(px*.9,py*.9)-.5)*2+.05*(noise(px/7,py/7)-.5)*2+.08*(noise(px/60+9,py/60)-.5)*2,
        edge=Math.hypot(vx*2,vy*2),vignette=1-.38*smooth(.55,1.05,edge);
      const i=(py*width+px)*4,m=paper*vignette;
      out[i]=col[0]*m;out[i+1]=col[1]*m;out[i+2]=col[2]*m;out[i+3]=255;
    }
  }
  return out;
}

/** Original decorative layer drawn with 2D canvas calls: Maelstrom swirl, Elune's moon disc, compass and frame. Positions are pixel coordinates. */
export function drawDecor(ctx,width,height,{maelstrom,moon,moonRadius=Math.min(width,height)*.06,swirlRadius=Math.min(width,height)*.085}) {
  if(maelstrom){
    ctx.save();ctx.translate(...maelstrom);ctx.lineCap='round';
    for(let arm=0;arm<4;arm++){
      ctx.beginPath();
      for(let t=0;t<=1;t+=.02){const a=arm*Math.PI/2+t*7,r=t*swirlRadius,x=Math.cos(a)*r,y=Math.sin(a)*r;if(t===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
      ctx.strokeStyle='rgba(52,66,78,.55)';ctx.lineWidth=Math.max(1,swirlRadius*.035);ctx.stroke();
    }
    ctx.beginPath();ctx.arc(0,0,swirlRadius*.07,0,Math.PI*2);ctx.fillStyle='rgba(40,52,64,.7)';ctx.fill();ctx.restore();
  }
  if(moon){
    ctx.save();ctx.translate(...moon);
    const glow=ctx.createRadialGradient(0,0,moonRadius*.9,0,0,moonRadius*1.9);glow.addColorStop(0,'rgba(200,222,255,.45)');glow.addColorStop(1,'rgba(200,222,255,0)');
    ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,moonRadius*1.9,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(0,0,moonRadius,0,Math.PI*2);ctx.save();ctx.clip();
    const disc=ctx.createRadialGradient(-moonRadius*.35,-moonRadius*.35,moonRadius*.1,0,0,moonRadius*1.1);disc.addColorStop(0,'#eef4ff');disc.addColorStop(.6,'#aebfd9');disc.addColorStop(1,'#6d84a8');
    ctx.fillStyle=disc;ctx.fillRect(-moonRadius,-moonRadius,moonRadius*2,moonRadius*2);
    for(let i=0;i<22;i++){ // seeded craters: dark floor with a lit rim on the upper-left
      const a=hash(i,3)*Math.PI*2,d=Math.sqrt(hash(i,5))*moonRadius*.9,r=(.04+hash(i,7)*.11)*moonRadius,x=Math.cos(a)*d,y=Math.sin(a)*d;
      ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle='rgba(70,92,128,.28)';ctx.fill();
      ctx.beginPath();ctx.arc(x-r*.15,y-r*.15,r,Math.PI*.9,Math.PI*1.9);ctx.strokeStyle='rgba(245,250,255,.5)';ctx.lineWidth=Math.max(1,r*.18);ctx.stroke();
    }
    const dark=ctx.createRadialGradient(-moonRadius*.5,-moonRadius*.5,moonRadius*.4,0,0,moonRadius*1.05);dark.addColorStop(0,'rgba(20,30,60,0)');dark.addColorStop(1,'rgba(20,30,60,.45)');
    ctx.fillStyle=dark;ctx.fillRect(-moonRadius,-moonRadius,moonRadius*2,moonRadius*2);ctx.restore();
    ctx.beginPath();ctx.arc(0,0,moonRadius,0,Math.PI*2);ctx.strokeStyle='rgba(62,40,24,.7)';ctx.lineWidth=Math.max(1.5,moonRadius*.04);ctx.stroke();ctx.restore();
  }
  drawFrame(ctx,width,height);
}

function drawFrame(ctx,width,height) {
  const m=Math.round(Math.min(width,height)*.014),line=Math.max(1,Math.round(width/700));
  ctx.save();ctx.strokeStyle='rgba(62,40,24,.9)';ctx.lineWidth=line*2.5;ctx.strokeRect(m,m,width-2*m,height-2*m);
  ctx.lineWidth=line;ctx.strokeRect(m*2,m*2,width-4*m,height-4*m);
  ctx.fillStyle='rgba(62,40,24,.9)';
  for(const [cx,cy] of [[m*2,m*2],[width-m*2,m*2],[m*2,height-m*2],[width-m*2,height-m*2]]){
    ctx.beginPath();ctx.moveTo(cx,cy-m*1.4);ctx.lineTo(cx+m*1.4,cy);ctx.lineTo(cx,cy+m*1.4);ctx.lineTo(cx-m*1.4,cy);ctx.closePath();ctx.fill();
  }
  ctx.lineWidth=line;
  for(let i=1;i<24;i++){const x=m*2+(width-4*m)*i/24,y=m*2+(height-4*m)*i/24,t=i%4===0?m*.9:m*.45;
    ctx.beginPath();ctx.moveTo(x,m);ctx.lineTo(x,m+t);ctx.moveTo(x,height-m);ctx.lineTo(x,height-m-t);ctx.moveTo(m,y);ctx.lineTo(m+t,y);ctx.moveTo(width-m,y);ctx.lineTo(width-m-t,y);ctx.stroke();}
  const cx=m*7,cy=height-m*7,r=m*4.5;ctx.translate(cx,cy);ctx.fillStyle='rgba(62,40,24,.85)';
  for(let i=0;i<8;i++){const a=i*Math.PI/4-Math.PI/2,l=i%2?r*.55:r;ctx.beginPath();ctx.moveTo(Math.cos(a-.28)*r*.2,Math.sin(a-.28)*r*.2);ctx.lineTo(Math.cos(a)*l,Math.sin(a)*l);ctx.lineTo(Math.cos(a+.28)*r*.2,Math.sin(a+.28)*r*.2);ctx.closePath();ctx.fill();}
  ctx.font=`${Math.round(m*2)}px serif`;ctx.textAlign='center';ctx.fillText('N',0,-r-m*.4);
  ctx.restore();
}

/** Generator form of renderMap: yields between slices (each a few ms); returns the canvas. */
export function* renderMapSteps({raster,frame,width=1024,sea=0,maelstrom,moon,make=()=>document.createElement('canvas')}) {
  const height=Math.round(width*frame.height/frame.width),canvas=make();canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d'),image=ctx.createImageData(width,height);
  const fields=yield* mapFieldsSteps(raster,sea);
  yield* shadeSteps(fields,raster,frame,width,height,image.data);
  ctx.putImageData(image,0,0);yield;
  const px=p=>p&&[(p[0]-frame.x0)/frame.width*width,(p[1]-frame.z0)/frame.height*height];
  drawDecor(ctx,width,height,{maelstrom:px(maelstrom),moon:px(moon)});
  return canvas;
}
/** Full render in one go (tests, tools). */
export function renderMap(opts) {
  const it=renderMapSteps(opts);let r;while(!(r=it.next()).done);return r.value;
}
