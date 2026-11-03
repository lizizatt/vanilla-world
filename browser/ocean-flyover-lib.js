// Pure logic for the Booty Bay -> Maelstrom ocean flyover (ocean-flyover.mjs): the checkpoint route, per-frame glitch metrics and the
// assertions over them. analyseFrame is self-contained so the harness can ship its source into the page and decode screenshots there.

/** Checkpoints from `start` to `end`: every `coast` yd for the first `coastSpan` yd, every `open` yd across open water, every `near` yd inside `nearSpan` of the end, stopping `stopShort` yd before the end; each {x,z,d}. */
export function flyoverRoute(start,end,{coast=150,coastSpan=3000,open=450,near=250,nearSpan=6000,stopShort=1500}={}){
  const dx=end[0]-start[0],dz=end[1]-start[1],total=Math.hypot(dx,dz),last=Math.max(total-stopShort,0);
  const ds=[0];
  while(ds[ds.length-1]<last){
    const d=ds[ds.length-1],step=d<coastSpan?coast:total-d<nearSpan+stopShort?near:open;
    ds.push(Math.min(last,d+step));
  }
  return ds.map(d=>({x:start[0]+dx/total*d,z:start[1]+dz/total*d,d}));
}

/** Largest per-channel change between two mean colours. */
export const colourStep=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));

/**
 * Glitch metrics of an RGBA frame (data,width,height): mean colour, fractions of magenta / black pixels, isolated-bright "sparkle" pixels per
 * megapixel, and the largest luma step between adjacent row / column bands in the lower `skip` fraction-excluded region (a tile seam or colour band).
 */
export function analyseFrame(data,width,height,skip=.3){
  // The region of interest leaves out the corner HUD widgets (bottom 12%, outer 12% of the width).
  const y0=Math.floor(height*skip),y1=Math.floor(height*.88),x0=Math.floor(width*.12),x1=Math.floor(width*.88),L=i=>.2126*data[i]+.7152*data[i+1]+.0722*data[i+2];
  const mean=[0,0,0];let n=0,pink=0,black=0,sparkles=0;
  const rows=new Float64Array(height),cols=new Float64Array(width);
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],l=L(i);
    mean[0]+=r;mean[1]+=g;mean[2]+=b;n++;rows[y]+=l;cols[x]+=l;
    if(r>170&&b>170&&g<100)pink++;
    if(r<6&&g<6&&b<6)black++;
    if(l>235&&x>x0+8&&y>y0+8&&x<x1-8&&y<y1-8){
      const ring=(L(i-12)+L(i+12)+L(i-width*3)+L(i+width*3))/4;
      if(ring<l-80)sparkles++;
    }
  }
  const band=4,step=(a,from,to,len)=>{
    let best=0,at=0;
    for(let k=from+band;k<to-band;k++){
      let s0=0,s1=0;
      for(let j=0;j<band;j++){s0+=a[k-1-j];s1+=a[k+j];}
      const d=Math.abs(s1-s0)/band/len;
      if(d>best){best=d;at=k;}
    }
    return [best,at];
  };
  const [rowStep,rowAt]=step(rows,y0,y1,x1-x0),[colStep,colAt]=step(cols,x0,x1,y1-y0);
  return {mean:mean.map(v=>v/n),pink:pink/n,black:black/n,sparklesPerMpx:sparkles/(n/1e6),rowStep,rowAt,colStep,colAt};
}

// Whole-frame colour deltas are dominated by rain, lightning and cloud in the Maelstrom storm (stormFrom yd along the route), so only the glitch-specific checks apply there.
export const DEFAULT_LIMITS={maxStep:36,maxPink:.0005,maxBlack:.002,maxSparkles:25000,maxRowStep:80,maxFlicker:25,stormFrom:6000};

/** Rows: {i,d,variant,stats,repeat?} in route order. Returns the failures (strings) against the limits; a variant is a camera/time setup compared only with itself. */
export function checkRows(rows,limits=DEFAULT_LIMITS){
  const failures=[],prev=new Map();
  for(const r of rows){
    const s=r.stats,tag=`#${r.i} d=${Math.round(r.d)} ${r.variant}`;
    if(s.pink>limits.maxPink)failures.push(`${tag}: ${(s.pink*100).toFixed(2)}% magenta pixels`);
    if(s.black>limits.maxBlack)failures.push(`${tag}: ${(s.black*100).toFixed(2)}% black pixels`);
    if(s.sparklesPerMpx>limits.maxSparkles)failures.push(`${tag}: ${s.sparklesPerMpx.toFixed(0)} isolated bright pixels/Mpx`);
    if(s.rowStep>limits.maxRowStep)failures.push(`${tag}: row luma step ${s.rowStep.toFixed(1)} at y=${s.rowAt}`);
    const p=prev.get(r.variant),storm=r.d>=(limits.stormFrom??Infinity);
    if(p&&!storm){const d=colourStep(p.stats.mean,s.mean);if(d>limits.maxStep)failures.push(`${tag}: mean colour step ${d.toFixed(1)} from #${p.i}`);}
    prev.set(r.variant,r);
    if(r.repeat&&!storm){const d=colourStep(r.repeat.mean,s.mean);if(d>limits.maxFlicker)failures.push(`${tag}: flicker ${d.toFixed(1)} between repeat frames`);}
  }
  return failures;
}
