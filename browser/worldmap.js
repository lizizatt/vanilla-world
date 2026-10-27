// World map: Interface\WorldMap art is read from the user's Data at runtime and kept in memory only.
// Coordinate model: render x = Kx - wowY, render z = Kz - wowX, where K comes from each region's tile placement
// (north is -z, east is +x). WorldMapArea.dbc bounds are WoW coordinates, so each continent image drops into
// render space as a rectangle and the maelstrom (which lives in the gap between continents) can be drawn too.
import {CLOUD_ALTITUDE,CLOUD_THICKNESS,CLOUD_TOWER} from './cloud-config.js';
const TILE=256,COLUMNS=4,ROWS=3,SCALE=1600/3;
const NAME=/^[A-Za-z]{3,24}$/;
export const WORLD_MAPS=['World','Cosmic'];
/** The Data world map is a 1002x668 picture (same art and aspect as the local 800x533 jpg) inside the 1024x768 stitched tile canvas: source rect x,y,w,h. */
export const WORLD_ART=[0,0,1002,668];

export function worldMapAreas(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<20||bytes.length>1024*1024||
    String.fromCharCode(...bytes.subarray(0,4))!=='WDBC')throw Error('Invalid WorldMapArea DBC');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint32(4,true),
    fields=view.getUint32(8,true),stride=view.getUint32(12,true),strings=view.getUint32(16,true),base=20+count*stride;
  if(!count||count>4096||fields<8||stride!==fields*4||base+strings!==bytes.length)
    throw Error('Unsupported WorldMapArea DBC layout');
  const text=offset=>{
    const end=offset<strings?bytes.indexOf(0,base+offset):-1;
    if(end<0)throw Error('WorldMapArea string is out of bounds');
    return new TextDecoder().decode(bytes.subarray(base+offset,end));
  };
  return Array.from({length:count},(_,i)=>{
    const at=f=>20+i*stride+f*4;
    return {map:view.getInt32(at(1),true),area:view.getUint32(at(2),true),name:text(view.getUint32(at(3),true)),
      left:view.getFloat32(at(4),true),right:view.getFloat32(at(5),true),top:view.getFloat32(at(6),true),bottom:view.getFloat32(at(7),true)};
  });
}

const continentRows=(rows,regions)=>regions.map(region=>
  rows.find(row=>row.area===0&&row.name.toLowerCase()===region.map.toLowerCase()&&NAME.test(row.name)));

/** Render-space offset of a region's WoW origin. */
export const regionOffset=region=>[region.placement[0]+(32-region.tile_origin[0])*SCALE,region.placement[1]+(32-region.tile_origin[1])*SCALE];

/** Image rectangles (render yd, [x0,z0,x1,z1]) per region, or undefined when the DBC has no row for it. */
export function imageRects(manifest,rows) {
  return manifest.regions.map((region,i)=>{
    const row=continentRows(rows,[region])[0];
    if(!row)return undefined;
    const [kx,kz]=regionOffset(region);
    return [kx-row.left,kz-row.top,kx-row.right,kz-row.bottom];
  });
}

/** Schematic rectangles from the manifest when no map art is available. */
export function schematicRects(manifest) {
  return manifest.horizons.map(h=>{
    const r=manifest.regions[h.region];
    return [r.placement[0]+(h.source_bounds[0]-r.tile_origin[0])*SCALE,r.placement[1]+(h.source_bounds[1]-r.tile_origin[1])*SCALE,
      r.placement[0]+(h.source_bounds[2]-r.tile_origin[0])*SCALE,r.placement[1]+(h.source_bounds[3]-r.tile_origin[1])*SCALE];
  });
}

export function mapFrame(rects,extra=[],margin=.04) {
  const xs=[...rects.flatMap(r=>[r[0],r[2]]),...extra.map(p=>p[0])],zs=[...rects.flatMap(r=>[r[1],r[3]]),...extra.map(p=>p[1])];
  const x0=Math.min(...xs),x1=Math.max(...xs),z0=Math.min(...zs),z1=Math.max(...zs),mx=(x1-x0)*margin,mz=(z1-z0)*margin;
  return {x0:x0-mx,z0:z0-mz,width:x1-x0+2*mx,height:z1-z0+2*mz};
}
/** Render position to fractions of the map frame (0..1, z down). */
export const toMap=(frame,x,z)=>[(x-frame.x0)/frame.width,(z-frame.z0)/frame.height];
export const fromMap=(frame,u,v)=>[frame.x0+u*frame.width,frame.z0+v*frame.height];

