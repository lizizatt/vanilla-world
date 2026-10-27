// Elune site list (design/elune.md M8/M9): committed config only, no game data. A site grafts a block of source tiles from a real map onto a body at integer tile offset;
// the graft is cut at the dome's footprint circle and everything outside it is the procedural moon (a hard edge hidden under the dome shell). Adding a body or site is a list entry.
import {ADT_TILE as T} from './adt-synth.js';

/** Circumcircle of three chart points as a dome config: centre and adius (the circle passes exactly through all three), plus extra fields. */
export function circleThrough([a,b,c],extra) {
  const d=2*(a[0]*(b[1]-c[1])+b[0]*(c[1]-a[1])+c[0]*(a[1]-b[1])),sq=p=>p[0]*p[0]+p[1]*p[1];
  const x=(sq(a)*(b[1]-c[1])+sq(b)*(c[1]-a[1])+sq(c)*(a[1]-b[1]))/d,z=(sq(a)*(c[0]-b[0])+sq(b)*(a[0]-c[0])+sq(c)*(b[0]-a[0]))/d;
  return Object.freeze({centre:Object.freeze([x,z]),radius:Math.hypot(a[0]-x,a[1]-z),through:Object.freeze([a,b,c]),...extra});
}

export const SITES=Object.freeze({
  elune:[Object.freeze({
    id:'moonglade',label:'Moonglade',map:'Kalimdor',area:493,
    source:Object.freeze({x:[35,37],y:[16,18]}),// measured with moonglade-census.mjs: the 3 x 3 plateau holding the town, Lake Elune'ara and the grove
    dest:Object.freeze({x:29,y:14}),// north-west tile of the grafted block on the body's tile grid (chart centre = tile 30,15, the sub-Azeroth point since Elune is tidally locked, so Azeroth hangs overhead)
    spawnYaw:2.5,// pod heading at the map-teleport seat: measured with driving-smoke on real data, the grove's trees and banks stop a pod on most headings within ~100-300 yd; 2.5 runs clear out of the dome onto open moon
    dome:circleThrough([[205.845,52.071],[268.196,588.637],[879.646,459.553]],{shell:50}),// druidic dome whose footprint circle passes exactly through the user's track new-track-2 start + 2 gates (chart x,z); shell skin width. The graft ends at this circle (chunk centres) and procedural regolith starts right outside it.
  })],
});

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
/** Dome centre in chart yd: the configured dome.centre, else the graft's centre. */
export const domeCentre=(site,cx,cy)=>site.dome?.centre??siteCentre(site,cx,cy);
const radial=(site,x,z,cx,cy)=>{const [sx,sz]=domeCentre(site,cx,cy);return Math.hypot(x-sx,z-sz);};
/** Druidic dome strength 0..1 at chart (x,z) and altitude `alt` above the site centre's ground: the dome is a sphere of `dome.radius` centred on the ground, so membership is 1 inside,
 * easing to 0 over the `dome.shell` yd skin. It contains only local weather (cloud microclimate, nature ambience); sky and light stay airless everywhere. */
export function domeMask(bodyId,x,z,cx=30,cy=15,alt=0) {
  let m=0;
  for(const site of sitesOf(bodyId)) {
    const {radius,shell}=site.dome,[sx,sz]=domeCentre(site,cx,cy),d=Math.hypot(x-sx,z-sz,Math.max(alt,0)),t=Math.min(1,Math.max(0,(d-radius)/shell));
    m=Math.max(m,1-t*t*(3-2*t));
  }
  return m;
}
/** 1 inside the dome footprint circle (where the real Moonglade ground is kept), 0 outside it: the graft ends exactly at the circle and the procedural moon starts immediately beyond, with no blend. */
export const siteMask=(site,x,z,cx,cy)=>radial(site,x,z,cx,cy)<=site.dome.radius*(1+1e-12)?1:0;
/** How a chart rectangle [x0,z0,x1,z1] relates to the footprint circle: 'inside', 'outside' or 'partial'. */
export function rectVsCircle(site,rect,cx,cy) {
  const [sx,sz]=domeCentre(site,cx,cy),{radius}=site.dome,nx=Math.max(rect[0]-sx,0,sx-rect[2]),nz=Math.max(rect[1]-sz,0,sz-rect[3]);
  if(Math.hypot(nx,nz)>radius)return 'outside';
  return Math.hypot(Math.max(Math.abs(rect[0]-sx),Math.abs(rect[2]-sx)),Math.max(Math.abs(rect[1]-sz),Math.abs(rect[3]-sz)))<=radius?'inside':'partial';
}
