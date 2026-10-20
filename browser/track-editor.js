// In-game race track editor: the live world rendered top-down is the backdrop, a transparent canvas draws the gizmos.
import {TrackDraft,project,unproject,yawToward} from './track-edit.js';

const $=id=>document.getElementById(id);
const TOOLS={KeyG:'add',KeyV:'select',KeyS:'start'};
const NEAREST_RANGE=5000,ALT_MIN=60,ALT_MAX=3000;
const fwd=g=>[-Math.sin(g.yaw),-Math.cos(g.yaw)],side=g=>[Math.cos(g.yaw),-Math.sin(g.yaw)];
const clone=o=>JSON.parse(JSON.stringify(o));

export function createTrackEditor({view,tracks,save,test,closed}) {
  const root=$('track-editor'),cv=$('te-canvas'),g2=cv.getContext('2d');
  const ed={isOpen:false,draft:undefined,selected:-1,tool:'select'};
  let cam,drag,drawn=-1,sel=-2,savedState;

  const status=(text,bad)=>{const s=$('te-status');s.textContent=text;s.dataset.bad=String(!!bad);};
  const planeY=()=>ed.draft.start.pos[1];
  const toWorld=(x,y)=>view()&&unproject(view(),cv.width,cv.height,x,y,planeY());
  const toScreen=p=>view()&&project(view(),cv.width,cv.height,p);
  ed.pose=()=>[cam.x,planeY()+cam.alt,cam.z,0,-1.5];

  function load(draft) {
    ed.draft=draft;ed.selected=-1;savedState=draft.state();drawn=-1;sel=-2;
    const pts=[draft.start.pos,...draft.gates.map(gt=>gt.pos)],xs=pts.map(p=>p[0]),zs=pts.map(p=>p[2]);
    const span=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs),150)*1.5;
    cam={x:(Math.min(...xs)+Math.max(...xs))/2,z:(Math.min(...zs)+Math.max(...zs))/2,alt:Math.max(ALT_MIN,Math.min(ALT_MAX,span/1.1))};
  }
  function choose(id) {
    const found=tracks().find(t=>t.id===id);
    if(found)load(new TrackDraft(clone(found)));
    else load(TrackDraft.blank(ed.from.slice(),0));
    $('te-track').value=found?id:'';
  }
  ed.open=from=>{
    ed.from=from;cam=undefined;
    const list=tracks(),near=list.map(t=>[Math.hypot(t.start.pos[0]-from[0],t.start.pos[2]-from[2]),t]).sort((a,b)=>a[0]-b[0])[0];
    const select=$('te-track');
    select.replaceChildren(...list.map(t=>new Option(t.name||t.id,t.id)),new Option('+ New track here',''));
    if(near&&near[0]<NEAREST_RANGE)load(new TrackDraft(clone(near[1])));else load(TrackDraft.blank(from.slice(),0));
    select.value=ed.draft.id==='new-track'?'':ed.draft.id;
    ed.isOpen=true;root.hidden=false;ed.tool='select';cv.focus();status('Editing. G add · V select · S start · Del delete · Ctrl+Z undo · Wheel zoom · right-drag pan');
    refresh(true);
  };
  ed.close=()=>{if(!ed.isOpen)return;ed.isOpen=false;root.hidden=true;drag=undefined;closed();};

  function hit(x,y) {
    const s=ed.selected>=0&&ed.draft.gates[ed.selected];
    if(s){const h=handle(s);if(h&&Math.hypot(h[0]-x,h[1]-y)<12)return {kind:'handle',i:ed.selected};}
    let best,dist=16;
    ed.draft.gates.forEach((gate,i)=>{const p=toScreen(gate.pos);if(!p)return;const d=Math.hypot(p[0]-x,p[1]-y);if(d<dist){dist=d;best={kind:'gate',i};}});
    return best;
  }
  function handle(gate) {
    const f=fwd(gate);return toScreen([gate.pos[0]+f[0]*45,gate.pos[1],gate.pos[2]+f[1]*45]);
  }
  cv.addEventListener('contextmenu',e=>e.preventDefault());
  cv.addEventListener('pointerdown',e=>{
    if(!ed.isOpen)return;
    cv.focus();cv.setPointerCapture(e.pointerId);
    const x=e.offsetX,y=e.offsetY;
    if(e.button!==0){drag={kind:'pan'};return;}
    const world=toWorld(x,y),d=ed.draft;
    if(ed.tool==='add'&&world){d.addGate(world);ed.selected=d.gates.length-1;drag={kind:'gate',i:ed.selected,moved:true};return;}
    if(ed.tool==='start'&&world){d.setStart(world);drag={kind:'start'};return;}
    const h=hit(x,y);
    if(!h){ed.selected=-1;drag={kind:'pan'};return;}
    ed.selected=h.i;
    d.checkpoint();drag=h;
  });
  cv.addEventListener('pointermove',e=>{
    if(!drag||!ed.isOpen)return;
    const d=ed.draft;
    if(drag.kind==='pan'){const k=cam.alt*2*0.55/cv.height;cam.x-=e.movementX*k;cam.z-=e.movementY*k;return;}
    const world=toWorld(e.offsetX,e.offsetY);if(!world)return;
    if(drag.kind==='gate')d.moveGate(drag.i,world);
    else if(drag.kind==='handle')d.setGateYaw(drag.i,yawToward(d.gates[drag.i].pos,world));
    else if(drag.kind==='start'){d.start.yaw=yawToward(d.start.pos,world);d.revision++;}
  });
  const end=()=>{drag=undefined;};
  cv.addEventListener('pointerup',end);cv.addEventListener('pointercancel',end);
  cv.addEventListener('wheel',e=>{
    e.preventDefault();
    const d=ed.draft,gate=d.gates[ed.selected];
    if(e.shiftKey&&gate){d.setWidth(ed.selected,gate.width-Math.sign(e.deltaY)*5);return;}
    cam.alt=Math.max(ALT_MIN,Math.min(ALT_MAX,cam.alt*Math.exp(Math.sign(e.deltaY)*.12)));
  },{passive:false});

  function undo() {if(ed.draft.undo()){ed.selected=Math.min(ed.selected,ed.draft.gates.length-1);status('Undone.');}}
  function remove() {if(ed.selected>=0){ed.draft.deleteGate(ed.selected);ed.selected=-1;}}
  document.addEventListener('keydown',e=>{
    if(!ed.isOpen||e.defaultPrevented||e.altKey||e.metaKey)return;
    const typing=/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if(e.code==='Escape'||(e.code==='KeyT'&&!typing)){e.preventDefault();ed.close();return;}
    if(typing)return;
    if(e.ctrlKey&&e.code==='KeyZ'){e.preventDefault();undo();return;}
    if(e.ctrlKey)return;
    if(TOOLS[e.code]){setTool(TOOLS[e.code]);e.preventDefault();}
    else if(e.code==='Delete'||e.code==='Backspace'){e.preventDefault();remove();}
  });
  function setTool(t) {ed.tool=t;for(const b of root.querySelectorAll('[data-tool]'))b.setAttribute('aria-pressed',String(b.dataset.tool===t));}
  for(const b of root.querySelectorAll('[data-tool]'))b.addEventListener('click',()=>{setTool(b.dataset.tool);cv.focus();});
  $('te-delete').addEventListener('click',()=>{remove();cv.focus();});
  $('te-undo').addEventListener('click',()=>{undo();cv.focus();});
  $('te-close').addEventListener('click',ed.close);
  $('te-track').addEventListener('change',e=>choose(e.target.value));

  const meta=()=>ed.draft.setMeta({name:$('te-name').value,mode:$('te-mode').value,laps:+$('te-laps').value||1});
  for(const id of ['te-name','te-mode','te-laps'])$(id).addEventListener('change',()=>{ed.draft.checkpoint();meta();});
  $('te-name').addEventListener('input',meta);
  $('te-width').addEventListener('change',()=>{if(ed.selected<0)return;ed.draft.checkpoint();ed.draft.setWidth(ed.selected,+$('te-width').value);});
  $('te-heading').addEventListener('change',()=>{if(ed.selected<0)return;ed.draft.checkpoint();ed.draft.setGateYaw(ed.selected,(+$('te-heading').value||0)*Math.PI/180);});

  const valid=()=>{try{return ed.draft.toTrack();}catch(error){status(error.message,true);}};
  $('te-test').addEventListener('click',()=>{const t=valid();if(!t)return;ed.close();test(t);});
  $('te-save').addEventListener('click',async()=>{
    const t=valid();if(!t)return;
    try{await save(t);savedState=ed.draft.state();status(`Saved "${t.name}" locally (${t.gates.length} gates).`);}
    catch(error){status(`Save failed: ${error.message}`,true);}
  });
  $('te-export').addEventListener('click',()=>{
    const t=valid();if(!t)return;
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(t,null,2)+'\n'],{type:'application/json'}));
    a.download=`${t.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    status(`Exported ${t.id}.json`);
  });

  function refresh(force) {
    const d=ed.draft;
    if(!force&&drawn===d.revision&&sel===ed.selected)return;
    drawn=d.revision;sel=ed.selected;
    const active=document.activeElement;
    if(active!==$('te-name'))$('te-name').value=d.name;
    $('te-mode').value=d.mode;$('te-laps').value=d.laps;$('te-laps').disabled=d.mode==='p2p';
    const b=d.breakoff();$('te-breakoff').textContent=b?`${Math.round(b)} yd (auto)`:'n/a';
    const gate=d.gates[ed.selected];
    $('te-gate-box').hidden=!gate;
    if(gate){$('te-width').value=gate.width;$('te-heading').value=Math.round(((gate.yaw*180/Math.PI)%360+360)%360);}
    $('te-list').replaceChildren(...d.gates.map((gt,i)=>{
      const li=document.createElement('li'),btn=document.createElement('button');
      btn.type='button';btn.textContent=`Gate ${i+1} · width ${gt.width}`;btn.setAttribute('aria-pressed',String(i===ed.selected));
      btn.addEventListener('click',()=>{ed.selected=i;cam.x=gt.pos[0];cam.z=gt.pos[2];});
      li.append(btn);return li;
    }));
    $('te-dirty').hidden=d.state()===savedState;
  }

  ed.frame=()=>{
    if(!ed.isOpen)return;
    const w=Math.max(1,innerWidth),h=Math.max(1,innerHeight);
    if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
    refresh();
    g2.clearRect(0,0,w,h);
    const d=ed.draft,pts=d.gates.map(gt=>toScreen(gt.pos));
    g2.lineWidth=2;g2.setLineDash([8,6]);g2.strokeStyle='rgba(255,214,102,.9)';g2.beginPath();
    const route=[d.start.pos,...d.gates.map(gt=>gt.pos),...(d.mode==='lap'&&d.gates.length?[d.start.pos]:[])].map(toScreen);
    route.forEach((p,i)=>{if(!p)return;if(i===0||!route[i-1])g2.moveTo(p[0],p[1]);else g2.lineTo(p[0],p[1]);});
    g2.stroke();g2.setLineDash([]);
    d.gates.forEach((gt,i)=>{
      const c=pts[i];if(!c)return;
      const s=side(gt),a=toScreen([gt.pos[0]-s[0]*gt.width/2,gt.pos[1],gt.pos[2]-s[1]*gt.width/2]),b=toScreen([gt.pos[0]+s[0]*gt.width/2,gt.pos[1],gt.pos[2]+s[1]*gt.width/2]);
      const on=i===ed.selected;
      g2.strokeStyle=on?'#ffb000':'#ff4d4d';g2.lineWidth=on?6:4;
      if(a&&b){g2.beginPath();g2.moveTo(a[0],a[1]);g2.lineTo(b[0],b[1]);g2.stroke();}
      g2.fillStyle=on?'#ffb000':'#fff';g2.beginPath();g2.arc(c[0],c[1],on?8:6,0,7);g2.fill();
      g2.fillStyle='#000';g2.font='bold 11px sans-serif';g2.textAlign='center';g2.textBaseline='middle';g2.fillText(String(i+1),c[0],c[1]+.5);
      if(on){const hd=handle(gt);if(hd){g2.strokeStyle='#4da3ff';g2.lineWidth=2;g2.beginPath();g2.moveTo(c[0],c[1]);g2.lineTo(hd[0],hd[1]);g2.stroke();g2.fillStyle='#4da3ff';g2.beginPath();g2.arc(hd[0],hd[1],7,0,7);g2.fill();}}
    });
    const s=toScreen(d.start.pos);
    if(s){
      const f=fwd({yaw:d.start.yaw}),tip=toScreen([d.start.pos[0]+f[0]*40,d.start.pos[1],d.start.pos[2]+f[1]*40]);
      g2.fillStyle='#3ddc84';g2.beginPath();g2.arc(s[0],s[1],9,0,7);g2.fill();
      if(tip){g2.strokeStyle='#3ddc84';g2.lineWidth=3;g2.beginPath();g2.moveTo(s[0],s[1]);g2.lineTo(tip[0],tip[1]);g2.stroke();}
      g2.fillStyle='#fff';g2.font='bold 12px sans-serif';g2.textAlign='left';g2.fillText('START',s[0]+12,s[1]-10);
    }
  };
  setTool('select');
  return ed;
}
