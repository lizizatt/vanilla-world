// Sparse lat/lon chunk registry (pivot data model). A chunk is any lat/lon rectangle with a provider; a point covered by no chunk is open ocean.
// The renderer/streamer only ask the registry, so adding a continent, the Maelstrom or a POI is a manifest entry, not a renderer change.
import {PLANET_RADIUS,WORLD_CENTRE,FALLBACK_RECTS,subPoint} from './space.js';
import {HEIGHT_W,HEIGHT_H} from './height-bake.js';
import {LAND_FLOOR} from './land-rect.js';

export const OCEAN={h:-60,rgb:[.04,.2,.36],water:true};
const smooth=t=>t*t*(3-2*t);
const hash=(i,j)=>{const h=Math.sin(i*127.1+j*311.7)*43758.5453;return h-Math.floor(h);};
// Deterministic value noise in [0,1) on the sphere's lat/lon, used to roughen chunk coastlines (hosted procedural continents).
const noise=(lat,lon,k)=>{const x=lon*k,y=lat*k,i=Math.floor(x),j=Math.floor(y),u=smooth(x-i),v=smooth(y-j);
  return (hash(i,j)*(1-u)+hash(i+1,j)*u)*(1-v)+(hash(i,j+1)*(1-u)+hash(i+1,j+1)*u)*v;};

/**
 * Chunk: {id, kind:'adt'|'procedural'|'poi', bounds:[lat0,lat1,lon0,lon1] (radians, any size/shape, not tied to the 533.33 yd grid),
 *   priority (higher wins where chunks overlap), blend (yd; width of the seam feather inside the bounds), provider}.
 * Provider: {sample(lat,lon)->{h,rgb,water}, objects?(bounds)->[...]}; chunk-local frames are the provider's business (it receives planet lat/lon).
 */
export function createRegistry(chunks,radius=PLANET_RADIUS) {
  const list=chunks.map(c=>({blend:200,priority:0,jitter:0,...c})).sort((a,b)=>a.priority-b.priority);
  const feather=(c,lat,lon)=>{
    const [a0,a1,o0,o1]=c.bounds;
    if(lat<a0-c.jitter/radius||lat>a1+c.jitter/radius||lon<o0-c.jitter/radius||lon>o1+c.jitter/radius)return 0;
    const d=Math.min(lat-a0,a1-lat,(lon-o0)*Math.cos(lat),(o1-lon)*Math.cos(lat))*radius+(c.jitter?(noise(lat,lon,60)-.5)*c.jitter:0);
    return c.blend>0?smooth(Math.min(1,Math.max(0,d/c.blend))):d>0?1:0;
  };
  return {
    chunks:list,
    /** Chunks covering a point with seam weights, lowest priority first. */
    cover:(lat,lon)=>list.map(c=>({chunk:c,weight:feather(c,lat,lon)})).filter(e=>e.weight>0),
    /** Blended surface sample: ocean underlay, each covering chunk composited over it by priority with its seam weight. */
    sample(lat,lon) {
      let land=0,h=OCEAN.h,rgb=OCEAN.rgb,water=OCEAN.water;
      for(const chunk of list) {
        const weight=feather(chunk,lat,lon);if(weight<=0)continue;
        const s=chunk.provider.sample(lat,lon);if(s.skip)continue;
        land=Math.max(land,weight);h+=(s.h-h)*weight;rgb=[rgb[0]+(s.rgb[0]-rgb[0])*weight,rgb[1]+(s.rgb[1]-rgb[1])*weight,rgb[2]+(s.rgb[2]-rgb[2])*weight];if(weight>=.5)water=s.water;
      }
      return {land,h,rgb,water};
    },
    add(c) {list.push({blend:200,priority:0,jitter:0,...c});list.sort((a,b)=>a.priority-b.priority);},
  };
}

/** Procedural provider: deterministic, no data files (hosted fallback and custom chunks). */
export function proceduralProvider({height=40,rgb=[.35,.5,.25],water=false}={}) {
  return {sample:(lat,lon)=>({h:height*(1+Math.sin(lat*900)*Math.cos(lon*900))/2,rgb,water})};
}

/** Rect [x0,z0,x1,z1] in flat render yd -> chunk bounds. */
export function rectBounds([x0,z0,x1,z1],centre=WORLD_CENTRE,radius=PLANET_RADIUS) {
  const a=subPoint(x0,z0,centre,radius),b=subPoint(x1,z1,centre,radius);
  return [Math.min(a.lat,b.lat),Math.max(a.lat,b.lat),Math.min(a.lon,b.lon),Math.max(a.lon,b.lon)];
}

