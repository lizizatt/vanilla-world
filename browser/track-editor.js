// In-game race track editor: the live world rendered top-down is the backdrop, a transparent canvas draws the gizmos.
import {createDialIn} from './dial-in-ui.js';
import {TrackDraft,project,unproject,yawToward,gateY,surfaceBase,CLEAR_MIN,CLEAR_DEFAULT,CLEAR_MAX} from './track-edit.js';
import {transitions,checkTrack,bodyLabel} from './track-legs.js';
import {spansBodies} from './race.js';

const $=id=>document.getElementById(id);
const TOOLS={KeyG:'add',KeyV:'select',KeyS:'start'};
const NEAREST_RANGE=5000,ALT_MIN=60,ALT_MAX=3000;
const fwd=g=>[-Math.sin(g.yaw),-Math.cos(g.yaw)],side=g=>[Math.cos(g.yaw),-Math.sin(g.yaw)];
const clone=o=>JSON.parse(JSON.stringify(o));
const otherBody=b=>b==='elune'?'azeroth':'elune';

// jump(target) swaps the world to another body (the existing body swap) and resolves to the new camera position [x,y,z].
export function createTrackEditor({view,tracks,body=()=>'azeroth',save,remove:removeTrack,shipped=()=>[],probe=async()=>[],test,closed,jump=async()=>{throw new Error('Body swap unavailable.');}}) {
  const root=$('track-editor'),cv=$('te-canvas'),g2=cv.getContext('2d');
  const ed={isOpen:false,draft:undefined,selected:-1,tool:'select'};
  let cam,drag,drawn=-1,sel=-2,savedState,jumping=false;

  const status=(text,bad)=>{const s=$('te-status');s.textContent=text;s.dataset.bad=String(!!bad);};
  // Gates are in their own body's frame: only those on the body we are standing on can be drawn, picked or probed.
  const mine=i=>ed.draft.bodyAt(i)===body();
  const planeY=()=>{const d=ed.draft,i=d.gates.findIndex((_,k)=>mine(k));return i>=0?d.gates[i].pos[1]:d.startBody===body()?d.start.pos[1]:(ed.from?.[1]??0);};
  const toWorld=(x,y)=>view()&&unproject(view(),cv.width,cv.height,x,y,planeY());
  const toScreen=p=>view()&&project(view(),cv.width,cv.height,p);
  ed.pose=()=>ed.dial.active?ed.dial.pose():[cam.x,planeY()+cam.alt,cam.z,0,-1.5];

  function frameCamera() {
    const d=ed.draft,pts=[...(d.startBody===body()?[d.start.pos]:[]),...d.gates.filter((_,i)=>mine(i)).map(gt=>gt.pos)];
    if(!pts.length&&ed.from)pts.push(ed.from);
    if(!pts.length)pts.push([0,0,0]);
    const xs=pts.map(p=>p[0]),zs=pts.map(p=>p[2]);
    const span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs),150)*1.5;
    cam={x:(Math.min(...xs)+Math.max(...xs))/2,z:(Math.min(...zs)+Math.max(...zs))/2,alt:Math.max(ALT_MIN,Math.min(ALT_MAX,span/1.1))};
  }
  function load(draft) {
    ed.draft=draft;ed.selected=-1;savedState=draft.state();drawn=-1;sel=-2;
    frameCamera();
  }
  const dirty=()=>!!ed.draft&&ed.draft.state()!==savedState;
  function fill() {
    const select=$('te-track');
    select.replaceChildren(...tracks().map(t=>new Option(t.name||t.id,t.id)),new Option('+ New track here',''));
    select.value=ed.draft.id==='new-track'?'':ed.draft.id;
    const saved=tracks().some(t=>t.id===ed.draft.id);
    $('te-remove').hidden=!saved;$('te-remove').textContent=shipped().includes(ed.draft.id)?'Revert to shipped':'Delete track';
  }
  async function sample(pos) {
    const [s]=await probe([[pos[0],pos[2]]]).catch(()=>[]);
    return s&&{ground:s[1],water:s[2]};
  }
  async function snapGate(i,lift) {
    const d=ed.draft,gate=d.gates[i],s=gate&&await sample(gate.pos);
    if(d!==ed.draft||d.gates[i]!==gate||!Number.isFinite(surfaceBase(s)))return;
    d.setGateHeight(i,surfaceBase(s)+Math.max(CLEAR_MIN,Math.min(CLEAR_MAX,lift)));
  }
  async function showHeight() {
    const d=ed.draft,i=ed.selected,gate=d.gates[i],s=gate&&await sample(gate.pos);
    if(d!==ed.draft||i!==ed.selected||!Number.isFinite(surfaceBase(s)))return;
    $('te-height').value=Math.round(gate.pos[1]-surfaceBase(s));
  }
  async function choose(id) {
    if(dirty()&&!confirm('Discard unsaved changes to this track?')){fill();return;}
    const found=tracks().find(t=>t.id===id);
    if(found&&(found.body??'azeroth')!==body()){
      if(!await gotoBody(found.body??'azeroth'))return void fill();
    }
    if(found)load(new TrackDraft(clone(found)));
    else load(TrackDraft.blank(ed.from.slice(),0,body()));
    fill();status(found?`Loaded "${found.name||id}".`:'New track.');
  }
  // Swap to another body mid-edit (a dial-in in progress is applied first); the draft keeps every gate it already has.
  async function gotoBody(target) {
    if(target===body())return true;
    if(jumping)return false;
    jumping=true;
    const wasDial=ed.dial.active;
    try{
      if(wasDial)ed.dial.done();
      if(ed.dial.active)return false;
      status(`Jumping to ${bodyLabel(target)}…`);
      ed.from=await jump(target);ed.selected=-1;
      if(ed.draft)frameCamera();
      if(ed.draft)refresh(true);
      const first=ed.draft?.gates.findIndex((_,i)=>mine(i));
      status(`On ${bodyLabel(target)}: gates you place now are on ${bodyLabel(target)}.`);
      if(wasDial&&first>=0)ed.dial.open(ed.draft,first);
      return true;
    }catch(error){status(`Jump failed: ${error.message}`,true);return false;}
    finally{jumping=false;}
  }
  ed.jumpTo=gotoBody;
  ed.open=from=>{
    ed.from=from;
    const list=tracks().filter(t=>(t.body??'azeroth')===body()),near=list.map(t=>[Math.hypot(t.start.pos[0]-from[0],t.start.pos[2]-from[2]),t]).sort((a,b)=>a[0]-b[0])[0];
    const keep=dirty();
    if(!keep){if(near&&near[0]<NEAREST_RANGE)load(new TrackDraft(clone(near[1])));else load(TrackDraft.blank(from.slice(),0,body()));}
    fill();
    ed.isOpen=true;root.hidden=false;ed.tool='select';cv.focus();status(keep?'Restored your unsaved edits.':'Editing. G add Â· V select Â· S start Â· Del delete Â· Ctrl+Z undo Â· Wheel zoom Â· right-drag pan');
    refresh(true);
  };
  ed.close=()=>{if(!ed.isOpen)return;if(ed.dial.active)ed.dial.cancel();ed.isOpen=false;root.hidden=true;drag=undefined;closed();};

  function hit(x,y) {
    const s=ed.selected>=0&&ed.draft.gates[ed.selected];
    if(s){const h=handle(s);if(h&&Math.hypot(h[0]-x,h[1]-y)<12)return {kind:'handle',i:ed.selected};}
    let best,dist=16;
    ed.draft.gates.forEach((gate,i)=>{if(!mine(i))return;const p=toScreen(gate.pos);if(!p)return;const d=Math.hypot(p[0]-x,p[1]-y);if(d<dist){dist=d;best={kind:'gate',i};}});
    return best;
  }
  function handle(gate) {
    const f=fwd(gate);return toScreen([gate.pos[0]+f[0]*45,gate.pos[1],gate.pos[2]+f[1]*45]);
  }
  cv.addEventListener('contextmenu',e=>e.preventDefault());
  cv.addEventListener('pointerdown',e=>{
    if(!ed.isOpen||ed.dial.active)return;
    cv.focus();cv.setPointerCapture(e.pointerId);
    const x=e.offsetX,y=e.offsetY;
    if(e.button!==0){drag={kind:'pan'};return;}
    const world=toWorld(x,y),d=ed.draft;
    if(ed.tool==='launch'&&world){
      const kind=$('te-launch-kind').value,yaw=Number($('te-launch-yaw').value)*Math.PI/180;
      void ed.launch.place(world,yaw,kind==='powerup'?'powerup':'ramp',Number(kind)).then(()=>status('Launch object saved locally.')).catch(error=>status(error.message,true));
      return;
    }
    if(ed.tool==='add'&&world){ed.addGateAt(world);drag={kind:'gate',i:ed.selected,lift:CLEAR_DEFAULT};return;}
    if(ed.tool==='start'&&world){
      if(d.startBody!==body()){status(`The start is on ${bodyLabel(d.startBody)}: jump there to move it.`,true);return;}
      d.setStart(world);drag={kind:'start'};return;
    }
    const h=hit(x,y);
    if(!h){ed.selected=-1;drag={kind:'pan'};return;}
    ed.selected=h.i;
    d.checkpoint();drag={...h,lift:+$('te-height').value||CLEAR_DEFAULT};
  });
  cv.addEventListener('pointermove',e=>{
    if(!drag||!ed.isOpen||ed.dial.active)return;
    const d=ed.draft;
    if(drag.kind==='pan'){const k=cam.alt*2*0.55/cv.height;cam.x-=e.movementX*k;cam.z-=e.movementY*k;return;}
    const world=toWorld(e.offsetX,e.offsetY);if(!world)return;
    if(drag.kind==='gate')d.moveGate(drag.i,world);
    else if(drag.kind==='handle')d.setGateYaw(drag.i,yawToward(d.gates[drag.i].pos,world));
    else if(drag.kind==='start'){d.start.yaw=yawToward(d.start.pos,world);d.revision++;}
  });
  const end=()=>{const d=drag;drag=undefined;if(d?.kind==='gate')void snapGate(d.i,d.lift);};
  cv.addEventListener('pointerup',end);cv.addEventListener('pointercancel',end);
  cv.addEventListener('wheel',e=>{
    if(ed.dial.active)return;
    e.preventDefault();
    const d=ed.draft,gate=d.gates[ed.selected];
    if(e.shiftKey&&gate){d.setWidth(ed.selected,gate.width-Math.sign(e.deltaY)*5);return;}
    cam.alt=Math.max(ALT_MIN,Math.min(ALT_MAX,cam.alt*Math.exp(Math.sign(e.deltaY)*.12)));
  },{passive:false});

  function undo() {if(ed.draft.undo()){ed.selected=Math.min(ed.selected,ed.draft.gates.length-1);status('Undone.');}}
  function remove() {if(ed.selected>=0){ed.draft.deleteGate(ed.selected);ed.selected=-1;}}
  // Records a gate on the body we are standing on (also the programmatic authoring path) and drops it onto the terrain.
  ed.addGateAt=pos=>{
    const d=ed.draft,i=d.addGate(pos,undefined,body());
    ed.selected=i;
    return snapGate(i,CLEAR_DEFAULT).then(()=>i);
  };
  document.addEventListener('keydown',e=>{
    if(!ed.isOpen||ed.dial.active||e.defaultPrevented||e.altKey||e.metaKey)return;
    const typing=/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if(e.code==='Escape'||(e.code==='KeyT'&&!typing)){e.preventDefault();ed.close();return;}
    if(typing)return;
    if(e.ctrlKey&&e.code==='KeyZ'){e.preventDefault();undo();return;}
    if(e.ctrlKey)return;
    if(e.code==='KeyD'){e.preventDefault();openDial();return;}
    if(TOOLS[e.code]){setTool(TOOLS[e.code]);e.preventDefault();}
    else if(e.code==='Delete'||e.code==='Backspace'){e.preventDefault();remove();}
  });
  function setTool(t) {ed.tool=t;for(const b of root.querySelectorAll('[data-tool]'))b.setAttribute('aria-pressed',String(b.dataset.tool===t));}
  for(const b of root.querySelectorAll('[data-tool]'))b.addEventListener('click',()=>{setTool(b.dataset.tool);cv.focus();});
  $('te-delete').addEventListener('click',()=>{remove();cv.focus();});
  $('te-undo').addEventListener('click',()=>{undo();cv.focus();});
  $('te-close').addEventListener('click',ed.close);
  $('te-dial-open').addEventListener('click',openDial);
  $('te-launch-add').addEventListener('click',()=>{setTool('launch');status('Click the map to place the selected launch object.');cv.focus();});
  $('te-launch-turn').addEventListener('click',()=>void ed.launch.rotate($('te-launch-list').value,Number($('te-launch-yaw').value)*Math.PI/180).catch(error=>status(error.message,true)));
  $('te-launch-remove').addEventListener('click',()=>void ed.launch.remove($('te-launch-list').value).catch(error=>status(error.message,true)));
  $('te-track').addEventListener('change',e=>choose(e.target.value));

  const meta=()=>ed.draft.setMeta({name:$('te-name').value,mode:$('te-mode').value,vehicle:$('te-vehicle').value,laps:+$('te-laps').value||1});
  for(const id of ['te-name','te-mode','te-laps','te-vehicle'])$(id).addEventListener('change',()=>{ed.draft.checkpoint();meta();});
  $('te-name').addEventListener('input',meta);
  $('te-height').addEventListener('change',async()=>{
    const d=ed.draft,i=ed.selected,gate=d.gates[i];if(!gate)return;
    const s=await sample(gate.pos);if(d!==ed.draft||!Number.isFinite(surfaceBase(s)))return;
    d.checkpoint();d.setGateHeight(i,gateY(surfaceBase(s)+(+$('te-height').value||CLEAR_DEFAULT),s));
  });
  $('te-width').addEventListener('change',()=>{if(ed.selected<0)return;ed.draft.checkpoint();ed.draft.setWidth(ed.selected,+$('te-width').value);});
  $('te-heading').addEventListener('change',()=>{if(ed.selected<0)return;ed.draft.checkpoint();ed.draft.setGateYaw(ed.selected,(+$('te-heading').value||0)*Math.PI/180);});

  // Validates the track (structure, then terrain on the body we are standing on). Errors block; warnings are returned for display.
  async function valid() {
    try{
      const d=ed.draft;d.assignId(tracks().map(t=>t.id));const t=d.toTrack();
      const here=[d.start.pos,...d.gates.map(gt=>gt.pos)].map((p,k)=>({p,k,on:(k?d.bodyAt(k-1):d.startBody)===body()})).filter(x=>x.on);
      const samples=await probe(here.map(x=>[x.p[0],x.p[2]])).catch(()=>[]),surfaces=[];
      here.forEach((x,n)=>{const s=samples[n];if(s)surfaces[x.k]={ground:s[1],water:s[2]};});
      const {errors,warnings}=checkTrack(t,surfaces);
      const sb=surfaceBase(surfaces[0]);
      if(Number.isFinite(sb)&&d.start.pos[1]<sb){d.checkpoint();d.start.pos[1]=sb;t.start.pos[1]=sb;warnings.push('The start was below the ground and has been raised to the surface.');}
      if(spansBodies(t))warnings.push(`Terrain was checked on ${bodyLabel(body())} only; gates on the other body are checked when you save from there.`);
      if(errors.length){status(errors.join(' '),true);return;}
      return {track:t,warnings};
    }catch(error){status(error.message,true);}
  }
  ed.validate=valid;
  const note=(msg,warnings)=>status(warnings.length?`${msg} Warning: ${warnings.join(' ')}`:msg);
  $('te-test').addEventListener('click',async()=>{const v=await valid();if(!v)return;ed.close();test(v.track);});
  $('te-jump').addEventListener('click',()=>{void gotoBody(otherBody(body()));cv.focus();});
  const reorder=d=>{const j=ed.draft.moveInOrder(ed.selected,d);if(j>=0)ed.selected=j;cv.focus();};
  $('te-up').addEventListener('click',()=>reorder(-1));$('te-down').addEventListener('click',()=>reorder(1));
  $('te-remove').addEventListener('click',async()=>{
    const id=ed.draft.id,revert=shipped().includes(id);
    if(!confirm(revert?`Revert "${ed.draft.name}" to the shipped version?`:`Delete "${ed.draft.name}" from this browser?`))return;
    try{await removeTrack(id);}catch(error){status(`Failed: ${error.message}`,true);return;}
    const left=tracks().find(t=>t.id===id);
    if(left)load(new TrackDraft(clone(left)));else load(TrackDraft.blank(ed.from.slice(),0,body()));
    fill();status(revert?'Reverted.':'Deleted.');
  });
  $('te-save').addEventListener('click',async()=>{
    const v=await valid();if(!v)return;
    try{await save(v.track);savedState=ed.draft.state();fill();note(`Saved "${v.track.name}" locally (${v.track.gates.length} gates).`,v.warnings);}
    catch(error){status(`Save failed: ${error.message}`,true);}
  });
  $('te-export').addEventListener('click',async()=>{
    const v=await valid();if(!v)return;const t=v.track;
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(t,null,2)+'\n'],{type:'application/json'}));
    a.download=`${t.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    note(`Exported ${t.id}.json`,v.warnings);
  });

  function refresh(force) {
    const d=ed.draft;
    if(!force&&drawn===d.revision&&sel===ed.selected)return;
    drawn=d.revision;sel=ed.selected;
    const active=document.activeElement;
    if(active!==$('te-name'))$('te-name').value=d.name;
    $('te-mode').value=d.mode;$('te-vehicle').value=d.vehicle;$('te-laps').value=d.laps;$('te-laps').disabled=d.mode==='p2p';
    const b=d.breakoff();$('te-breakoff').textContent=Number.isFinite(b)&&b?`${Math.round(b)} yd (auto)`:'n/a';
    $('te-body').textContent=`Placing gates on ${bodyLabel(body())}`;$('te-jump').textContent=`Jump to ${bodyLabel(otherBody(body()))}`;
    const gate=d.gates[ed.selected];
    $('te-gate-box').hidden=!gate;
    if(gate){if(!drag)void showHeight();$('te-width').value=gate.width;$('te-heading').value=Math.round(((gate.yaw*180/Math.PI)%360+360)%360);$('te-up').disabled=ed.selected<1;$('te-down').disabled=ed.selected>=d.gates.length-1;}
    const jumpAt=new Map(transitions(d.preview()).map(x=>[x.at,x]));
    const rows=[];
    d.gates.forEach((gt,i)=>{
      const x=jumpAt.get(i);
      if(x){const sep=document.createElement('li');sep.className='te-jump';sep.textContent=`jump ${bodyLabel(x.from)} → ${bodyLabel(x.to)}`;rows.push(sep);}
      const li=document.createElement('li'),btn=document.createElement('button');
      btn.type='button';btn.textContent=`Gate ${i+1} · ${bodyLabel(d.bodyAt(i))} · width ${gt.width}`;btn.setAttribute('aria-pressed',String(i===ed.selected));
      btn.addEventListener('click',async()=>{
        if(d.bodyAt(i)!==body()&&!await gotoBody(d.bodyAt(i)))return;
        ed.selected=i;cam.x=gt.pos[0];cam.z=gt.pos[2];
      });
      li.append(btn);rows.push(li);
    });
    $('te-list').replaceChildren(...rows);
    $('te-dirty').hidden=d.state()===savedState;
  }

  ed.frame=()=>{
    if(!ed.isOpen)return;
    if(ed.dial.active){ed.dial.frame(g2);return;}
    const w=Math.max(1,innerWidth),h=Math.max(1,innerHeight);
    if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
    refresh();
    g2.clearRect(0,0,w,h);
    const objects=ed.launch?.list()||[],objectKey=JSON.stringify(objects);
    if($('te-launch-list').dataset.key!==objectKey){
      const selected=$('te-launch-list').value;
      $('te-launch-list').replaceChildren(...objects.map(o=>new Option(o.kind==='ramp'?`${o.angle} degree ramp (${o.pos[0].toFixed(0)}, ${o.pos[2].toFixed(0)})`:'Powered boost pickup',o.id)));
      if(objects.some(o=>o.id===selected))$('te-launch-list').value=selected;
      $('te-launch-list').dataset.key=objectKey;
    }
    for(const o of objects){
      const p=toScreen(o.pos);if(!p)continue;
      g2.fillStyle=o.kind==='ramp'?'#65d8ff':'#8cffb0';g2.beginPath();g2.arc(p[0],p[1],8,0,Math.PI*2);g2.fill();
      g2.font='12px sans-serif';g2.fillText(o.kind==='ramp'?`${o.angle}Â°`:'+15s',p[0]+12,p[1]);
    }
    const d=ed.draft,here=body(),pts=d.gates.map(gt=>toScreen(gt.pos));
    g2.lineWidth=2;g2.setLineDash([8,6]);g2.strokeStyle='rgba(255,214,102,.9)';g2.beginPath();
    // Route segments are drawn only between two points on this body: across a jump the frames differ and a line would be meaningless.
    const route=[{p:d.start.pos,b:d.startBody},...d.gates.map((gt,i)=>({p:gt.pos,b:d.bodyAt(i)})),...(d.mode==='lap'&&d.gates.length?[{p:d.start.pos,b:d.startBody}]:[])];
    route.forEach((q,i)=>{
      if(!i||q.b!==here||route[i-1].b!==here)return;
      const a=toScreen(route[i-1].p),b=toScreen(q.p);if(!a||!b)return;
      g2.moveTo(a[0],a[1]);g2.lineTo(b[0],b[1]);
    });
    g2.stroke();g2.setLineDash([]);
    d.gates.forEach((gt,i)=>{
      const c=pts[i];if(!c||!mine(i))return;
      const s=side(gt),a=toScreen([gt.pos[0]-s[0]*gt.width/2,gt.pos[1],gt.pos[2]-s[1]*gt.width/2]),b=toScreen([gt.pos[0]+s[0]*gt.width/2,gt.pos[1],gt.pos[2]+s[1]*gt.width/2]);
      const on=i===ed.selected;
      g2.strokeStyle=on?'#ffb000':'#ff4d4d';g2.lineWidth=on?6:4;
      if(a&&b){g2.beginPath();g2.moveTo(a[0],a[1]);g2.lineTo(b[0],b[1]);g2.stroke();}
      g2.fillStyle=on?'#ffb000':'#fff';g2.beginPath();g2.arc(c[0],c[1],on?8:6,0,7);g2.fill();
      g2.fillStyle='#000';g2.font='bold 11px sans-serif';g2.textAlign='center';g2.textBaseline='middle';g2.fillText(String(i+1),c[0],c[1]+.5);
      if(on){const hd=handle(gt);if(hd){g2.strokeStyle='#4da3ff';g2.lineWidth=2;g2.beginPath();g2.moveTo(c[0],c[1]);g2.lineTo(hd[0],hd[1]);g2.stroke();g2.fillStyle='#4da3ff';g2.beginPath();g2.arc(hd[0],hd[1],7,0,7);g2.fill();}}
    });
    const s=d.startBody===here&&toScreen(d.start.pos);
    if(s){
      const f=fwd({yaw:d.start.yaw}),tip=toScreen([d.start.pos[0]+f[0]*40,d.start.pos[1],d.start.pos[2]+f[1]*40]);
      g2.fillStyle='#3ddc84';g2.beginPath();g2.arc(s[0],s[1],9,0,7);g2.fill();
      if(tip){g2.strokeStyle='#3ddc84';g2.lineWidth=3;g2.beginPath();g2.moveTo(s[0],s[1]);g2.lineTo(tip[0],tip[1]);g2.stroke();}
      g2.fillStyle='#fff';g2.font='bold 12px sans-serif';g2.textAlign='left';g2.fillText('START',s[0]+12,s[1]-10);
    }
  };
  function openDial() {ed.dial.open(ed.draft,Math.max(0,ed.selected));}
  ed.dial=createDialIn({cv,view,probe,status,body,goto:t=>gotoBody(t),select:i=>{ed.selected=i;},exited:msg=>{const g=ed.draft.gates[ed.selected];if(g&&mine(ed.selected)){cam.x=g.pos[0];cam.z=g.pos[2];}cv.focus();refresh(true);status(msg);}});
  setTool('select');
  return ed;
}
