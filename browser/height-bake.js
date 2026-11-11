export const HEIGHT_W=2048,HEIGHT_H=1024,HEIGHT_MIN=-300,HEIGHT_RANGE=2700;

/** Splat a flat-world terrain mesh (7 floats per vertex, local to `placement`) into an equirect height grid, keeping the max.
 * Row 0 is lat +90, matching bakeSurface. Flat pose = globe sub-point, so lon=(x-cx)/R and lat=-(z-cz)/R. */
export function splatHeights(grid,vertices,placement,[cx,cz],radius) {
  for(let i=0;i<vertices.length;i+=7){
    const lon=(placement[0]+vertices[i]-cx)/radius,lat=-(placement[1]+vertices[i+2]-cz)/radius;
    if(Math.abs(lon)>=Math.PI||Math.abs(lat)>=Math.PI/2)continue;
    const x=Math.floor((lon/(2*Math.PI)+.5)*HEIGHT_W),y=Math.floor((.5-lat/Math.PI)*HEIGHT_H),k=y*HEIGHT_W+x;
    grid[k]=Math.max(grid[k],vertices[i+1]);
  }
  return grid;
}

/** Height grid (yd, -Infinity = unset) -> r8unorm bytes; unset and sub-sea-level cells encode as sea level. */
export function encodeHeights(grid,out=new Uint8Array(grid.length)) {
  // Unset (-Infinity) and sub-sea cells all clamp to height 0, so they share one precomputed byte.
  const sea=Math.round(Math.min(1,Math.max(0,(0-HEIGHT_MIN)/HEIGHT_RANGE))*255);
  for(let i=0;i<grid.length;i++){const g=grid[i];out[i]=g<=0?sea:Math.round(Math.min(1,Math.max(0,(Math.max(0,g)-HEIGHT_MIN)/HEIGHT_RANGE))*255);}
  return out;
}
