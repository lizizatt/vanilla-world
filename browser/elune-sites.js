// Elune site list (design/elune.md M8/M9): committed config only, no game data. A site grafts a block of source tiles from a real map onto a body at integer tile offset;
// the surrounding `apron` yd is generated procedurally and blends from the graft's own edge heights back into the moon. Adding a body or site is a list entry.
import {ADT_TILE as T} from './adt-synth.js';

export const SITES=Object.freeze({
  elune:[Object.freeze({
    id:'moonglade',label:'Moonglade',map:'Kalimdor',area:493,
    source:Object.freeze({x:[35,37],y:[16,18]}),// measured with moonglade-census.mjs: the 3 x 3 plateau holding the town, Lake Elune'ara and the grove
    dest:Object.freeze({x:29,y:14}),// north-west tile of the grafted block on the body's tile grid (chart centre = tile 30,15, the sub-Azeroth point since Elune is tidally locked, so Azeroth hangs overhead)
    apron:1200,// outer limit of the procedural ring that is generated around the graft (selects apron tiles)
    dome:Object.freeze({radius:780,shell:50,ease:420}),// druidic dome footprint (inside the 1600 yd graft square), soft shell width, and the height ease back to the moon outside the circle
  })],
});
export const APRON_AREA=90003;// "Moonglade Reach"

export const sitesOf=bodyId=>SITES[bodyId]??[];
export const tilesOf=site=>{const out=[];for(let y=site.source.y[0];y<=site.source.y[1];y++)for(let x=site.source.x[0];x<=site.source.x[1];x++)out.push({sx:x,sy:y,dx:x-site.source.x[0]+site.dest.x,dy:y-site.source.y[0]+site.dest.y});return out;};
export const siteTiles=site=>({w:site.source.x[1]-site.source.x[0]+1,h:site.source.y[1]-site.source.y[0]+1});
/** Chart rectangle [x0,z0,x1,z1] of the graft on a body whose chart centre is tile (cx,cy). */
export function siteRect(site,cx=30,cy=15) {
  const {w,h}=siteTiles(site);return [(site.dest.x-cx)*T,(site.dest.y-cy)*T,(site.dest.x+w-cx)*T,(site.dest.y+h-cy)*T];
}
export const siteCentre=(site,cx,cy)=>{const r=siteRect(site,cx,cy);return [(r[0]+r[2])/2,(r[1]+r[3])/2];};
/** Distance in yd outside the graft rectangle (0 inside). */
export function outside(site,x,z,cx,cy) {
  const r=siteRect(site,cx,cy);return Math.hypot(Math.max(r[0]-x,0,x-r[2]),Math.max(r[1]-z,0,z-r[3]));
}
/** Distance from the dome's footprint centre. */
const radial=(site,x,z,cx,cy)=>{const [sx,sz]=siteCentre(site,cx,cy);return Math.hypot(x-sx,z-sz);};
/** Druidic dome strength 0..1 at chart (x,z) and altitude `alt` above the site centre's ground: the dome is a sphere of `dome.radius` centred on the ground, so membership is 1 inside,
 * easing to 0 over the `dome.shell` yd skin. It contains only local weather (cloud microclimate, nature ambience); sky and light stay airless everywhere. */
export function domeMask(bodyId,x,z,cx=30,cy=15,alt=0) {
  let m=0;
  for(const site of sitesOf(bodyId)) {
    const {radius,shell}=site.dome,[sx,sz]=siteCentre(site,cx,cy),d=Math.hypot(x-sx,z-sz,Math.max(alt,0)),t=Math.min(1,Math.max(0,(d-radius)/shell));
    m=Math.max(m,1-t*t*(3-2*t));
  }
  return m;
}
/** 1 inside the dome footprint circle (where the real Moonglade terrain is kept), easing to 0 over `dome.ease` yd outside it, where the procedural moon takes over. */
export function siteMask(site,x,z,cx,cy) {
  const t=Math.min(1,Math.max(0,(radial(site,x,z,cx,cy)-site.dome.radius)/site.dome.ease));return 1-t*t*(3-2*t);
}
