const text=new TextDecoder('utf-8',{fatal:true});
const MUSIC_PATH=/^sound\\music\\[^:*?"<>|]+\.(mp3|wav)$/i;

export function table(bytes,fields,stride,name) {
  if(!(bytes instanceof Uint8Array)||bytes.length<20||bytes.length>16*1024*1024||
    String.fromCharCode(...bytes.subarray(0,4))!=='WDBC')throw Error(`Invalid ${name} DBC`);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint32(4,true),
    strings=view.getUint32(16,true),base=20+count*stride;
  if(view.getUint32(8,true)!==fields||view.getUint32(12,true)!==stride||base+strings!==bytes.length||!strings)
    throw Error(`Unsupported ${name} DBC layout`);
  return {count,u32:(row,field)=>view.getUint32(20+row*stride+field*4,true),
    str(row,field) {
      const offset=view.getUint32(20+row*stride+field*4,true);
      if(offset>=strings)throw Error(`${name} string is out of bounds`);
      const end=bytes.indexOf(0,base+offset);
      if(end<0)throw Error(`${name} string is unterminated`);
      return text.decode(bytes.subarray(base+offset,end));
    }};
}
export const index=t=>{
  const rows=new Map();
  for(let row=0;row<t.count;row++)rows.set(t.u32(row,0),row);
  return rows;
};

/** Zone music from the 1.12 AreaTable → ZoneMusic → SoundEntries chain; sub-areas inherit their parent's set. */
export class MusicCatalog {
  constructor(areaBytes,zoneBytes,soundBytes) {
    this.areas=table(areaBytes,25,100,'AreaTable');this.zones=table(zoneBytes,8,32,'ZoneMusic');
    this.sounds=table(soundBytes,29,116,'SoundEntries');
    this.areaRows=index(this.areas);this.zoneRows=index(this.zones);this.soundRows=index(this.sounds);
  }
  set(area) {
    let row=this.areaRows.get(area);
    for(let depth=0;depth<8&&row!==undefined;depth++) {
      const zone=this.areas.u32(row,8);
      if(zone&&this.zoneRows.has(zone))return zone;
      row=this.areaRows.get(this.areas.u32(row,2));
    }
    return 0;
  }
  /** Day/night silence range in ms and candidate files for a set; empty when the set has no playable kit. */
  tracks(set,night) {
    const row=this.zoneRows.get(set);
    if(row===undefined)return {silence:[0,0],paths:[]};
    const n=night?1:0,silence=[this.zones.u32(row,2+n),this.zones.u32(row,4+n)];
    const kit=this.soundRows.get(this.zones.u32(row,6+n)||this.zones.u32(row,7-n));
    if(kit===undefined)return {silence,paths:[]};
    const dir=this.sounds.str(kit,23),paths=[];
    for(let field=3;field<13;field++) {
      const file=this.sounds.str(kit,field);
      if(!file)continue;
      const path=dir&&!dir.endsWith('\\')?`${dir}\\${file}`:`${dir}${file}`;
      if(path.length<=260&&MUSIC_PATH.test(path))paths.push(path);
    }
    return {silence,paths};
  }
}

export class MusicService {
  constructor(source,emit) {this.source=source;this.emit=emit;this.catalog=undefined;}
  async load(shouldDefer) {
    if(this.catalog)return this.catalog;
    const read=name=>this.source.read(`DBFilesClient\\${name}.dbc`,{background:true,shouldDefer});
    const [area,zone,sound]=await Promise.all([read('AreaTable'),read('ZoneMusic'),read('SoundEntries')]);
    return this.catalog=new MusicCatalog(area,zone,sound);
  }
  /** Replies with the area's set; with `track`, also one random file not equal to `avoid`. */
  async request({token,area,night,track,avoid},stopped=()=>false) {
    const shouldDefer=stopped;
    try {
      const catalog=await this.load(shouldDefer),set=catalog.set(area),{silence,paths}=catalog.tracks(set,night);
      const reply={event:'music',token,area,set,silence,tracks:paths.length};
      if(!track||!paths.length){this.emit(reply);return;}
      const choices=paths.length>1?paths.filter(p=>p!==avoid):paths,path=choices[Math.floor(Math.random()*choices.length)];
      const bytes=await this.source.read(path,{background:true,shouldDefer});
      if(stopped())return;
      if(bytes.byteLength>32*1024*1024)throw Error('Music track exceeds 32 MiB');
      this.emit({...reply,path,bytes});
    } catch(error) {
      if(stopped())return;
      this.emit({event:'music',token,area,retry:error.code==='DEFERRED',error:error.code==='DEFERRED'?undefined:String(error.message||error)});
    }
  }
}
