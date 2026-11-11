// WoW dialog art for the game's own windows (menu, garage, settings): the 3x3 border, tiled background, header plaque and UI fonts, read from the user's Data at
// runtime like hud-art.js. Nothing is bundled or committed; the decoded pixels become blob: URLs and CSS custom properties on <html>.
export const UI_ART=Object.freeze({
  border:'Interface\\DialogFrame\\UI-DialogBox-Border.blp',
  background:'Interface\\DialogFrame\\UI-DialogBox-Background.blp',
  header:'Interface\\DialogFrame\\UI-DialogBox-Header.blp',
});
export const UI_FONTS=Object.freeze({friz:'Fonts\\FRIZQT__.TTF',morpheus:'Fonts\\MORPHEUS.TTF'});
const MAX_FONT=1048576,MAX_TEXELS=1024*1024;

/** Worker side: decodes the textures and posts them once per data source. */
export class UiArtService {
  constructor(source,emit,wasm) {this.source=source;this.emit=emit;this.wasm=wasm;this.sent=false;}
  async request(stopped=()=>false) {
    if(this.sent)return;
    this.sent=true;
    const read=path=>this.source.read(path,{background:true,shouldDefer:stopped});
    const out={event:'ui-art',images:{},fonts:{}},transfers=[];
    for(const [name,path] of Object.entries(UI_ART)) {
      try {
        const handle=new this.wasm.SceneTexture(await read(path));
        try {
          const {width,height}=JSON.parse(handle.metadata()),rgba=handle.rgba();
          if(width*height<=MAX_TEXELS&&rgba.length===width*height*4){out.images[name]={width,height,rgba};transfers.push(rgba.buffer);}
        } finally {handle.free();}
      } catch(error) {if(error.code==='DEFERRED'){this.sent=false;if(!stopped())setTimeout(()=>this.request(stopped),2000);return;}}
    }
    for(const [name,path] of Object.entries(UI_FONTS)) {
      try {
        const bytes=await read(path);
        if(bytes?.byteLength&&bytes.byteLength<=MAX_FONT){out.fonts[name]=bytes;transfers.push(bytes.buffer);}
      } catch {/* a missing font keeps the system serif */}
    }
    if(!stopped())this.emit(out,transfers);
  }
}

/** Where each of the 8 cells of a 256x32 border strip lands in the 96x96 nine-slice: [cell, x, y, quarter-turns]. Top/bottom are stored rotated. */
export const NINE_SLICE=Object.freeze([[0,0,32,0],[1,64,32,0],[2,32,0,-1],[3,32,64,-1],[4,0,0,0],[5,64,0,0],[6,0,64,0],[7,64,64,0]]);

const canvasOf=(w,h)=>Object.assign(document.createElement('canvas'),{width:w,height:h});
const blobUrl=canvas=>new Promise(resolve=>canvas.toBlob(blob=>resolve(blob?URL.createObjectURL(blob):''),'image/png'));
const imageCanvas=({width,height,rgba})=>{const c=canvasOf(width,height);c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer,rgba.byteOffset,rgba.length),width,height),0,0);return c;};

async function nineSlice(source) {
  const c=canvasOf(96,96),g=c.getContext('2d');
  for(const [cell,x,y,turns] of NINE_SLICE) {
    g.save();g.translate(x+16,y+16);g.rotate(turns*Math.PI/2);g.drawImage(source,cell*32,0,32,32,-16,-16,32,32);g.restore();
  }
  return blobUrl(c);
}

/** Main thread side: turns the worker's decoded art into CSS variables, fonts and the `has-art` class. Every part is independent. */
export async function applyUiArt(data,root=document.documentElement) {
  const style=(name,url)=>{if(url)root.style.setProperty(name,`url(${url})`);};
  const {border,background,header}=data.images??{};
  if(border&&border.width===256&&border.height===32)style('--dlg-border',await nineSlice(imageCanvas(border)));
  if(background)style('--dlg-bg',await blobUrl(imageCanvas(background)));
  if(header){const c=canvasOf(256,Math.min(64,header.height));c.getContext('2d').drawImage(imageCanvas(header),0,0);style('--dlg-header',await blobUrl(c));}
  if(typeof FontFace==='function')for(const [key,family] of [['friz','WoW Friz'],['morpheus','WoW Morpheus']]) {
    const bytes=data.fonts?.[key];
    if(bytes)try{document.fonts.add(await new FontFace(family,bytes).load());root.dataset[`font${key}`]='1';}catch{/* unusable font file: system serif stays */}
  }
  if(border)root.classList.add('has-art');
  return root.classList.contains('has-art');
}