/** City gate spawns in WoW world coordinates (x north, y west): map, [x,y,z], direction into the city as [dx,dy]. Render x=-y+offset, z=-x+offset, forward=(-sin yaw,-cos yaw). */
const GATES=[
  {id:'stormwind',label:'Stormwind gate',map:'Azeroth',wow:[-8985,497,102],into:[.8,.6],art:[560,335]},
  {id:'orgrimmar',label:'Orgrimmar gate',map:'Kalimdor',wow:[1330,-4420,35],into:[1,0],art:[272,196]},
  {id:'undercity',label:'Undercity gate',map:'Azeroth',wow:[1890,240,70],into:[-1,0],art:[558,150]},
  {id:'darnassus',label:'Darnassus gate',map:'Kalimdor',wow:[9950,2150,1330],into:[0,1],art:[132,80]},
];
/** Ironforge airport from WoW coords through the Eastern Kingdoms region offset, so it follows layout shifts. */
function airportPos(manifest) {
  const region=manifest.regions?.find(r=>r.map==='Azeroth');
  if(!region)return [19486,5703];
  const [kx,kz]=regionOffset(region);return [1694+kx,4636+kz];
}
function gateIcons(manifest) {
  return GATES.flatMap(g=>{
    const region=manifest.regions?.find(r=>r.map===g.map);
    if(!region)return [];
    const [kx,kz]=regionOffset(region),[x,y,z]=g.wow,pos=[-y+kx,-x+kz];
    return [{id:g.id,label:g.label,position:pos,art:g.art,pose:[pos[0],z,pos[1],Math.atan2(g.into[1],g.into[0])]}];
  });
}

/** Top of the cloud layer (slab plus the tallest storm towers), absolute render y: the maelstrom waypoint drops you here to fall through all of it. */
export const CLOUD_TOP_DROP=CLOUD_ALTITUDE+CLOUD_THICKNESS/2+CLOUD_TOWER.up+100;

/** Icons: the usual raceway spawn and the maelstrom centre, as render-space poses to teleport to. */
export function mapIcons(manifest,maelstrom) {
  const airport=airportPos(manifest);
  return [
    {id:'raceway',label:'Steamwheedle raceway (spawn)',position:[manifest.spawn[0],manifest.spawn[2]],reset:true},
    {id:'maelstrom',label:'The Maelstrom (cloud top)',position:maelstrom,pose:[maelstrom[0],CLOUD_TOP_DROP,maelstrom[1],0]},
    {id:'airport',label:'Ironforge airport',position:airport,pose:[airport[0],530,airport[1],-3.114]},
    ...gateIcons(manifest),
  ];
}

export function drawMap(canvas,frame,rects,images,schematic) {
  const context=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  context.clearRect(0,0,w,h);
  rects.forEach((rect,i)=>{
    if(!rect)return;
    const [u0,v0]=toMap(frame,rect[0],rect[1]),[u1,v1]=toMap(frame,rect[2],rect[3]);
    const x=u0*w,y=v0*h,dw=(u1-u0)*w,dh=(v1-v0)*h,image=images?.[i];
    if(image){context.globalAlpha=.78;context.drawImage(image,x,y,dw,dh);context.globalAlpha=1;}
    else {context.fillStyle='#4b5d3a';context.strokeStyle='#cbb978';context.lineWidth=3;context.fillRect(x,y,dw,dh);context.strokeRect(x,y,dw,dh);}
  });
  if(schematic){context.fillStyle='#cbb978';context.font='20px sans-serif';context.fillText('Schematic map (Data art unavailable)',16,h-16);}
}

/** Stitch 12 decoded 256x256 tiles ({index,width,height,rgba}) into one canvas. */
export function stitch(tiles,make=()=>document.createElement('canvas')) {
  const canvas=make();canvas.width=TILE*COLUMNS;canvas.height=TILE*ROWS;
  const context=canvas.getContext('2d');
  for(const t of tiles) {
    if(!(t.index>=0&&t.index<COLUMNS*ROWS)||t.width>TILE||t.height>TILE||t.rgba.length!==t.width*t.height*4)throw Error('Invalid map tile');
    context.putImageData(new ImageData(new Uint8ClampedArray(t.rgba.buffer,t.rgba.byteOffset,t.rgba.byteLength),t.width,t.height),(t.index%COLUMNS)*TILE,Math.floor(t.index/COLUMNS)*TILE);
  }
  return canvas;
}

