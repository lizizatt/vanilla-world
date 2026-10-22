// Pure race state machine. Positions are render-space yards [x,y,z]; yaw is radians, forward = (-sin yaw, -cos yaw) like the craft.
// idle -> lineup -> countdown -> running -> finished | cancelled. No DOM, no clocks: callers pass `now` seconds.
export const BREAKOFF_MARGIN=500;
export const COUNTDOWN_SECONDS=3;
// Vehicle classes that can race (free flight has no races); see vehicles.js.
export const RACE_VEHICLES={podracer:1};

const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
const finite=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);

export function validateTrack(t) {
  if(!t||typeof t.id!=='string'||!/^[a-z0-9-]+$/.test(t.id))throw new Error('track id must be a lowercase slug');
  if(!finite(t.start?.pos)||!Number.isFinite(t.start?.yaw))throw new Error('track start needs pos and yaw');
  if(!Array.isArray(t.gates)||t.gates.length<1)throw new Error('track needs at least one gate');
  for(const g of t.gates)if(!finite(g.pos)||!Number.isFinite(g.yaw)||!(g.width>0))throw new Error('gate needs pos, yaw and width>0');
  const mode=t.mode??'p2p',laps=t.laps??1;
  if(mode!=='p2p'&&mode!=='lap')throw new Error('mode must be p2p or lap');
  if(!Number.isInteger(laps)||laps<1||(mode==='p2p'&&laps!==1))throw new Error('laps must be a positive integer (1 for p2p)');
  const vehicle=t.vehicle??'podracer';
  if(!Object.hasOwn(RACE_VEHICLES,vehicle))throw new Error('vehicle must be podracer');
  return {...t,mode,laps,vehicle};
}

// Max distance between any two course points (start included) plus margin, unless the track sets `breakoff`.
export function breakoffDistance(t) {
  if(Number.isFinite(t.breakoff)&&t.breakoff>0)return t.breakoff;
  const pts=[t.start.pos,...t.gates.map(g=>g.pos)];
  let max=0;
  for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++)max=Math.max(max,dist(pts[i],pts[j]));
  return max+BREAKOFF_MARGIN;
}

