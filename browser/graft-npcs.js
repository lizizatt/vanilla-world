// Creatures of a grafted site (design/elune.md): the source map's spawns moved by the same tile delta and yOffset as the terrain and doodads.
import {sitesOf,tilesOf,domeCentre} from './elune-sites.js';
import {ADT_TILE} from './adt-synth.js';
import {MOON_TILES_X,MOON_TILES_Y} from './moon-terrain.js';

export const RIM_BAND=40;
const CX=MOON_TILES_X/2,CY=MOON_TILES_Y/2,WOW_EDGE=17066.666666666668,NPC_ID_BASE=1e6;
/** Virtual file served by graftSource: each site's yOffset (yd the source heights were raised by), which the engine needs to stand translated creatures on the ground. */
export const GRAFT_INFO='world\\maps\\elune\\graft.json';

/** Creatures (pack shape, WoW coordinates x=north,y=west) of a site's source tiles moved by the graft's tile delta and yOffset. Those within RIM_BAND of the dome circle are dropped (the ground is re-heighted there); ids are offset so they cannot clash. */
export function translateSpawns(spawns,site,{yOffset,mapId=1}) {
  const out=[],[sx0,sz0]=domeCentre(site,CX,CY),limit=site.dome.radius-RIM_BAND,tiles=tilesOf(site);
  for(const s of spawns) {
    if(s.map!==mapId)continue;
    const sx=Math.floor((WOW_EDGE-s.position[1])/ADT_TILE),sy=Math.floor((WOW_EDGE-s.position[0])/ADT_TILE),t=tiles.find(q=>q.sx===sx&&q.sy===sy);
    if(!t)continue;
    const fx=WOW_EDGE-s.position[1]+(t.dx-t.sx)*ADT_TILE,fz=WOW_EDGE-s.position[0]+(t.dy-t.sy)*ADT_TILE;
    if(Math.hypot(fx-CX*ADT_TILE-sx0,fz-CY*ADT_TILE-sz0)>limit)continue;
    out.push({...s,id:NPC_ID_BASE+s.id,position:[WOW_EDGE-fz,WOW_EDGE-fx,s.position[2]+yOffset]});
  }
  return out;
}

/** The population of a body: only its sites' creatures, never the source map's own spawns (the body's tile grid reuses the source map's coordinates). Undefined when there is nothing to place. */
export async function bodyPopulation(bodyId,pack,source) {
  const sites=sitesOf(bodyId);
  if(!pack||!sites.length)return undefined;
  const info=JSON.parse(new TextDecoder().decode(await source.read(GRAFT_INFO)));
  const spawns=sites.flatMap(site=>translateSpawns(pack.spawns,site,{yOffset:info[site.id]??0}));
  return {...pack,spawns};
}
