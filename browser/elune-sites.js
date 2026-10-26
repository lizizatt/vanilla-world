// Elune site list (design/elune.md M8/M9): committed config only, no game data. A site grafts a block of source tiles from a real map onto a body at integer tile offset;
// the surrounding `apron` yd is generated procedurally and blends from the graft's own edge heights back into the moon. Adding a body or site is a list entry.
import {ADT_TILE as T} from './adt-synth.js';

export const SITES=Object.freeze({
  elune:[Object.freeze({
    id:'moonglade',label:'Moonglade',map:'Kalimdor',area:493,
    source:Object.freeze({x:[35,37],y:[16,18]}),// measured with moonglade-census.mjs: the 3 x 3 plateau holding the town, Lake Elune'ara and the grove
    dest:Object.freeze({x:29,y:10}),// north-west tile of the grafted block on the body's tile grid (chart centre = tile 30,15)
    apron:1200,bubble:700,
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
/** 1 on the graft, easing to 0 at `apron` yd away. */
export function siteMask(site,x,z,cx,cy) {
  const t=Math.min(1,outside(site,x,z,cx,cy)/site.apron);return 1-t*t*(3-2*t);
}