// Fraction u in [0,1) along a->b where the segment crosses the gate's vertical plane (forward direction only) inside its
// width and within `height` yd vertically, else -1. Swept, so any speed or frame gap works.
export function crossingAt(gate,a,b,height=200) {
  const fx=-Math.sin(gate.yaw),fz=-Math.cos(gate.yaw),rx=Math.cos(gate.yaw),rz=-Math.sin(gate.yaw);
  const side=p=>(p[0]-gate.pos[0])*fx+(p[2]-gate.pos[2])*fz;
  const sa=side(a),sb=side(b);
  if(!(sa<0&&sb>=0))return -1;
  const u=sa/(sa-sb),x=a[0]+(b[0]-a[0])*u,y=a[1]+(b[1]-a[1])*u,z=a[2]+(b[2]-a[2])*u;
  const lateral=(x-gate.pos[0])*rx+(z-gate.pos[2])*rz;
  return Math.abs(lateral)<=gate.width/2&&Math.abs(y-gate.pos[1])<=height?u:-1;
}
export const crossesGate=(gate,a,b,height)=>crossingAt(gate,a,b,height)>=0;
export class Race {
  constructor(track) {
    this.track=validateTrack(track);
    this.breakoff=breakoffDistance(this.track);
    this.state='idle';this.reason=null;
    this.next=0;this.lap=1;this.splits=[];this.time=null;this.last=null;
  }
  get totalGates() { return this.track.gates.length*this.track.laps; }
  get gateIndex() { return this.next%this.track.gates.length; }
  get nextGate() { return this.state==='running'?this.track.gates[this.gateIndex]:null; }
  start(now) {
    this.state='lineup';this.reason=null;this.next=0;this.lap=1;this.splits=[];this.time=null;this.last=null;this.t0=null;this.cd=now;
  }
  // Called once the craft is placed at the start; begins the 3-2-1 countdown.
  lined(now) { if(this.state==='lineup'){this.state='countdown';this.cd=now;} }
  countdown(now) { return this.state==='countdown'?Math.max(0,COUNTDOWN_SECONDS-(now-this.cd)):0; }
  elapsed(now) { return this.state==='running'?now-this.t0:this.time??0; }
  pause(now) { if(this.paused===undefined&&(this.state==='countdown'||this.state==='running'))this.paused=now; }
  resume(now) {
    if(this.paused===undefined)return;
    const d=now-this.paused;this.paused=undefined;
    if(this.state==='countdown')this.cd+=d;else if(this.state==='running')this.t0+=d;
  }
  cancel(reason='cancelled') { if(this.state!=='idle'&&this.state!=='finished'){this.state='cancelled';this.reason=reason;} }
  // True while the gate being approached is the last of the last lap (drawn with the checkered finish banner).
  get finishing() { return this.state==='running'&&this.next===this.totalGates-1; }
  // Call after any teleport/respawn/restore so the jump is not treated as a movement through gates.
  jump() { this.last=null; }
  // Advance with the craft's latest position. Returns 'go', 'gate', 'finish' or null. The crossing test is swept over
  // the segment since the previous call, so one step may pass several gates in order; split times interpolate to the crossing.
  update(pos,now) {
    let event=null;
    if(this.state==='countdown'&&now-this.cd>=COUNTDOWN_SECONDS){this.state='running';this.t0=now;this.last=pos;this.lastT=now;return 'go';}
    if(this.state!=='running'){this.last=pos;this.lastT=now;return null;}
    if(this.last) {
      const a=this.last,t0=this.lastT??now;
      let from=a,done=0;
      while(this.state==='running') {
        const u=crossingAt(this.track.gates[this.gateIndex],from,pos);
        if(u<0)break;
        const total=done+(1-done)*u,at=t0+(now-t0)*total;
        this.splits.push(at-this.t0);this.next++;event='gate';
        if(this.next>=this.totalGates){this.state='finished';this.time=at-this.t0;event='finish';}
        else if(this.gateIndex===0)this.lap++;
        done=Math.min(1,total+1e-6);if(done>=1)break; // step past the plane so the same gate cannot re-trigger
        from=[a[0]+(pos[0]-a[0])*done,a[1]+(pos[1]-a[1])*done,a[2]+(pos[2]-a[2])*done];
      }
    }
    this.last=pos;this.lastT=now;
    if(this.state==='running'&&this.farFromCourse(pos))this.cancel('breakoff');
    return event;
  }  farFromCourse(pos) { return this.track.gates.every(g=>dist(pos,g.pos)>this.breakoff)&&dist(pos,this.track.start.pos)>this.breakoff; }
}

export function formatTime(seconds) {
  const ms=Math.round(Math.max(0,seconds)*1000),m=Math.floor(ms/60000),s=(ms%60000)/1000;
  return `${m}:${s.toFixed(2).padStart(5,'0')}`;
}

// Signed angle from the craft's heading to a target: positive is to the right. Craft forward = (-sin yaw, -cos yaw).
export function bearing(pos,yaw,target) {
  const dx=target[0]-pos[0],dz=target[2]-pos[2];
  return Math.atan2(dx*Math.cos(yaw)-dz*Math.sin(yaw),-dx*Math.sin(yaw)-dz*Math.cos(yaw));
}

export const SCORE_LIMIT=10;
// Per-track local scoreboard: {version:1,runs:[{time,splits,date}]} sorted fastest first. Bad records read as empty.
export function validScores(record) {
  const ok=record?.version===1&&Array.isArray(record.runs)&&record.runs.every(r=>Number.isFinite(r.time)&&r.time>0&&Array.isArray(r.splits)&&r.splits.every(Number.isFinite));
  return ok?record:{version:1,runs:[]};
}
export function addScore(record,run) {
  const runs=[...validScores(record).runs,run].sort((a,b)=>a.time-b.time).slice(0,SCORE_LIMIT);
  return {record:{version:1,runs},rank:runs.indexOf(run)};
}
