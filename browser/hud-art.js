// Optional WoW art for the flight HUD (compass ring, number font), read from the user's Data like every other texture. Both are cosmetic: when absent the HUD keeps its CSS/SVG look.
export const HUD_RING='Interface\\Minimap\\UI-Minimap-Border.blp';
export const HUD_FONT='Fonts\\FRIZQT__.TTF';
/** The gold ring (with its "N") inside the 256x256 minimap border texture, in texels. */
export const RING_CROP=Object.freeze({x:96,y:34,size:144});
const MAX_FONT=1048576;

export class HudArtService {
  constructor(source,emit,wasm) {this.source=source;this.emit=emit;this.wasm=wasm;this.sent=false;}
  async request(stopped=()=>false) {
    if(this.sent)return;
    this.sent=true;
    const read=path=>this.source.read(path,{background:true,shouldDefer:stopped});
    const out={event:'hud-art'},transfers=[];
    try {
      const handle=new this.wasm.SceneTexture(await read(HUD_RING));
      try {
        const meta=JSON.parse(handle.metadata()),rgba=handle.rgba();
        if(meta.width===256&&meta.height===256&&rgba.length===256*256*4){out.ring={width:256,height:256,rgba};transfers.push(rgba.buffer);}
      } finally {handle.free();}
    } catch(error) {if(error.code==='DEFERRED'){this.sent=false;if(!stopped())setTimeout(()=>this.request(stopped),2000);return;}}
    try {
      const bytes=await read(HUD_FONT);
      if(bytes?.byteLength&&bytes.byteLength<=MAX_FONT){out.font=bytes;transfers.push(bytes.buffer);}
    } catch {/* optional */}
    if(!stopped())this.emit(out,transfers);
  }
}
