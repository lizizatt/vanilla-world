// Night-side settlement lights: a hand-written table of towns/cities (WoW world coordinates, no game art) baked once into an
// equirect rgba8 texture (same lat/lon mapping as the surface bake) that surface() in space.js samples on the dark side of the globe.
// rgb = additive light, a = palette flag (0 firelight, .5 Dalaran arcane pulse, 1 Karazhan eerie flicker).
import {PLANET_RADIUS,WORLD_CENTRE,FALLBACK_RECTS,subPoint} from './space.js';
import {regionOffset} from './worldmap.js';
import {NIGHT_W,NIGHT_H} from './night-lights-wgsl.js';

export {NIGHT_W,NIGHT_H,nightLightsWgsl} from './night-lights-wgsl.js';
export const FIRE=[1,.58,.2];
export const FLAG_ARCANE=.5,FLAG_EERIE=1;
export const PALETTES={
  dalaran:{flag:FLAG_ARCANE,colours:[[.62,.25,1],[.15,.85,1],[1,.2,.8]]},
  karazhan:{flag:FLAG_EERIE,colours:[[.25,1,.35],[.55,.2,.9],[.2,.4,1]]},
};

// map: 'Kalimdor' | 'Azeroth' (Eastern Kingdoms); wow: [x north, y west]; size 1 (hamlet) .. 5 (capital).
// Dalaran is placed on its Hillsbrad/Alterac-side lore position, approximate.
export const SETTLEMENTS=[
  {id:'orgrimmar',map:'Kalimdor',wow:[1500,-4400],size:5},{id:'razor-hill',map:'Kalimdor',wow:[340,-4690],size:2},
  {id:'thunder-bluff',map:'Kalimdor',wow:[-1280,-100],size:4},{id:'darnassus',map:'Kalimdor',wow:[9950,2200],size:4},
  {id:'dolanaar',map:'Kalimdor',wow:[9800,950],size:2},{id:'auberdine',map:'Kalimdor',wow:[6400,480],size:2},
  {id:'astranaar',map:'Kalimdor',wow:[2750,-500],size:2},{id:'ratchet',map:'Kalimdor',wow:[-960,-3750],size:3},
  {id:'gadgetzan',map:'Kalimdor',wow:[-7150,-3800],size:3},{id:'theramore',map:'Kalimdor',wow:[-3750,-4500],size:3},
  {id:'feathermoon',map:'Kalimdor',wow:[-4350,3300],size:2},{id:'camp-taurajo',map:'Kalimdor',wow:[-2350,-1650],size:2},
  {id:'crossroads',map:'Kalimdor',wow:[-450,-2650],size:3},{id:'everlook',map:'Kalimdor',wow:[6800,-4650],size:2},
  {id:'cenarion-hold',map:'Kalimdor',wow:[-6850,800],size:2},{id:'freewind-post',map:'Kalimdor',wow:[-5400,-2400],size:1},
  {id:'stormwind',map:'Azeroth',wow:[-8900,500],size:5},{id:'goldshire',map:'Azeroth',wow:[-9450,60],size:2},
  {id:'darkshire',map:'Azeroth',wow:[-10500,-1150],size:2},{id:'lakeshire',map:'Azeroth',wow:[-9250,-2100],size:2},
  {id:'ironforge',map:'Azeroth',wow:[-4900,-900],size:5},{id:'thelsamar',map:'Azeroth',wow:[-5300,-3100],size:2},
  {id:'menethil',map:'Azeroth',wow:[-3800,-830],size:3},{id:'southshore',map:'Azeroth',wow:[-850,-900],size:2},
  {id:'tarren-mill',map:'Azeroth',wow:[-30,-900],size:2},{id:'undercity',map:'Azeroth',wow:[1850,240],size:4},
  {id:'sepulcher',map:'Azeroth',wow:[500,1300],size:1},{id:'booty-bay',map:'Azeroth',wow:[-14300,500],size:3},
  {id:'stromgarde',map:'Azeroth',wow:[-1650,-2400],size:2},{id:'thorium-point',map:'Azeroth',wow:[-6550,-1100],size:2},
  {id:'dalaran',map:'Azeroth',wow:[250,-350],size:4,palette:'dalaran'},
  {id:'karazhan',map:'Azeroth',wow:[-11120,-1900],size:3,palette:'karazhan'},
];

/**
 * Render-space [x,z] for every settlement: from the manifest region offsets when loaded, keeping those on land (inside ects).
 */
