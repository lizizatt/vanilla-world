// Sparse lat/lon chunk registry (pivot data model). A chunk is any lat/lon rectangle with a provider; a point covered by no chunk is open ocean.
// The renderer/streamer only ask the registry, so adding a continent, the Maelstrom or a POI is a manifest entry, not a renderer change.
import {PLANET_RADIUS,WORLD_CENTRE,FALLBACK_RECTS,subPoint} from './space.js';

export const OCEAN={h:-60,rgb:[.04,.2,.36],water:true};
const smooth=t=>t*t*(3-2*t);

/**
 * Chunk: {id, kind:'adt'|'procedural'|'poi', bounds:[lat0,lat1,lon0,lon1] (radians, any size/shape, not tied to the 533.33 yd grid),
 *   priority (higher wins where chunks overlap), blend (yd; width of the seam feather inside the bounds), provider}.
 * Provider: {sample(lat,lon)->{h,rgb,water}, objects?(bounds)->[...]}; chunk-local frames are the provider's business (it receives planet lat/lon).
 */
export function createRegistry(chunks,radius=PLANET_RADIUS) {
  const list=chunks.map(c=>({blend:200,priority:0,...c})).sort((a,b)=>a.priority-b.priority);
  const feather=(c,lat,lon)=>{
    const [a0,a1,o0,o1]=c.bounds;
    if(lat<a0||lat>a1||lon<o0||lon>o1)return 0;
    const d=Math.min(lat-a0,a1-lat,(lon-o0)*Math.cos(lat),(o1-lon)*Math.cos(lat))*radius;
    return c.blend>0?smooth(Math.min(1,d/c.blend)):1;
  };
  return {
    chunks:list,
    /** Chunks covering a point with seam weights, lowest priority first. */
    cover:(lat,lon)=>list.map(c=>({chunk:c,weight:feather(c,lat,lon)})).filter(e=>e.weight>0),
    /** Blended surface sample: ocean underlay, each covering chunk composited over it by priority with its seam weight. */
    sample(lat,lon) {
      let out={...OCEAN};
      for(const {chunk,weight} of this.cover(lat,lon)) {
        const s=chunk.provider.sample(lat,lon);
        out={h:out.h+(s.h-out.h)*weight,rgb:out.rgb.map((v,i)=>v+(s.rgb[i]-v)*weight),water:weight>=.5?s.water:out.water};
      }
      return out;
    },
    add(c) {list.push({blend:200,priority:0,...c});list.sort((a,b)=>a.priority-b.priority);},
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
  return rects.map((r,i)=>({id:i?'eastern-kingdoms':'kalimdor',kind:'procedural',bounds:rectBounds(r),provider:makeProvider(i)}));
}
