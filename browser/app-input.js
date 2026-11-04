import {nearElune} from './elune-pose.js';
import {podInSpace} from './pod-attitude.js';
import {sharedKeymap} from './keymap.js';
// Press actions other modules own (their listeners ask the same keymap): Esc layering, the F1 hold overlay, the editor's own keys and the debug panels.
export const EXTERNAL_PRESS=Object.freeze(['ui.menu','ui.cheatsheet','editor.add','editor.select','editor.start','editor.delete','editor.undo','editor.dial','debug.pose','debug.wind']);
/** One handler per press action owned here; each returns true when it acted. */
export function pressHandlers(app) {
const {settings,mapPanel}=app;
const $=id=>document.getElementById(id);
const running=fn=>()=>app.running?fn()!==false:false;
return {
  'debug.crash':running(()=>{void app.testCrash();}),
  'ui.map':running(()=>{mapPanel.toggle();}),
  'ui.elune':running(()=>{if(app.race||!app.renderer.sharedSpace)return false;void app.arrival(()=>{app.flight=nearElune(30000,app.renderer.timeOfDay??0);app.space=undefined;settings.planet=true;}).catch(app.fail);}),
  'ui.unstuck':running(()=>{if(app.flight)return false;$('unstuck').click();}),
  'ui.radio':running(()=>{app.openRadio?.();}),
  'ui.garage':running(()=>{app.openGarage();}),
  'ui.editor':running(()=>{app.toggleEditor();}),
  'ui.options':running(()=>{app.openRaceMenu('options');}),
  'ui.keybinds':running(()=>{app.openRaceMenu('keys');}),
  'ui.flyDrive':running(()=>{if(app.race)return false;$(app.flight?'drive':'fly').click();}),
  'cam.cockpit':running(()=>{app.cockpit();}),
  'drive.reset':()=>{$('reset').click();return true;},
  'race.start':event=>{
    if(event?.shiftKey)return false;
    const again=app.raceAgain();
    if(again&&!app.race)app.startRace(again);else if(app.promptTrack&&!app.race)app.startRace(app.promptTrack);else return false;
    return true;
  },
};
}
export function installInput(app) {
const {canvas,keys,input,mapPanel}=app;
const keymap=app.keymap??=sharedKeymap(),handlers=pressHandlers(app);
canvas.addEventListener('keydown',event=>{
  if(!event.repeat && event.code==='Escape' && mapPanel.open){event.preventDefault();mapPanel.dialog.close();return;}
  if(!event.repeat && event.code==='Escape' && app.running && !app.raceMenu.open){event.preventDefault();app.openRaceMenu();return;}
  let handled=false;
  if(!event.repeat)for(const action of keymap.actionsFor(event,a=>a.kind==='press'&&handlers[a.id])) {
    handled=true;event.preventDefault();
    if(handlers[action.id](event))break;
  }
  if(keymap.heldCodes().has(event.code)){event.preventDefault();keys.add(event.code);handled=true;}
  if(handled){if(!event.repeat)input.keyboard();app.resumeAudio(true);}
});
canvas.addEventListener('pointerdown',event=>{
  canvas.focus();app.resumeAudio(true);
  app.mouseButtons=event.buttons;if(event.button===0||event.button===2){app.dragging=true;canvas.setPointerCapture(event.pointerId);}
  if(event.button===2&&!app.flight&&app.choice.vehicle==='podracer'&&podInSpace(app.client.state?.pod?.journey))canvas.style.cursor='grabbing';
});
canvas.addEventListener('pointermove',event=>{
  if(!app.dragging)return;
  app.mouseButtons=event.buttons;
  const turning=!!(event.buttons&2)&&!app.flight&&app.choice.vehicle==='podracer'&&podInSpace(app.client.state?.pod?.journey);
  const motion=turning?(app.podOrbit??=[0,0]):app.orbit;
  motion[0]+=event.movementX;motion[1]+=event.movementY;
});
canvas.addEventListener('pointerup',event=>{app.mouseButtons=event.buttons;app.dragging=!!(app.mouseButtons&3);if(!(event.buttons&2))canvas.style.cursor='';});
const clearPointer=()=>{app.dragging=false;app.mouseButtons=0;app.orbit=[0,0];app.podOrbit=[0,0];canvas.style.cursor='';};
canvas.addEventListener('lostpointercapture',()=>{if(app.mouseButtons)clearPointer();});
canvas.addEventListener('pointercancel',clearPointer);
canvas.addEventListener('contextmenu',event=>event.preventDefault());
canvas.addEventListener('wheel',event=>{if(app.running){event.preventDefault();app.zoom(-Math.sign(event.deltaY));}},{passive:false});
window.addEventListener('keyup',event=>keys.delete(event.code));
canvas.addEventListener('blur',()=>{if(mapPanel.open)return;keys.clear();clearPointer();});
window.addEventListener('blur',()=>{keys.clear();clearPointer();app.pauseAudio();});
window.addEventListener('focus',()=>app.resumeAudio());
document.addEventListener('visibilitychange',()=>{keys.clear();app.last=0;if(document.hidden){clearPointer();app.pauseAudio();}else app.resumeAudio();});
}
