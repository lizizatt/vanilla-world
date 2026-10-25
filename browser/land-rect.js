// WDL ocean tiles sit near -503 yd with stray sea-level spikes; anything higher is land that must not be flooded by the sea-level fill.
export const LAND_FLOOR=-450,LAND_FRACTION=.1,RIM_BAND=.25,LIQUID=2;

/** True when enough of a horizon tile (7 floats per vertex, y at +1) is above the ocean-floor band to count as land. */
export function isLandTile(vertices,floor=LAND_FLOOR,fraction=LAND_FRACTION) {
  const n=Math.floor(vertices.length/7);let high=0;
  for(let i=1;i<vertices.length;i+=7)if(vertices[i]>floor)high++;
  return n>0&&high/n>=fraction;
}

/**
 * WDL tiles bordering missing data carry a rim of sea-level (0) vertices that reads as a ridge in open ocean and fights the water plane.
 * When every above-floor vertex of a tile lies within RIM_BAND of its outer edge, flatten them to the tile's lowest height (in place).
 */
export function trimRimSpikes(vertices,floor=LAND_FLOOR) {
  let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity,low=Infinity;
  for(let i=0;i<vertices.length;i+=7){if(vertices[i+6]===LIQUID)continue;x0=Math.min(x0,vertices[i]);x1=Math.max(x1,vertices[i]);z0=Math.min(z0,vertices[i+2]);z1=Math.max(z1,vertices[i+2]);low=Math.min(low,vertices[i+1]);}
  if(!(low<=floor))return vertices;
  const bx=(x1-x0)*RIM_BAND,bz=(z1-z0)*RIM_BAND,rim=i=>vertices[i]-x0<=bx||x1-vertices[i]<=bx||vertices[i+2]-z0<=bz||z1-vertices[i+2]<=bz;
  for(let i=0;i<vertices.length;i+=7)if(vertices[i+6]!==LIQUID&&vertices[i+1]>floor&&!rim(i))return vertices;
  for(let i=0;i<vertices.length;i+=7)if(vertices[i+6]!==LIQUID&&vertices[i+1]>floor)vertices[i+1]=low;
  return vertices;
}

/** Shared water predicate: no sea surface where a land rect [x0,z0,x1,z1] covers (x,z). Used by the ocean mesh carve and the camera floor. */
export const coversLand=(rects,x,z)=>rects.some(r=>x>=r[0]&&x<r[2]&&z>=r[1]&&z<r[3]);
