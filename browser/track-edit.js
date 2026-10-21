// Pure track-editor model and screen/ground projection. No DOM. Same JSON format as browser/tracks/*.json.
import {validateTrack,breakoffDistance} from './race.js';

export const DEFAULT_WIDTH=70,MIN_WIDTH=20,MAX_WIDTH=200;
const TAN_HALF=.55; // matches the renderer's 0.55 projection slope

// Yaw whose forward (-sin, -cos) points from a to b on the ground plane.
export const yawToward=(a,b)=>Math.atan2(-(b[0]-a[0]),-(b[2]-a[2]));
export const slug=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

// view = renderer.view {eye,right,up,look,aspect}; returns [screenX,screenY,depth] or undefined behind the eye.
export function project(view,w,h,p) {
  const r=[p[0]-view.eye[0],p[1]-view.eye[1],p[2]-view.eye[2]],z=dot(r,view.look);
  if(!(z>1))return;
  return [(dot(r,view.right)/(TAN_HALF*view.aspect*z)+1)/2*w,(1-dot(r,view.up)/(TAN_HALF*z))/2*h,z];
}

// Intersect the pixel ray with the horizontal plane y=planeY.
export function unproject(view,w,h,sx,sy,planeY) {
  const nx=(sx/w*2-1)*TAN_HALF*view.aspect,ny=(1-sy/h*2)*TAN_HALF;
  const d=[0,1,2].map(i=>view.look[i]+view.right[i]*nx+view.up[i]*ny);
  if(Math.abs(d[1])<1e-6)return;
  const t=(planeY-view.eye[1])/d[1];
  return t>0?[view.eye[0]+d[0]*t,planeY,view.eye[2]+d[2]*t]:undefined;
}

export class TrackDraft {
  constructor(track) { this.load(track); }
  load(t) {
    this.id=t.id;this.name=t.name||t.id;this.vehicle=t.vehicle||'podracer';this.mode=t.mode||'lap';this.laps=t.laps||1;
    this.start={pos:[...t.start.pos],yaw:t.start.yaw};
    this.gates=(t.gates||[]).map(g=>({pos:[...g.pos],yaw:g.yaw,width:g.width}));
    this.history=[];this.revision=(this.revision||0)+1;
  }
  static blank(pos,yaw=0) { return new TrackDraft({id:'new-track',name:'New track',mode:'lap',laps:1,start:{pos,yaw},gates:[]}); }
  state() { return JSON.stringify({id:this.id,name:this.name,vehicle:this.vehicle,mode:this.mode,laps:this.laps,start:this.start,gates:this.gates}); }
  // Call before every mutation so undo can restore it.
  checkpoint() { this.history.push(this.state());if(this.history.length>100)this.history.shift();this.revision++; }
  undo() {
    const s=this.history.pop();if(!s)return false;
    const h=this.history;this.load(JSON.parse(s));this.history=h;this.revision++;return true;
  }
  addGate(pos,yaw) {
    this.checkpoint();
    const prev=this.gates.at(-1)?.pos||this.start.pos;
    this.gates.push({pos:[pos[0],pos[1],pos[2]],yaw:yaw??yawToward(prev,pos),width:DEFAULT_WIDTH});
    return this.gates.length-1;
  }
  moveGate(i,pos) { this.gates[i].pos=[pos[0],this.gates[i].pos[1],pos[2]];this.revision++; }
  setGateYaw(i,yaw) { this.gates[i].yaw=yaw;this.revision++; }
  setWidth(i,width) { this.gates[i].width=Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,Math.round(width)));this.revision++; }
  deleteGate(i) { if(i<0||i>=this.gates.length)return false;this.checkpoint();this.gates.splice(i,1);return true; }
  setStart(pos,yaw) { this.checkpoint();this.start={pos:[pos[0],this.start.pos[1],pos[2]],yaw:yaw??this.start.yaw};this.revision++; }
  setMeta({name,mode,laps,vehicle}) {
    if(vehicle)this.vehicle=vehicle;
    if(name!==undefined){this.name=name;}
    if(mode)this.mode=mode;
    if(laps!==undefined)this.laps=Math.max(1,Math.floor(laps)||1);
    if(this.mode==='p2p')this.laps=1;
    this.revision++;
  }
  // Validated track record (throws on invalid), id taken from the name unless already a slug.
  toTrack() {
    const id=slug(this.id==='new-track'?this.name:this.id)||'track';
    const {mode,laps}=this,t={id,name:this.name,vehicle:this.vehicle,mode,laps:mode==='p2p'?1:laps,start:this.start,gates:this.gates};
    return validateTrack(JSON.parse(JSON.stringify(t)));
  }
  get trackId() { return slug(this.id==='new-track'?this.name:this.id)||'track'; }
  // Unvalidated view of the draft for live rendering.
  preview() { return {id:this.trackId,name:this.name,vehicle:this.vehicle,start:this.start,gates:this.gates}; }
  breakoff() { try{return breakoffDistance(this.toTrack());}catch{return undefined;} }
}
