import {imageRects,schematicRects,mapFrame,toMap,mapIcons,drawMap,stitch,WORLD_MAPS,worldImageRect,iconMapPosition} from './worldmap.js';
import {maelstromCentre} from './clouds.js';

/** Fullscreen world map dialog. Art arrives from the worker (runtime Data read); without it a schematic is drawn. */
export class MapPanel {
  constructor({dialog,canvas,stage,status,close},  {requestArt,teleport,pose,tracks=()=>[],bodies=()=>[],teleportBody=()=>{}}) {
      Object.assign(this,{dialog,canvas,stage,status,requestArt,teleport,pose,tracks,bodies,teleportBody,rows:undefined,images:new Map(),requested:false,timer:0});
    close.addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>this.stop());
    this.you=stage.ownerDocument.createElement('div');this.you.id='map-you';this.you.hidden=true;
  }
  configure(manifest) {
    this.manifest=manifest;this.rows=undefined;this.images.clear();this.requested=false;
  }
  event(data) {
    if(data.event==='worldmap'){this.rows=data.error?null:data.rows;this.error=data.error;}
    else if(data.event==='worldmap-tiles'){
      try {this.images.set(data.name.toLowerCase(),stitch(data.tiles));} catch(error){console.warn(error.message);}
    }
    if(this.dialog.open)this.render();
  }
  // One WoW world map covers both continents and the Maelstrom: it is stretched over their combined bounds.
  world(image,rects) {
    const box=rects.length===4&&typeof rects[0]==='number'?[rects]:rects;
    const xs=box.flatMap(r=>[r[0],r[2]]),zs=box.flatMap(r=>[r[1],r[3]]),f=this.frame,w=this.canvas.width,h=this.canvas.height,context=this.canvas.getContext('2d');
    const [u0,v0]=toMap(f,Math.min(...xs),Math.min(...zs)),[u1,v1]=toMap(f,Math.max(...xs),Math.max(...zs));
    context.clearRect(0,0,w,h);context.drawImage(image,u0*w,v0*h,(u1-u0)*w,(v1-v0)*h);
  }
  get open() {return this.dialog.open;}
  toggle() {if(this.dialog.open)this.dialog.close();else this.show();}
  show() {
    if(!this.manifest)return;
    if(this.local===undefined){this.local=null;fetch('/local/world-map.jpg').then(r=>r.ok?r.blob():null).then(b=>b&&createImageBitmap(b)).then(i=>{if(i){this.local=i;if(this.dialog.open)this.render();}}).catch(()=>{});}
    if(!this.requested){this.requested=true;this.requestArt(this.manifest.regions.map(r=>r.map));}
    const was=document.activeElement;this.dialog.show();was?.focus?.();this.render();
    clearInterval(this.timer);this.timer=setInterval(()=>this.marker(),100);
  }
  stop() {clearInterval(this.timer);}
  render() {
    const {manifest,rows}=this;
    const rects=rows?imageRects(manifest,rows):[],art=rows&&rects.some(Boolean);
    const centre=maelstromCentre(manifest),schematic=schematicRects(manifest);
    const use=art?rects.map((r,i)=>r||schematic[i]):schematic;
    const img=this.local&&use.length>1?worldImageRect(use,centre):null;this.imgRect=img;
    this.frame=mapFrame(use,[centre,[manifest.spawn[0],manifest.spawn[2]],...(img?[[img[0],img[1]],[img[2],img[3]]]:[])]);
    const aspect=this.frame.width/this.frame.height;
    this.stage.style.setProperty('--map-aspect',aspect);
    this.canvas.height=Math.round(this.canvas.width/aspect);
    const world=img?this.local:[...WORLD_MAPS,'Azeroth',...manifest.regions.map(r=>r.map)].map(n=>this.images.get(n.toLowerCase())).find(Boolean);
    const images=world?[]:manifest.regions.map(r=>this.images.get(r.map.toLowerCase()));
    if(world)this.world(world,img||use);else drawMap(this.canvas,this.frame,use,art?images:undefined,!art||images.some(i=>!i));
    this.status.textContent=rows===undefined?'Loading map art...':world?'':art?(images.every(Boolean)?'':'Loading map art...'):'Map art unavailable'+(this.error?` (${this.error})`:'')+'; showing schematic.';
    for(const old of this.stage.querySelectorAll('.map-icon,.map-track'))old.remove();
    for(const icon of mapIcons(manifest,centre)) {
      const [u,v]=toMap(this.frame,...iconMapPosition(icon,img)),button=this.stage.ownerDocument.createElement('button');
      button.type='button';button.className='map-icon';button.dataset.icon=icon.id;button.textContent={raceway:'Raceway',maelstrom:'Maelstrom',airport:'Airport',stormwind:'Stormwind',orgrimmar:'Orgrimmar',undercity:'Undercity',darnassus:'Darnassus'}[icon.id];
      button.title=button.ariaLabel=`Teleport to ${icon.label}`;
      button.style.left=`${u*100}%`;button.style.top=`${v*100}%`;
      button.addEventListener('click',()=>{this.dialog.close();this.teleport(icon);});button.addEventListener('pointerdown',e=>e.preventDefault());
      this.stage.append(button);
    }
    for(const body of this.bodies()) { // one plain button per moon from the body config
      const button=this.stage.ownerDocument.createElement('button');
      button.type='button';button.className='map-icon map-body';button.dataset.body=body.id;button.textContent=body.label;
      button.title=button.ariaLabel=`Fly to ${body.label}`;button.style.right='8px';button.style.bottom=`${8+this.bodies().indexOf(body)*34}px`;button.style.left='auto';button.style.top='auto';
      button.addEventListener('click',()=>{this.dialog.close();this.teleportBody(body.id);});button.addEventListener('pointerdown',e=>e.preventDefault());
      this.stage.append(button);
    }
    for(const t of this.tracks()) { // race start markers (a flagpole + beacon stands there in the world); informational, not teleports
      const [u,v]=toMap(this.frame,t.start.pos[0],t.start.pos[2]),pin=this.stage.ownerDocument.createElement('span');
      pin.className='map-track';pin.dataset.track=t.id;pin.title=pin.ariaLabel=`Race start: ${t.name??t.id}`;pin.textContent='\u2691';
      pin.style.left=`${u*100}%`;pin.style.top=`${v*100}%`;this.stage.append(pin);
    }
    this.stage.append(this.you);
    this.marker();
  }
  marker() {
    const p=this.pose();
    if(!p||!this.frame){this.you.hidden=true;return;}
    const [u,v]=toMap(this.frame,p[0],p[2]);
    this.you.hidden=false;this.you.style.left=`calc(${u*100}% - 8px)`;this.you.style.top=`calc(${v*100}% - 15px)`;
    this.you.style.transform=`rotate(${-p[3]}rad)`;this.you.title='You are here';
  }
}
