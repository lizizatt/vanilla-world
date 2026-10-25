import {regimeOf} from './regime.js';
const FADE=2;

/** Intermittent zone music: tracks arrive as encoded bytes from the worker, play through a media element, then silence. */
export class MusicPlayer {
  constructor({request,context,now=()=>performance.now(),random=Math.random}) {
    Object.assign(this,{requestMusic:request,context,clock:now,random,isNight:false,enabled:true,battle:false,battlePlay:false,cues:new Map(),cueWanted:new Set()});
    this.volume=.5;this.set=0;this.area=undefined;this.areaAt=-1e9;this.nextAt=0;this.silence=[0,0];this.tracks=0;
    this.pending=false;this.current=undefined;this.playing=new Set();this.errors=0;this.lastError='';this.serial=0;
  }
  get night() {return this.isNight;}
  setNight(night) {
    night=!!night;
    if(night===this.isNight)return;
    this.isNight=night;this.area=undefined;this.nextAt=0;this.fadeOut();
  }
  output(ctx) {
    if(!this.master||this.master.context!==ctx){
      this.master=ctx.createGain();this.master.gain.value=this.volume;this.master.connect(ctx.masterOut||ctx.destination);
    }
    return this.master;
  }
  setVolume(value) {
    this.volume=Math.max(0,Math.min(1,Number.isFinite(value)?value:0));
    const ctx=this.context();
    if(this.master&&ctx)this.master.gain.setTargetAtTime(this.volume,ctx.currentTime,.05);
    if(!this.volume)this.fadeOut();
  }
  setEnabled(on) {
    on=!!on;
    if(on===this.enabled)return;
    this.enabled=on;
    if(!on)this.fadeOut();else{this.area=this.battle?'battle':undefined;this.nextAt=0;}
  }
  /** Race mode: zone music fades out while on; the looped Battle track plays once play (at GO). */
  setBattle(on,play=on) {
    on=!!on;play=on&&!!play;
    if(on!==this.battle){
      this.battle=on;this.area=on?'battle':undefined;this.resolved=false;this.pending=false;this.nextAt=0;this.serial++;this.fadeOut();
    }
    if(play!==this.battlePlay){this.battlePlay=play;this.nextAt=0;}
  }
  update(area,active) {
    const ctx=this.context(),now=this.clock();
    if(!active||!this.volume||!this.enabled||ctx?.state!=='running'){this.suspend(true);return;}
    this.suspend(false);
    if(this.battle) {
      if(this.battlePlay&&!this.current&&!this.pending&&now>=this.nextAt){
        this.pending=true;this.requestMusic({token:++this.serial,area:'battle',battle:true,avoid:this.lastPath});
      }
      return;
    }
    if(area!==this.area&&now-this.areaAt>1000){
      this.area=area;this.areaAt=now;this.resolved=false;
      this.requestMusic({token:++this.serial,area,night:this.night,track:false});
    }
    if(this.resolved&&this.set&&this.tracks&&!this.current&&!this.pending&&now>=this.nextAt){
      this.pending=true;
      this.requestMusic({token:++this.serial,area:this.area,night:this.night,track:true,avoid:this.lastPath});
    }
  }
  /** Fetch the cue once (in memory only); playCue is a no-op until it has decoded. */
  loadCue(name) {
    if(this.cues.has(name)||this.cueWanted.has(name))return;
    this.cueWanted.add(name);this.requestMusic({token:++this.serial,cue:name});
  }
  playCue(name,volume=1) {
    const ctx=this.context(),buffer=this.cues.get(name);
    if(!this.enabled||!ctx||ctx.state!=='running'||!buffer)return false;
    const source=ctx.createBufferSource(),gain=ctx.createGain();
    source.buffer=buffer;gain.gain.value=volume*this.volume;source.connect(gain);gain.connect(ctx.masterOut||ctx.destination);source.start();
    source.onended=()=>{source.disconnect();gain.disconnect();};
    return true;
  }
  event(data) {
    const now=this.clock();
    if(data.cue) {
      const ctx=this.context();
      if(data.bytes&&ctx)ctx.decodeAudioData(data.bytes.buffer.slice(data.bytes.byteOffset,data.bytes.byteOffset+data.bytes.byteLength))
        .then(buffer=>this.cues.set(data.cue,buffer)).catch(()=>this.cueWanted.delete(data.cue));
      else this.cueWanted.delete(data.cue);
      return;
    }
    if(data.battle) {
      if(!this.battle)return;
      if(data.error||data.retry||!data.bytes){this.pending=false;this.nextAt=now+(data.retry?2000:30000);if(data.error){this.errors++;this.lastError=data.error;}return;}
      this.pending=false;
      if(!this.current)this.start(data);
      return;
    }
    if(data.error){this.errors++;this.lastError=data.error;this.pending=false;this.nextAt=now+60000;return;}
    if(data.retry){
      this.area=undefined;
      this.pending=false;this.nextAt=now+2000;return;
    }
    if(data.area!==this.area)return;
    if(data.set!==this.set){
      this.fadeOut();this.set=data.set;this.nextAt=0;
    }
    this.silence=data.silence;this.tracks=data.tracks;this.resolved=true;
    if(!data.bytes)return;
    this.pending=false;
    if(data.set===this.set&&!this.current)this.start(data);
  }
  start(data) {
    const ctx=this.context();
    if(!ctx||ctx.state!=='running')return;
    const url=URL.createObjectURL(new Blob([data.bytes],{type:data.path.endsWith('.wav')?'audio/wav':'audio/mpeg'})),
      element=new Audio(url),gain=ctx.createGain(),track={element,gain,url,source:undefined};
    track.source=ctx.createMediaElementSource(element);track.source.connect(gain);gain.connect(this.output(ctx));
    gain.gain.setValueAtTime(0,ctx.currentTime);gain.gain.linearRampToValueAtTime(1,ctx.currentTime+FADE);
    element.loop=!!data.battle;
    this.current=track;this.lastPath=data.path;this.playing.add(track);
    element.onended=()=>{
      if(this.current===track){
        this.current=undefined;
        const [min,max]=this.silence;this.nextAt=this.clock()+min+this.random()*Math.max(0,max-min);
      }
      this.dispose(track);
    };
    element.play().catch(error=>{
      this.errors++;this.lastError=String(error.message||error);
      if(this.current===track){this.current=undefined;this.nextAt=this.clock()+30000;}
      this.dispose(track);
    });
  }
  fadeOut() {
    const track=this.current,ctx=this.context();
    this.current=undefined;
    if(!track)return;
    if(ctx)track.gain.gain.setTargetAtTime(0,ctx.currentTime,FADE/4);
    setTimeout(()=>this.dispose(track),FADE*1000+250);
  }
  suspend(value) {
    if(this.suspended===value)return;
    this.suspended=value;
    for(const track of this.playing)value?track.element.pause():track.element.play().catch(()=>{});
  }
  dispose(track) {
    if(!this.playing.delete(track))return;
    track.element.onended=null;track.element.pause();track.element.removeAttribute('src');track.element.load();
    track.source.disconnect();track.gain.disconnect();URL.revokeObjectURL(track.url);
  }
  stop() {
    this.current=undefined;this.pending=false;this.set=0;this.area=undefined;this.tracks=0;
    for(const track of [...this.playing])this.dispose(track);
  }
  snapshot() {
    return {set:this.set,area:this.area,tracks:this.tracks,playing:this.playing.size,active:!!this.current,
      time:this.current?.element.currentTime||0,volume:this.volume,pending:this.pending,errors:this.errors,error:this.lastError,
      battle:this.battle,battlePlay:this.battlePlay,enabled:this.enabled,cues:[...this.cues.keys()],silenceMs:this.silence,nextInMs:Math.max(0,Math.round(this.nextAt-this.clock())),track:this.lastPath};
  }
}

/** Zone music while flying: follows the zone under the camera near the ground, and holds the last zone once the terrain bends away (atmosphere/orbit) so it never goes silent. */
export const flightMusicArea=(area,altitude,held)=>altitude===undefined||regimeOf(altitude)==='ground'?area:held??area;
