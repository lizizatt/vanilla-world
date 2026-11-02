// Pure "Dial in" state: step through a draft's gates, edit one gate with multi-step undo/redo, and an orbit camera around it. No DOM.
import {MIN_WIDTH,MAX_WIDTH} from './track-edit.js';

export const DIST_MIN=25,DIST_MAX=900,DIST_DEFAULT=170,PITCH_MIN=-1.5,PITCH_MAX=-.05,UNDO_LIMIT=200;
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const snapshot=g=>({pos:[...g.pos],yaw:g.yaw,width:g.width});
const same=(a,b)=>a.yaw===b.yaw&&a.width===b.width&&a.pos[0]===b.pos[0]&&a.pos[1]===b.pos[1]&&a.pos[2]===b.pos[2];
const apply=(g,s)=>{g.pos=[...s.pos];g.yaw=s.yaw;g.width=s.width;};

// Camera orbiting `target`; yaw/pitch are the look angles (same convention as the flight pose), so eye = target - dist*look.
export class OrbitCamera {
  constructor() { this.target=[0,0,0];this.goal=[0,0,0];this.yaw=0;this.pitch=-.4;this.dist=DIST_DEFAULT; }
  focus(p,snap) { for(let i=0;i<3;i++){this.goal[i]=p[i];if(snap)this.target[i]=p[i];} }
  orbit(dx,dy) { this.yaw-=dx*.006;this.pitch=clamp(this.pitch-dy*.006,PITCH_MIN,PITCH_MAX); }
  zoom(wheel) { this.dist=clamp(this.dist*Math.exp(Math.sign(wheel)*.12),DIST_MIN,DIST_MAX); }
  // Pan the focus in the view plane (pixels, with the canvas height for scale).
  pan(dx,dy,h) {
    const k=this.dist*2*.55/Math.max(1,h),c=Math.cos(this.yaw),s=Math.sin(this.yaw);
    for(const t of [this.goal,this.target]){t[0]+=-c*dx*k-s*dy*k;t[2]+=s*dx*k-c*dy*k;}
  }
  // Ease the target toward its goal; dt in seconds.
  update(dt) { const a=1-Math.exp(-dt*10);for(let i=0;i<3;i++)this.target[i]+=(this.goal[i]-this.target[i])*a; }
  // Flight pose [x,y,z,yaw,pitch] of the eye.
  pose() {
    const cp=Math.cos(this.pitch),d=this.dist;
    return [this.target[0]+d*Math.sin(this.yaw)*cp,this.target[1]-d*Math.sin(this.pitch),this.target[2]+d*Math.cos(this.yaw)*cp,this.yaw,this.pitch];
  }
}

export class DialSession {
  // draft: a TrackDraft (mutated in place; the caller keeps it dirty and saves through its normal path).
  constructor(draft,index=0) {
    this.draft=draft;this.entry=JSON.stringify(draft.gates);this.originals=draft.gates.map(snapshot);
    this.undoStack=[];this.redoStack=[];this.cam=new OrbitCamera();this.pending=undefined;
    this.index=0;this.select(index,true);
    const g=this.gate;if(g)this.cam.yaw=g.yaw;
  }
  get count() { return this.draft.gates.length; }
  get gate() { return this.draft.gates[this.index]; }
  get label() { return `Gate ${this.index+1} / ${this.count}`; }
  select(i,snap) {
    if(!this.count)return;
    this.end();
    this.index=((i%this.count)+this.count)%this.count;
    this.cam.focus(this.gate.pos,snap);
  }
  step(d) { this.select(this.index+d); }
  prevGate() { return this.draft.gates[(this.index+this.count-1)%this.count]; }
  nextGate() { return this.draft.gates[(this.index+1)%this.count]; }

  // Open one undo entry for the current gesture (a drag or a field edit); end() drops it again if nothing changed.
  begin() {
    if(this.pending)return;
    this.pending={i:this.index,before:snapshot(this.gate)};
    this.undoStack.push(this.pending);this.redoStack.length=0;
    if(this.undoStack.length>UNDO_LIMIT)this.undoStack.shift();
  }
  end() {
    const p=this.pending;this.pending=undefined;
    if(p&&same(p.before,snapshot(this.draft.gates[p.i]))){const k=this.undoStack.lastIndexOf(p);if(k>=0)this.undoStack.splice(k,1);}
  }
  touch() { this.draft.revision++; }
  setPos(x,y,z) {
    const g=this.gate;if(!Number.isFinite(x+y+z))return;
    this.begin();g.pos=[x,y,z];this.touch();
  }
  setHeight(y) { const p=this.gate.pos;this.setPos(p[0],y,p[2]); }
  setWidth(w) {
    if(!Number.isFinite(w))return;
    this.begin();this.gate.width=clamp(Math.round(w),MIN_WIDTH,MAX_WIDTH);this.touch();
  }
  setYaw(yaw) { if(!Number.isFinite(yaw))return;this.begin();this.gate.yaw=yaw;this.touch(); }
  // Revert the selected gate to how it was when dial-in opened.
  resetGate() {
    const o=this.originals[this.index];if(!o||same(o,snapshot(this.gate)))return false;
    this.begin();apply(this.gate,o);this.touch();this.end();return true;
  }
  undo() { return this.swap(this.undoStack,this.redoStack); }
  redo() { return this.swap(this.redoStack,this.undoStack); }
  swap(from,to) {
    this.pending=undefined;
    const e=from.pop();if(!e)return false;
    const g=this.draft.gates[e.i],now=snapshot(g);apply(g,e.before);e.before=now;to.push(e);
    this.index=e.i;this.draft.revision++;this.cam.focus(g.pos,false);return true;
  }
  get dirty() { return JSON.stringify(this.draft.gates)!==this.entry; }
  // Throw every dial-in edit away.
  cancel() {
    this.pending=undefined;
    this.draft.gates.forEach((g,i)=>{if(this.originals[i])apply(g,this.originals[i]);});
    this.draft.revision++;
  }
}
