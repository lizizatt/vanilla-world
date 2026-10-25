import {DRIVE_KEYS} from './world-input.js';
export function installInput(app) {
const {canvas,keys,input,settings,mapPanel}=app;
const $=id=>document.getElementById(id);
canvas.addEventListener('keydown',event=>{
  if(!event.repeat && event.code==='KeyK' && event.ctrlKey && event.altKey && app.running){event.preventDefault();app.testCrash();return;}
  if(!event.repeat && event.code==='KeyM' && !event.ctrlKey && !event.altKey && !event.metaKey && app.running){event.preventDefault();mapPanel.toggle();}
  if(!event.repeat && event.code==='KeyU' && !event.ctrlKey && !event.altKey && !event.metaKey && app.running && !app.flight){event.preventDefault();$('unstuck').click();return;}
  if(!event.repeat && event.code==='KeyG' && !event.ctrlKey && !event.altKey && !event.metaKey && app.running){event.preventDefault();app.openGarage();return;}
  if(!event.repeat && event.code==='KeyT' && !event.ctrlKey && !event.altKey && !event.metaKey && app.running){event.preventDefault();app.toggleEditor();return;}
  if(!event.repeat && event.code==='Escape' && mapPanel.open){event.preventDefault();mapPanel.dialog.close();return;}
  if(!event.repeat && event.code==='Escape' && app.running && !app.raceMenu.open){event.preventDefault();app.openRaceMenu();return;}
  if(DRIVE_KEYS.has(event.code)) {
    event.preventDefault();keys.add(event.code);if(!event.repeat)input.keyboard();
    if(!event.repeat && event.code==='F9')$('reset').click();
    if(!event.repeat && event.code==='KeyF' && !event.ctrlKey && !event.altKey){const again=app.raceAgain();if(again&&!app.race)app.startRace(again);else if(app.promptTrack&&!app.race)app.startRace(app.promptTrack);else app.cockpit();}
    if(!event.repeat && event.code==='KeyV' && event.ctrlKey && event.altKey && !event.shiftKey)app.cockpit();
    app.resumeAudio(true);
  }
});
canvas.addEventListener('pointerdown',event=>{
  canvas.focus();app.resumeAudio(true);
  app.mouseButtons=event.buttons;if(event.button===0||event.button===2){app.dragging=true;canvas.setPointerCapture(event.pointerId);}
});
canvas.addEventListener('pointermove',event=>{if(app.dragging){app.mouseButtons=event.buttons;app.orbit[0]+=event.movementX;app.orbit[1]+=event.movementY;}});
canvas.addEventListener('pointerup',event=>{app.mouseButtons=event.buttons;app.dragging=!!(app.mouseButtons&3);});
canvas.addEventListener('lostpointercapture',()=>{app.dragging=false;app.mouseButtons=0;});
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('wheel',event=>{if(app.running){event.preventDefault();app.zoom(-Math.sign(event.deltaY));}},{passive:false});
window.addEventListener('keyup',event=>keys.delete(event.code));
canvas.addEventListener('blur',()=>{if(mapPanel.open)return;keys.clear();app.orbit=[0,0];app.dragging=false;app.mouseButtons=0;});
window.addEventListener('blur',()=>{keys.clear();app.pauseAudio();});
window.addEventListener('focus',()=>app.resumeAudio());
document.addEventListener('visibilitychange',()=>{keys.clear();app.last=0;if(document.hidden)app.pauseAudio();else app.resumeAudio();});
}
