// Dial-in view for the track editor: orbit one gate at a time and move it with a translate gizmo. DOM glue over dial-in.js and gizmo.js.
import {DialSession} from './dial-in.js';
import {makeRay,makeDrag,pixelRay,pickHandle,beginDrag,dragTo,worldPerPixel,projectInto,PLANE_LO,PLANE_HI,AXES,AXIS_KEYS,PICK_PX,GIZMO_PX} from './gizmo.js';
import {surfaceBase,CLEAR_MIN,CLEAR_MAX,CLEAR_DEFAULT} from './track-edit.js';

const $=id=>document.getElementById(id);
const COLORS={x:'#ff4d4d',y:'#5cff6b',z:'#4da3ff',xz:'#ffd24d'};
const DEG=Math.PI/180,NO_DASH=[],DASH=[8,6];

export function createDialIn({cv,view,draft,select,probe=async()=>[],status,exited}) {
  const dial={active:false,session:undefined,snap:true};
  const ray=makeRay(),drag=makeDrag(),next=[0,0,0],a=[0,0,0],b=[0,0,0],c=[0,0,0],bp=[0,0,0],bq=[0,0,0];
  let gesture,hover,drawn=-1,drawnIndex=-1,lastNow=0,snapBusy,snapAgain=false,lift=CLEAR_DEFAULT;

  const sample=async pos=>{const [s]=await probe([[pos[0],pos[2]]]).catch(()=>[]);return s&&{ground:s[1],water:s[2]};};
  const len=()=>worldPerPixel(view(),cv.height,dial.session.gate.pos)*GIZMO_PX;
  const rayAt=e=>pixelRay(view(),cv.width,cv.height,e.offsetX,e.offsetY,ray);

  dial.open=(d,index=0)=>{
    if(!d.gates.length){status('Add a gate first.',true);return false;}
    dial.session=new DialSession(d,index);dial.active=true;lastNow=performance.now();drawn=-1;
    $('te-dial').hidden=false;$('track-editor').classList.add('dialing');cv.focus();
    $('te-dial-snap').checked=dial.snap;sync(true);select(dial.session.index);status('Dial in: drag the gizmo arrows. [ ] step · wheel zoom · drag orbit · right-drag pan.');
    return true;
  };
  function leave(msg) {
    dial.active=false;gesture=undefined;hover=undefined;dial.session=undefined;
    $('track-editor').classList.remove('dialing');$('te-dial').hidden=true;exited(msg);
  }
  dial.done=()=>{
    const s=dial.session;if(!s)return;
    try{s.draft.toTrack();}catch(error){status(error.message,true);return;}
    if(s.dirty)s.draft.checkpointGates(JSON.parse(s.entry));
    leave(s.dirty?'Dial-in applied. Save to keep it.':'Dial-in closed.');
  };
  dial.cancel=()=>{const s=dial.session;if(!s)return;s.cancel();leave('Dial-in cancelled.');};
  dial.pose=()=>{
    const s=dial.session,now=performance.now();
    s.cam.update(Math.min(.1,(now-lastNow)/1000));lastNow=now;
    return s.cam.pose();
  };

  // Keep the selected gate on the terrain (preserving its clearance) after a horizontal move; one probe in flight at a time.
  async function snapGround() {
    const s=dial.session;if(!s||!dial.snap)return;
    if(snapBusy){snapAgain=true;return snapBusy;}
    snapBusy=(async()=>{
      do{
        snapAgain=false;
        const i=s.index,surf=await sample(s.gate.pos);
        if(dial.session===s&&s.index===i&&Number.isFinite(surfaceBase(surf)))s.setHeight(surfaceBase(surf)+lift);
      }while(snapAgain&&dial.session===s);
    })();
    try{await snapBusy;}finally{snapBusy=undefined;}
  }
  async function captureLift() {
    const s=dial.session,g=s.gate,surf=await sample(g.pos);
    if(Number.isFinite(surfaceBase(surf)))lift=Math.max(CLEAR_MIN,Math.min(CLEAR_MAX,g.pos[1]-surfaceBase(surf)));
  }

  cv.addEventListener('pointerdown',e=>{
    if(!dial.active)return;
    cv.focus();cv.setPointerCapture(e.pointerId);
    const s=dial.session;
    if(e.button!==0){gesture={kind:'pan'};return;}
    rayAt(e);
    const axis=pickHandle(ray,s.gate.pos,len(),PICK_PX*worldPerPixel(view(),cv.height,s.gate.pos));
    if(axis&&beginDrag(drag,ray,s.gate.pos,axis)){gesture={kind:'axis'};s.begin();if(dial.snap&&axis!=='y')void captureLift();return;}
    gesture={kind:'orbit'};
  });
  cv.addEventListener('pointermove',e=>{
    if(!dial.active)return;
    const s=dial.session;
    if(!gesture){rayAt(e);const h=pickHandle(ray,s.gate.pos,len(),PICK_PX*worldPerPixel(view(),cv.height,s.gate.pos));if(h!==hover){hover=h;cv.style.cursor=h?'grab':'';}return;}
    if(gesture.kind==='orbit')s.cam.orbit(e.movementX,e.movementY);
    else if(gesture.kind==='pan')s.cam.pan(e.movementX,e.movementY,cv.height);
    else if(dragTo(drag,rayAt(e),next)){
      s.setPos(next[0],next[1],next[2]);
      if(dial.snap&&drag.axis!=='y')void snapGround();
    }
  });
  const release=()=>{
    const g=gesture;gesture=undefined;if(!g||!dial.active)return;
    if(g.kind==='axis'){
      const s=dial.session,finish=()=>{s.end();if(dial.session===s)s.cam.focus(s.gate.pos,false);};
      if(dial.snap&&drag.axis!=='y')void snapGround().finally(finish);else finish();
    }
  };
  cv.addEventListener('pointerup',release);cv.addEventListener('pointercancel',release);
  cv.addEventListener('contextmenu',e=>{if(dial.active)e.preventDefault();});
  cv.addEventListener('wheel',e=>{
    if(!dial.active)return;
    e.preventDefault();
    if(e.shiftKey)dial.session.setWidth(dial.session.gate.width-Math.sign(e.deltaY)*5);else dial.session.cam.zoom(e.deltaY);
  },{passive:false});

  const step=d=>{dial.session.step(d);select(dial.session.index);};
  const undo=()=>{if(dial.session.undo()){select(dial.session.index);status('Undone.');}};
  const redo=()=>{if(dial.session.redo()){select(dial.session.index);status('Redone.');}};
  document.addEventListener('keydown',e=>{
    if(!dial.active||e.defaultPrevented||e.altKey||e.metaKey)return;
    const typing=/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if(e.code==='Escape'){e.preventDefault();dial.cancel();return;}
    if(e.ctrlKey&&e.code==='KeyZ'){e.preventDefault();e.shiftKey?redo():undo();return;}
    if(e.ctrlKey&&e.code==='KeyY'){e.preventDefault();redo();return;}
    if(typing||e.ctrlKey)return;
    if(e.code==='BracketLeft'||e.code==='KeyQ'){e.preventDefault();step(-1);}
    else if(e.code==='BracketRight'||e.code==='KeyE'){e.preventDefault();step(1);}
    else if(e.code==='KeyD'||e.code==='Enter'){e.preventDefault();dial.done();}
  });
  $('te-dial-prev').addEventListener('click',()=>{step(-1);cv.focus();});
  $('te-dial-next').addEventListener('click',()=>{step(1);cv.focus();});
  $('te-dial-undo').addEventListener('click',()=>{undo();cv.focus();});
  $('te-dial-redo').addEventListener('click',()=>{redo();cv.focus();});
  $('te-dial-reset').addEventListener('click',()=>{if(dial.session.resetGate())status('Gate reset.');cv.focus();});
  $('te-dial-done').addEventListener('click',()=>dial.done());
  $('te-dial-cancel').addEventListener('click',()=>dial.cancel());
  $('te-dial-snap').addEventListener('change',e=>{dial.snap=e.target.checked;if(dial.snap){void captureLift().then(snapGround);}});
  const xyz=['x','y','z'].map(k=>$('te-dial-'+k));
  const place=()=>{const v=xyz.map(i=>parseFloat(i.value));if(v.every(Number.isFinite)){dial.session.setPos(v[0],v[1],v[2]);dial.session.end();dial.session.cam.focus(dial.session.gate.pos,false);}};
  for(const i of xyz)i.addEventListener('change',place);
  $('te-dial-width').addEventListener('change',e=>{dial.session.setWidth(+e.target.value);dial.session.end();});
  $('te-dial-heading').addEventListener('change',e=>{dial.session.setYaw((+e.target.value||0)*DEG);dial.session.end();});

  function sync(force) {
    const s=dial.session,rev=s.draft.revision;
    if(!force&&rev===drawn&&s.index===drawnIndex)return;
    drawn=rev;drawnIndex=s.index;
    const g=s.gate,focus=document.activeElement;
    $('te-dial-label').textContent=s.label;
    xyz.forEach((i,k)=>{if(i!==focus)i.value=g.pos[k].toFixed(1);});
    if(focus!==$('te-dial-width'))$('te-dial-width').value=g.width;
    if(focus!==$('te-dial-heading'))$('te-dial-heading').value=Math.round(((g.yaw/DEG)%360+360)%360);
    $('te-dial-undo').disabled=!s.undoStack.length;$('te-dial-redo').disabled=!s.redoStack.length;
  }

  function line(g2,p,q,colour,width,dash) {
    if(!projectInto(view(),cv.width,cv.height,p[0],p[1],p[2],a)||!projectInto(view(),cv.width,cv.height,q[0],q[1],q[2],b))return;
    g2.strokeStyle=colour;g2.lineWidth=width;g2.setLineDash(dash);g2.beginPath();g2.moveTo(a[0],a[1]);g2.lineTo(b[0],b[1]);g2.stroke();
  }
  // A gate's span as a bar with its centre post, `ghost` for the neighbours.
  function bar(g2,g,colour,width) {
    const hw=g.width/2,cy=Math.cos(g.yaw)*hw,sy=Math.sin(g.yaw)*hw;
    bp[0]=g.pos[0]-cy;bp[1]=g.pos[1];bp[2]=g.pos[2]+sy;bq[0]=g.pos[0]+cy;bq[1]=g.pos[1];bq[2]=g.pos[2]-sy;
    line(g2,bp,bq,colour,width,NO_DASH);
  }

  function tag(g2,v,w,h,gate,text) {
    if(!projectInto(v,w,h,gate.pos[0],gate.pos[1],gate.pos[2],a))return;
    g2.fillStyle='#fff';g2.font='11px sans-serif';g2.textAlign='center';g2.fillText(text,a[0],a[1]-8);
  }
  function corner(g2,v,w,h,o,dx,dz,first) {
    if(!projectInto(v,w,h,o[0]+dx,o[1],o[2]+dz,a))return;
    if(first)g2.moveTo(a[0],a[1]);else g2.lineTo(a[0],a[1]);
  }

  dial.frame=g2=>{
    const s=dial.session,v=view();if(!s||!v)return;
    const w=Math.max(1,innerWidth),h=Math.max(1,innerHeight);
    if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h;}
    sync(false);
    g2.clearRect(0,0,w,h);
    const g=s.gate,p=s.prevGate(),n=s.nextGate(),L=len();
    if(s.count>1){
      line(g2,p.pos,g.pos,'rgba(255,214,102,.85)',2,DASH);line(g2,g.pos,n.pos,'rgba(255,214,102,.85)',2,DASH);
      bar(g2,p,'rgba(150,200,255,.6)',3);bar(g2,n,'rgba(150,255,170,.6)',3);
      tag(g2,v,w,h,p,'prev');tag(g2,v,w,h,n,'next');
    }
    bar(g2,g,'#ffb000',5);
    const o=g.pos;
    for(const k of AXIS_KEYS){
      const ax=AXES[k];c[0]=o[0]+ax[0]*L;c[1]=o[1]+ax[1]*L;c[2]=o[2]+ax[2]*L;
      const on=hover===k||(gesture?.kind==='axis'&&drag.axis===k);
      line(g2,o,c,COLORS[k],on?6:3,NO_DASH);
      if(projectInto(v,w,h,c[0],c[1],c[2],b)){g2.fillStyle=COLORS[k];g2.beginPath();g2.arc(b[0],b[1],on?8:6,0,7);g2.fill();g2.fillStyle='#000';g2.font='bold 10px sans-serif';g2.textAlign='center';g2.textBaseline='middle';g2.fillText(k.toUpperCase(),b[0],b[1]+.5);}
    }
    const lo=L*PLANE_LO,hi=L*PLANE_HI,on=hover==='xz'||(gesture?.kind==='axis'&&drag.axis==='xz');
    g2.strokeStyle=COLORS.xz;g2.lineWidth=on?4:2;g2.beginPath();
    corner(g2,v,w,h,o,lo,lo,true);corner(g2,v,w,h,o,hi,lo);corner(g2,v,w,h,o,hi,hi);corner(g2,v,w,h,o,lo,hi);corner(g2,v,w,h,o,lo,lo);
    g2.stroke();
    if(projectInto(v,w,h,o[0],o[1],o[2],a)){g2.fillStyle='#fff';g2.beginPath();g2.arc(a[0],a[1],5,0,7);g2.fill();}
  };
  return dial;
}
