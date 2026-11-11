/** Samples along start->end, dense at the shore (every 150 yd) then geometric out to `stopShort` yards before the end; each {x,z,d}. */
export function pathPoints(start,end,n,stopShort=2500){
  const dx=end[0]-start[0],dz=end[1]-start[1],total=Math.hypot(dx,dz),last=Math.max(total-stopShort,1);
  const points=[];
  for(let i=0;i<n;i++){
    const t=i/(n-1),d=i===0?0:Math.min(last,150*Math.pow(last/150,t));
    points.push({x:start[0]+dx/total*d,z:start[1]+dz/total*d,d});
  }
  return points;
}

const luma=(r,g,b)=>.2126*r+.7152*g+.0722*b;

/** Mean RGB of an RGBA frame region plus the largest luma step between vertically adjacent 8px-averaged rows in the central third. `waterOnly` samples the whole frame, otherwise the lower half. */
export function frameStats(data,width,height,waterOnly){
  const y0=waterOnly?0:Math.floor(height*.55),y1=Math.floor(height*.9),x0=Math.floor(width*.33),x1=Math.floor(width*.66);
  const mean=[0,0,0];let n=0;const rows=[];
  for(let y=y0;y<y1;y++){
    let sum=0,k=0;
    for(let x=x0;x<x1;x++){
      const i=(y*width+x)*4;mean[0]+=data[i];mean[1]+=data[i+1];mean[2]+=data[i+2];n++;sum+=luma(data[i],data[i+1],data[i+2]);k++;
    }
    rows.push(sum/k);
  }
  let rowStep=0;
  for(let y=8;y<rows.length;y+=1)rowStep=Math.max(rowStep,Math.abs(rows[y]-rows[y-8]));
  return {mean:mean.map(v=>v/n),rowStep};
}

/** Largest per-channel change between two mean colours. */
export const stepBetween=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
