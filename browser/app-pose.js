
import {SimClock} from './sim-clock.js';
export function installPose(app) {
const {settings,client}=app;
Object.assign(app,{applyUrlPose});
/** Exact-view export/import: Ctrl+Alt+P copies a repro link (world pose, time, settings); opening it restores the same view. */
function toast(text) {
  let t=document.getElementById('pose-toast');if(!t){t=document.createElement('div');t.id='pose-toast';t.style.cssText='position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;background:#103040e6;color:#fff;border:1px solid #4cd;padding:10px 16px;font:14px sans-serif;border-radius:6px;pointer-events:none';document.body.append(t);}
  t.textContent=text;t.hidden=false;clearTimeout(t.timer);t.timer=setTimeout(()=>{t.hidden=true;},2500);
}
function showLink(link) {
  document.exitPointerLock?.();document.getElementById('pose-box')?.remove();
  const box=document.createElement('div');box.id='pose-box';box.style.cssText='position:fixed;left:10%;right:10%;top:30%;z-index:99999;background:#102030;color:#fff;border:1px solid #4cd;padding:12px;font:14px sans-serif';
  box.innerHTML='<div>Copy this pose link (Ctrl+C), then close:</div>';const t=document.createElement('textarea');t.value=link;t.readOnly=true;t.style.cssText='width:100%;height:90px';const x=document.createElement('button');x.textContent='Close';x.onclick=()=>box.remove();box.append(t,x);document.body.append(box);t.focus();t.select();
}
function exportPose() {
  const t=client.state?.telemetry;
  const view={v:1,flight:app.flight?app.flight.slice():undefined,drive:!app.flight&&t?Array.from(t.slice(0,4)):undefined,time:app.renderer.timeOfDay,settings:{...settings}};
  const link=`${location.origin}${location.pathname}?pose=${encodeURIComponent(JSON.stringify(view))}`;
  window.lastPoseLink=link;
  const done=ok=>{if(ok)toast('Pose link copied to clipboard');else showLink(link);};
  const legacy=()=>{const t=document.createElement('textarea');t.value=link;t.style.cssText='position:fixed;opacity:0';document.body.append(t);t.select();let ok=false;try{ok=document.execCommand('copy');}catch{/* copy unsupported: ok stays false */}t.remove();return ok;};
  if(navigator.clipboard?.writeText)navigator.clipboard.writeText(link).then(()=>done(true),()=>done(legacy()));else done(legacy());
  return link;
}
async function applyUrlPose() {
  const raw=new URLSearchParams(location.search).get('pose');if(!raw)return;
  let view;try{view=JSON.parse(raw);}catch{return;}
  Object.assign(settings,view.settings||{});app.syncSettings();
  if(view.time!==undefined){app.renderer.clock=new SimClock(view.time,settings.timeScale);app.renderer.timeLock=undefined;app.renderer.lastNight=!!settings.night;}
  if(view.flight)app.flight=view.flight.slice();
  else if(view.drive){client.state=await client.request('restore',{pose:view.drive});app.flight=undefined;app.renderer.camera=undefined;}
  app.running=true;
}
window.exportPose=exportPose;
window.addEventListener('keydown',event=>{if(!event.repeat&&app.running&&(event.code==='F8'||(event.code==='KeyY'&&event.ctrlKey&&event.altKey))){event.preventDefault();event.stopPropagation();exportPose();}},true);
}