/** Worker side: WorldMapArea.dbc plus the continent tiles for the given region map names. */
export class WorldMapService {
  constructor(source,emit,wasm) {this.source=source;this.emit=emit;this.wasm=wasm;this.sent=false;}
  async request(names,stopped=()=>false) {
    if(this.sent)return;
    this.sent=true;
    try {
      const read=path=>this.source.read(path,{background:true,shouldDefer:stopped});
      const rows=worldMapAreas(await read('DBFilesClient\\WorldMapArea.dbc'));
      this.emit({event:'worldmap',rows});
      // The single full-world map (both continents and the Maelstrom) is preferred; per-continent art is the fallback when Data lacks it.
      const hasRow=n=>rows.some(r=>r.area===0&&r.name.toLowerCase()===n.toLowerCase());
      const world=WORLD_MAPS.find(n=>hasRow(n));
      if(world){
        try {await this.tiles(world,rows,read,stopped);return;} catch(error) {if(error.code==='DEFERRED')throw error;}
      }
      for(const name of names) {
        if(!NAME.test(name)||!hasRow(name))continue;
        await this.tiles(name,rows,read,stopped);
        if(stopped())return;
      }
    } catch(error) {
      this.sent=false;
      if(stopped())return;
      if(error.code==='DEFERRED')setTimeout(()=>this.request(names,stopped),2000);
      else this.emit({event:'worldmap',error:String(error.message||error)});
    }
  }
  async tiles(name,rows,read,stopped) {
    const row=rows.find(r=>r.area===0&&r.name.toLowerCase()===name.toLowerCase()),tiles=[],transfers=[];
    for(let i=0;i<COLUMNS*ROWS;i++) {
      const handle=new this.wasm.SceneTexture(await read(`Interface\\WorldMap\\${row.name}\\${row.name}${i+1}.blp`));
      try {const meta=JSON.parse(handle.metadata()),rgba=handle.rgba();tiles.push({index:i,width:meta.width,height:meta.height,rgba});transfers.push(rgba.buffer);} finally {handle.free();}
    }
    if(stopped())return;
    this.emit({event:'worldmap-tiles',name,tiles},transfers);
  }
}

// The combined world map (local art, 800x533): pixel anchors of Kalimdor and Eastern Kingdoms extents and the Maelstrom eye, fitted to our layout per axis (least squares), since the art is stylised.
export const WORLD_IMAGE={width:800,height:533,kalimdor:[100,100,300,460],eastern:[535,45,720,445],maelstrom:[400,270]};
export function worldImageRect(rects,centre,image=WORLD_IMAGE) {
  const fit=pairs=>{
    const n=pairs.length,sx=pairs.reduce((s,p)=>s+p[0],0),sy=pairs.reduce((s,p)=>s+p[1],0),sxx=pairs.reduce((s,p)=>s+p[0]*p[0],0),sxy=pairs.reduce((s,p)=>s+p[0]*p[1],0);
    const a=(n*sxy-sx*sy)/(n*sxx-sx*sx);return [a,(sy-a*sx)/n];
  };
  const [k,e]=rects,[kp,ep]=[image.kalimdor,image.eastern];
  const px=[[k[0],kp[0]],[k[2],kp[2]],[e[0],ep[0]],[e[2],ep[2]],[centre[0],image.maelstrom[0]]],pz=[[k[1],kp[1]],[k[3],kp[3]],[e[1],ep[1]],[e[3],ep[3]],[centre[1],image.maelstrom[1]]];
  // One scale for both axes keeps the image's aspect ratio; only the offsets are fitted per axis.
  const a=Math.sqrt(fit(px)[0]*fit(pz)[0]),offset=pairs=>pairs.reduce((s,p)=>s+p[1]-a*p[0],0)/pairs.length;
  const ax=a,az=a,bx=offset(px),bz=offset(pz);
  return [-bx/ax,-bz/az,(image.width-bx)/ax,(image.height-bz)/az];
}
/** Where an icon is drawn on the world-art map: its city's pixel in the art if known, else its real position; art pixels map through the image rect. */
export function iconMapPosition(icon,img,image=WORLD_IMAGE) {
  if(!icon.art||!img)return icon.position;
  return [img[0]+icon.art[0]/image.width*(img[2]-img[0]),img[1]+icon.art[1]/image.height*(img[3]-img[1])];
}
