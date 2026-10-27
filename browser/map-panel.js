import {imageRects,schematicRects,mapFrame,toMap,mapIcons,drawMap,stitch,worldArt,WORLD_ART_URL,WORLD_ART_SIZE,ELUNE_ART} from './worldmap.js';
import {maelstromCentre} from './clouds.js';

/** Fullscreen world map dialog. The bundled painting is the map; icons are projected into it with the fitted per-continent transform (worldArt). Without the painting a schematic is drawn, with Data art when it arrives. */
export class MapPanel {
  constructor({dialog,canvas,stage,status,close},  {requestArt,teleport,pose,tracks=()=>[],bodies=()=>[],teleportBody=()=>{}}) {
      Object.assign(this,{dialog,canvas,stage,status,requestArt,teleport,pose,tracks,bodies,teleportBody,rows:undefined,images:new Map(),requested:false,timer:0});
    close.addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>this.stop());
    this.you=stage.ownerDocument.createElement('div');this.you.id='map-you';this.you.hidden=true;
  }
  configure(manifest) {
    // A moon's manifest has no Azeroth world layout (no world_bounds): the panel keeps showing Azeroth's map while the ship is away from it.
    if(this.manifest&&!manifest?.world_bounds)return;
    this.manifest=manifest;this.rows=undefined;this.images.clear();this.requested=false;
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
  /** Only without the bundled painting: ask the worker for the Data continent art. */
  fetchData() {
    if(this.requested||!this.manifest)return;
    this.requested=true;this.requestArt(this.manifest.regions.map(r=>r.map));
    if(this.dialog.open)this.render();
  }
  stop() {clearInterval(this.timer);}
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
      this.place=(x,z)=>toMap(this.frame,x,z);
    }
    const aspect=project?aw/ah:this.frame.width/this.frame.height;
    this.stage.style.setProperty('--map-aspect',aspect);
    this.canvas.height=Math.round(this.canvas.width/aspect);
    const images=project?[]:manifest.regions.map(r=>this.images.get(r.map.toLowerCase()));
    if(project){const context=this.canvas.getContext('2d');context.clearRect(0,0,this.canvas.width,this.canvas.height);context.drawImage(this.art,0,0,this.canvas.width,this.canvas.height);}
    else drawMap(this.canvas,this.frame,use,art?images:undefined,!art||images.some(i=>!i));
    this.status.textContent=project?'':rows===undefined?'Loading map art...':art?(images.every(Boolean)?'':'Loading map art...'):'Map art unavailable'+(this.error?` (${this.error})`:'')+'; showing schematic.';
    for(const old of this.stage.querySelectorAll('.map-icon,.map-track'))old.remove();
    for(const icon of mapIcons(manifest,centre)) {
      const [u,v]=this.place(...icon.position),button=this.stage.ownerDocument.createElement('button');
      button.type='button';button.className='map-icon';button.dataset.icon=icon.id;button.textContent={raceway:'Raceway',maelstrom:'Maelstrom',airport:'Airport',stormwind:'Stormwind',orgrimmar:'Orgrimmar',undercity:'Undercity',darnassus:'Darnassus'}[icon.id];
      button.title=button.ariaLabel=`Teleport to ${icon.label}`;
      button.style.left=`${u*100}%`;button.style.top=`${v*100}%`;
      button.addEventListener('click',()=>{this.dialog.close();this.teleport(icon);});button.addEventListener('pointerdown',e=>e.preventDefault());
      this.stage.append(button);
    }
    const stacked=this.bodies().filter(b=>!(project&&b.id==='elune'));
    for(const body of this.bodies()) { // one plain button per moon from the body config; Elune sits on the painted moon
      const button=this.stage.ownerDocument.createElement('button');
      button.type='button';button.className='map-icon map-body';button.dataset.body=body.id;button.textContent=body.label;
      button.title=button.ariaLabel=`Teleport to ${body.label}`;
      if(project&&body.id==='elune'){button.style.left=`${ELUNE_ART[0]/aw*100}%`;button.style.top=`${ELUNE_ART[1]/ah*100}%`;}
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
