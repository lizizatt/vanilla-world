import {imageRects,schematicRects,mapFrame,moonFrame,moonSpot,toMap,mapIcons,drawMap,stitch,worldArt,WORLD_ART_URL,WORLD_ART_SIZE,ELUNE_ART} from './worldmap.js';
import {maelstromCentre} from './clouds.js';
import {MapRaster,renderMap} from './map-render.js';
import {mapBitmap} from './world-store.js';
const TILE=1600/3,REFINE_MS=1500;

/** Fullscreen world map dialog. The map is generated from the far terrain already streamed (map-render.js) in the panel's own chart, so icons align by construction; a local painting (world-map-art.jpg, fitted by worldArt) overrides it when present. Before any terrain has arrived a schematic is drawn. */
export class MapPanel {
  constructor({dialog,canvas,stage,status,close},  {requestArt,teleport,pose,tracks=()=>[],bodies=()=>[],teleportBody=()=>{}}) {
      Object.assign(this,{dialog,canvas,stage,status,requestArt,teleport,pose,tracks,bodies,teleportBody,rows:undefined,images:new Map(),requested:false,timer:0,renderer:renderMap});
    close.addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>this.stop());
    this.you=stage.ownerDocument.createElement('div');this.you.id='map-you';this.you.hidden=true;
  }
  configure(manifest,sourceId) {
    // A moon's manifest has no Azeroth world layout (no world_bounds): the panel keeps showing Azeroth's map while the ship is away from it.
    if(this.manifest&&!manifest?.world_bounds)return;
    this.manifest=manifest;this.rows=undefined;this.images.clear();this.requested=false;
    if(!this.raster||!sourceId||sourceId!==this.sourceId){this.raster=new MapRaster(manifest);this.gen=this.cache=undefined;}
    this.sourceId=sourceId;
    const queued=this.pending;this.pending=undefined;
    for(const data of queued??[])this.far(data);
  }
  /** Far-terrain events (Azeroth only): the same heights and minimap colour the horizon draws, folded into the map's chart-space raster. Cheap; rendering waits for the panel to be open. Events that stream in while the world is still opening are queued until configure(). */
  far(data) {
    const {raster,manifest}=this;
    if(!raster||!manifest){const q=this.pending??=[];if(q.length<6000)q.push(data);return;}
    if(data.event==='horizon')raster.addHeights(data.vertices,data.placement);
    else if(data.event==='horizon-material'){
      const r=manifest.regions[data.region];if(!r||data.rgba.length!==32*32*4)return;
      raster.addMinimap(data.rgba,[r.placement[0]+(data.x-r.tile_origin[0])*TILE,r.placement[1]+(data.y-r.tile_origin[1])*TILE]);
    } else return;
    if(this.dialog.open&&!this.refine)this.refine=setTimeout(()=>{this.refine=0;if(this.dialog.open)this.render();},REFINE_MS);
  }
  /** The generated map canvas/bitmap for this chart frame: the saved bitmap while it is at least as complete as the live data, else a fresh render (at most one per REFINE_MS). */
  generated(frame,centre,moon) {
    const raster=this.raster,key=[frame.x0,frame.z0,frame.width,frame.height].map(Math.round).join(','),tiles=raster.tiles.size;
    if(this.cache===undefined&&this.sourceId){this.cache=null;this.loadCache(key);}
    const gen=this.gen,saved=this.cache?.key===key?this.cache:undefined;
    if(gen&&gen.key===key&&(gen.revision===raster.revision||Date.now()-gen.at<REFINE_MS))return gen.canvas;
    if(!tiles)return saved?.bitmap;
    if(saved&&!gen&&saved.tiles>=tiles)return saved.bitmap;
    const canvas=this.renderer({raster,frame,sea:this.manifest.sea_level??0,maelstrom:centre,moon,make:()=>this.stage.ownerDocument.createElement('canvas')});
    this.gen={key,canvas,revision:raster.revision,tiles,at:Date.now()};
    if(this.sourceId&&canvas.toBlob&&tiles>(saved?.tiles??0)+8){
      clearTimeout(this.saving);
      this.saving=setTimeout(()=>canvas.toBlob(blob=>{if(blob)mapBitmap(this.sourceId,key,{key,tiles,blob}).catch(()=>{});},'image/webp',.88),2500);
    }
    return canvas;
  }
  loadCache(key) {
    mapBitmap(this.sourceId,key).then(rec=>rec?.blob&&createImageBitmap(rec.blob).then(bitmap=>{this.cache={key,tiles:rec.tiles,bitmap};if(this.dialog.open)this.render();})).catch(()=>{});
  }
  event(data) {
    if(data.event==='worldmap'){this.rows=data.error?null:data.rows;this.error=data.error;}
    else if(data.event==='worldmap-tiles'){
      try {this.images.set(data.name.toLowerCase(),stitch(data.tiles));} catch(error){console.warn(error.message);}
    }
    if(this.dialog.open)this.render();
  }
  get open() {return this.dialog.open;}
  toggle() {if(this.dialog.open)this.dialog.close();else this.show();}
  show() {
    if(!this.manifest)return;
    if(this.art===undefined){this.art=null;fetch(WORLD_ART_URL).then(r=>r.ok?r.blob():null).then(b=>b&&createImageBitmap(b)).then(i=>{if(i){this.art=i;if(this.dialog.open)this.render();}else this.artFailed=true;}).catch(()=>{this.artFailed=true;}).finally(()=>{if(this.artFailed)this.fetchData();});}
    else if(this.artFailed)this.fetchData();
    const was=document.activeElement;this.dialog.show();was?.focus?.();this.render();
    clearInterval(this.timer);this.timer=setInterval(()=>this.marker(),100);
  }
  /** Only before any terrain has streamed (no generated map yet): ask the worker for the Data continent art for the fallback. */
  fetchData() {
    if(this.requested||!this.manifest||this.raster?.tiles.size)return;
    this.requested=true;this.requestArt(this.manifest.regions.map(r=>r.map));
    if(this.dialog.open)this.render();
  }
  stop() {clearInterval(this.timer);clearTimeout(this.refine);this.refine=0;}
  render() {
    const {manifest,rows}=this;
    const rects=rows?imageRects(manifest,rows):[],art=rows&&rects.some(Boolean);
    const centre=maelstromCentre(manifest),schematic=schematicRects(manifest);
    const use=art?rects.map((r,i)=>r||schematic[i]):schematic;
    const project=this.art&&worldArt(manifest,centre);
    this.project=project;
    const [aw,ah]=WORLD_ART_SIZE;
    if(project){
      this.place=(x,z)=>{const p=project(x,z);return [p[0]/aw,p[1]/ah];};
      this.frame=undefined;
    } else {
      this.frame=mapFrame(use,[centre,[manifest.spawn[0],manifest.spawn[2]]]);
      if(this.raster)this.frame=moonFrame(this.frame);
      this.place=(x,z)=>toMap(this.frame,x,z);
    }
    this.moonAt=!project&&this.raster?moonSpot(this.frame,centre):undefined;
    const made=!project&&this.raster?this.generated(this.frame,centre,this.moonAt):undefined;
    const aspect=project?aw/ah:this.frame.width/this.frame.height;
    this.stage.style.setProperty('--map-aspect',aspect);
    this.canvas.height=Math.round(this.canvas.width/aspect);
    const images=project||made?[]:manifest.regions.map(r=>this.images.get(r.map.toLowerCase()));
    if(project){const context=this.canvas.getContext('2d');context.clearRect(0,0,this.canvas.width,this.canvas.height);context.drawImage(this.art,0,0,this.canvas.width,this.canvas.height);}
    else if(made){const context=this.canvas.getContext('2d');context.clearRect(0,0,this.canvas.width,this.canvas.height);context.drawImage(made,0,0,this.canvas.width,this.canvas.height);}
    else drawMap(this.canvas,this.frame,use,art?images:undefined,!art||images.some(i=>!i));
    this.status.textContent=project||made?'':rows===undefined?'Loading map art...':art?(images.every(Boolean)?'':'Loading map art...'):'Map art unavailable'+(this.error?` (${this.error})`:'')+'; showing schematic.';
    for(const old of this.stage.querySelectorAll('.map-icon,.map-track'))old.remove();
    for(const icon of mapIcons(manifest,centre)) {
      const [u,v]=this.place(...icon.position),button=this.stage.ownerDocument.createElement('button');
      button.type='button';button.className='map-icon';button.dataset.icon=icon.id;button.textContent={raceway:'Raceway',maelstrom:'Maelstrom',airport:'Airport',stormwind:'Stormwind',orgrimmar:'Orgrimmar',undercity:'Undercity',darnassus:'Darnassus'}[icon.id];
      button.title=button.ariaLabel=`Teleport to ${icon.label}`;
      button.style.left=`${u*100}%`;button.style.top=`${v*100}%`;
      button.addEventListener('click',()=>{this.dialog.close();this.teleport(icon);});button.addEventListener('pointerdown',e=>e.preventDefault());
      this.stage.append(button);
    }
    const onMoon=b=>b.id==='elune'&&(project||made),stacked=this.bodies().filter(b=>!onMoon(b));
    for(const body of this.bodies()) { // one plain button per moon from the body config; Elune sits on the painted moon
      const button=this.stage.ownerDocument.createElement('button');
      button.type='button';button.className='map-icon map-body';button.dataset.body=body.id;button.textContent=body.label;
      button.title=button.ariaLabel=`Teleport to ${body.label}`;
      if(onMoon(body)){const [u,v]=project?[ELUNE_ART[0]/aw,ELUNE_ART[1]/ah]:this.place(...this.moonAt);button.style.left=`${u*100}%`;button.style.top=`${v*100}%`;}
      else{button.style.right='8px';button.style.bottom=`${8+stacked.indexOf(body)*34}px`;button.style.left='auto';button.style.top='auto';}
      button.addEventListener('click',()=>{this.dialog.close();this.teleport({id:body.id,label:body.label,body:body.id});});button.addEventListener('pointerdown',e=>e.preventDefault());
      this.stage.append(button);
    }
    for(const t of this.tracks()) { // race start markers (a flagpole + beacon stands there in the world); informational, not teleports
      const [u,v]=this.place(t.start.pos[0],t.start.pos[2]),pin=this.stage.ownerDocument.createElement('span');
      pin.className='map-track';pin.dataset.track=t.id;pin.title=pin.ariaLabel=`Race start: ${t.name??t.id}`;pin.textContent='\u2691';
      pin.style.left=`${u*100}%`;pin.style.top=`${v*100}%`;this.stage.append(pin);
    }
    this.stage.append(this.you);
    this.marker();
  }
  marker() {
    const p=this.pose();
    if(!p||!this.place){this.you.hidden=true;return;}
    const [u,v]=this.place(p[0],p[2]);
    this.you.hidden=false;this.you.style.left=`calc(${u*100}% - 8px)`;this.you.style.top=`calc(${v*100}% - 15px)`;
    this.you.style.transform=`rotate(${-p[3]}rad)`;this.you.title='You are here';
  }
}