export function settlementPositions(manifest,rects=FALLBACK_RECTS) {
  const inside=p=>rects.some(r=>p[0]>=r[0]&&p[0]<=r[2]&&p[1]>=r[1]&&p[1]<=r[3]);
  const real=manifest?.world_bounds&&manifest.regions?SETTLEMENTS.flatMap(s=>{
    const region=manifest.regions.find(r=>r.map===s.map);
    if(!region)return [];
    const [kx,kz]=regionOffset(region),pos=[-s.wow[1]+kx,-s.wow[0]+kz];
    return inside(pos)?[{...s,pos}]:[];
  }):[];
  return real;
}

/** Settlement for a cluster of n lit models found on the ground at render-space [x,z]; a lone lamp is a faint size-1 glimmer, a lit town grows. */
export const litSpot=(x,z,n)=>({id:'lit'+Math.round(x/160)+'_'+Math.round(z/160),pos:[x,z],size:n>=64?3:n>=16?2:n>=4?1.5:.5});

const hash=n=>{const x=Math.sin(n*127.1+311.7)*43758.5453;return x-Math.floor(x);};

/** Light points {u,v,rgb,sigma,peak,flag} in texel space for one settlement: a core, plus a ring of satellite lights scaled by size. */
export function settlementLights(s,w=NIGHT_W,h=NIGHT_H) {
  const {lat,lon}=subPoint(s.pos[0],s.pos[1]);
  if(Math.abs(lat)>=Math.PI/2)return [];
  const cu=(lon/(2*Math.PI)+.5)*w,cv=(.5-lat/Math.PI)*h,texYd=2*Math.PI*PLANET_RADIUS/w;
  const pal=PALETTES[s.palette],flag=pal?pal.flag:0,sigma=.7+s.size*.45,peak=.35+s.size*.16;
  const out=[{u:cu,v:cv,rgb:pal?pal.colours[0]:FIRE,sigma,peak,flag}];
  const n=pal?3+s.size:s.size*2+1,reach=sigma*(pal?1.6:1.9);
  const seed=[...s.id].reduce((a,c)=>a*31+c.charCodeAt(0)|0,7);
  for(let i=0;i<n;i++) {
    const a=hash(seed+i*3)*Math.PI*2,d=reach*(.4+hash(seed+i*3+1)*.9);
    // Palette cities colour each cluster differently so the mix reads from orbit; towns vary warm tone slightly.
    const rgb=pal?pal.colours[i%pal.colours.length]:FIRE.map((c,k)=>c*(k?.85+hash(seed+i*3+2)*.3:1));
    out.push({u:cu+Math.cos(a)*d,v:cv+Math.sin(a)*d,rgb,sigma:sigma*(pal?.7:.55),peak:peak*(pal?.8:.6),flag});
  }
  return out.map(l=>({...l,texYd}));
}

/**
 * Incremental night-lights bake: add() splats one settlement into float accumulators and re-quantises only the touched rows into out,
 * so streaming in lit WMO spots from real data costs microseconds per spot instead of a full-texture rebake. rows = [y0,y1] dirty span.
 */
export function createNightBake(w=NIGHT_W,h=NIGHT_H,out=new Uint8Array(w*h*4)) {
  const acc=new Float32Array(w*h*3),flags=new Float32Array(w*h);
  const state={out,rows:null,
    add(s) {
      for(const l of settlementLights(s,w,h)) {
        const r=Math.ceil(l.sigma*3),k=-1/(2*l.sigma*l.sigma),y0=Math.max(0,Math.floor(l.v)-r),y1=Math.min(h-1,Math.floor(l.v)+r);
        for(let y=y0;y<=y1;y++) for(let dx=-r;dx<=r;dx++) {
          const x=((Math.floor(l.u)+dx)%w+w)%w,d2=(x+.5-l.u)**2+(y+.5-l.v)**2,g=Math.exp(k*d2)*l.peak;
          if(g<.004)continue;
          const i=y*w+x;
          for(let c=0;c<3;c++){acc[i*3+c]+=l.rgb[c]*g;out[i*4+c]=Math.min(255,Math.round(acc[i*3+c]*255));}
          if(l.flag)flags[i]=Math.max(flags[i],l.flag*Math.min(1,g*3));
          out[i*4+3]=Math.round(Math.min(1,flags[i])*255);
        }
        state.rows=state.rows?[Math.min(state.rows[0],y0),Math.max(state.rows[1],y1)]:[y0,y1];
      }
      return state;
    }};
  return state;
}

/** Bakes all settlements into an rgba8 equirect texture (w*h*4 bytes); additive in rgb, max in alpha flag. */
export function bakeNightLights(settlements,w=NIGHT_W,h=NIGHT_H,out=new Uint8Array(w*h*4)) {
  const b=createNightBake(w,h,out);
  for(const s of settlements)b.add(s);
  return out;
}