/** Hosted default: the two continents as procedural chunks; with WoW data the same entries get an 'adt' provider instead. */
export function defaultManifest(makeProvider=()=>proceduralProvider(),rects=FALLBACK_RECTS) {
  return rects.map((r,i)=>({id:i?'eastern-kingdoms':'kalimdor',kind:'procedural',blend:2500,jitter:6000,bounds:rectBounds(r),provider:makeProvider(i)}));
}

const TILE=1600/3;
/** Per-texel running colour average on the same equirect layout as bakeSurface (row 0 is lat +90). */
/** True when the equirect height grid (yd, -Infinity unset) holds known ground at or below the WDL ocean-floor band at lon/lat. */
export function isDeepOcean(heights,lon,lat) {
  const h=heights[Math.floor((.5-lat/Math.PI)*HEIGHT_H)*HEIGHT_W+Math.floor((lon/(2*Math.PI)+.5)*HEIGHT_W)];
  return Number.isFinite(h)&&h<=LAND_FLOOR;
}

export function createColourGrid(w=1024,h=512) {return {w,h,sum:new Float32Array(w*h*3),n:new Uint16Array(w*h)};}

/**
 * Splat one tile minimap (size x size RGBA, 533.33 yd square whose origin sits at `placement` in the flat world) into the colour grid.
 * Flat pose = globe sub-point, so lon=(x-cx)/R and lat=-(z-cz)/R. Returns the touched texel indices (appended to `dirty` when given).
 */
export function splatMinimap(grid,rgba,size,placement,[cx,cz]=WORLD_CENTRE,radius=PLANET_RADIUS,dirty=new Set(),heights) {
  for(let py=0;py<size;py++)for(let px=0;px<size;px++){
    const i=(py*size+px)*4;if(rgba[i+3]<128)continue;
    const lon=(placement[0]+(px+.5)/size*TILE-cx)/radius,lat=-(placement[1]+(py+.5)/size*TILE-cz)/radius;
    if(Math.abs(lon)>=Math.PI||Math.abs(lat)>=Math.PI/2)continue;
    if(heights&&isDeepOcean(heights,lon,lat))continue;
    const k=Math.floor((.5-lat/Math.PI)*grid.h)*grid.w+Math.floor((lon/(2*Math.PI)+.5)*grid.w);
    grid.sum[k*3]+=rgba[i]/255;grid.sum[k*3+1]+=rgba[i+1]/255;grid.sum[k*3+2]+=rgba[i+2]/255;grid.n[k]++;dirty.add(k);
  }
  return dirty;
}

/** 'adt' provider: real WDL/minimap colour where a tile has been seen; `{skip:true}` (no coverage) elsewhere. */
export function adtProvider(grid) {
  return {sample(lat,lon) {
    const k=Math.floor((.5-lat/Math.PI)*grid.h)*grid.w+Math.floor((lon/(2*Math.PI)+.5)*grid.w),n=grid.n[k];
    return n?{h:0,rgb:[grid.sum[k*3]/n,grid.sum[k*3+1]/n,grid.sum[k*3+2]/n],water:false}:{skip:true};
  }};
}

/** Whole-sphere chunk backed by the colour grid, drawn over the procedural continents so authored tiles win. */
export const adtChunk=grid=>({id:'adt',kind:'adt',priority:10,blend:0,bounds:[-Math.PI/2,Math.PI/2,-Math.PI,Math.PI],provider:adtProvider(grid)});
/** One baked texel [r,g,b,land] (bytes) for texel (x,y) of a w x h equirect map. */
export function surfaceTexel(registry,x,y,w,h,out=[0,0,0,0]) {
  const s=registry.sample(Math.PI/2-(y+.5)/h*Math.PI,((x+.5)/w-.5)*2*Math.PI);
  out[0]=Math.round(s.rgb[0]*255);out[1]=Math.round(s.rgb[1]*255);out[2]=Math.round(s.rgb[2]*255);out[3]=Math.round(s.land*255);return out;
}

/** Bake the registry into an equirect RGBA8 map (rgb colour, alpha = land weight) the globe shaders sample; row 0 is lat +90. */
export function bakeSurface(registry,w=1024,h=512) {
  const out=new Uint8Array(w*h*4),texel=[0,0,0,0];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)out.set(surfaceTexel(registry,x,y,w,h,texel),(y*w+x)*4);
  return out;
}