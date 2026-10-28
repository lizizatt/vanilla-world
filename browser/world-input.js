export const DRIVE_KEYS=new Set(['KeyW','KeyS','KeyA','KeyD','KeyQ','KeyE','KeyC','KeyJ','KeyV','KeyX','KeyF',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight',
  'AltLeft','AltRight','F9']);
const axis=(value,deadzone)=>Number.isFinite(value) && Math.abs(value)>deadzone
  ?Math.sign(value)*(Math.min(1,Math.abs(value))-deadzone)/(1-deadzone):0;
const button=(pad,index)=>pad.buttons[index]?.pressed || (pad.buttons[index]?.value || 0)>.5;
const value=(pad,index)=>axis(pad.buttons[index]?.value, .08);
const podAxis=value=>{const n=axis(value,.15);return .75*n+.25*n*n*n;};
export const POD_PITCH_SIGN=-1;

/** The canonical Intent every device maps to: throttle/steer/pitch in [-1,1], bit flags (1 handbrake, 2 boost, 4 drift, 8 jump),
 *  look axes in [-1,1], zoom step and one-shot edge actions. */
export const idleIntent=(brake=true)=>({throttle:0,steer:0,pitch:0,flags:brake?1:0,look:[0,0],zoom:0,cockpit:false,reset:false,flight:false,help:false});

export class WorldInput {
  constructor(){this.device='keyboard';this.active=undefined;this.previous=new Map();}
  keyboard(){this.device='keyboard';}
  sample(keys,pads,accepts,profile='native',brakeWhenInactive=true,podracer=false) {
    const connected=pads.filter(p=>p?.connected && p.mapping==='standard');
    const keyboardHeld=keys.size>0;
    if(accepts&&keyboardHeld)this.device='keyboard';
    for(const id of this.previous.keys())if(!connected.some(p=>p.index===id))this.previous.delete(id);
    if(this.active!==undefined && !connected.some(p=>p.index===this.active)) {
      this.active=undefined;this.device='keyboard';
    }
    let selected,edges=[];
    for(const pad of connected) {
      const analog=[podracer?podAxis(pad.axes[0]):axis(pad.axes[0],.18),value(pad,7),value(pad,6),
        axis(pad.axes[2],.18),-axis(pad.axes[3],.18),podracer?POD_PITCH_SIGN*-podAxis(pad.axes[1]):0];
      const pressed=pad.buttons.map((_,i)=>!!button(pad,i)),before=this.previous.get(pad.index);
      const rising=pressed.map((p,i)=>p && !before?.pressed[i]);
      const activity=rising.some(Boolean) || analog.some((v,i)=>v!==0 && Math.abs(v-(before?.analog[i]||0))>.04);
      this.previous.set(pad.index,{analog,pressed});
      if(accepts && activity){this.active=pad.index;if(!keyboardHeld)this.device='controller';}
      if(pad.index===this.active){selected={pad,analog};edges=rising;}
    }
    const idle=idleIntent(brakeWhenInactive);
    if(!accepts)return idle;
    const actions={zoom:Number(!!edges[12])-Number(!!edges[13]),cockpit:!!edges[11],
      reset:!!edges[3],flight:!!edges[9],help:!!edges[8]};
    if(this.device==='controller' && selected) {
      const {pad,analog:a}=selected;
      return {...actions,throttle:a[1]-a[2],steer:-a[0],pitch:a[5],
        flags:podracer?(button(pad,0)?2:0)|(button(pad,2)?4:0)|(button(pad,5)?8:0)
          :(button(pad,5)?2:0)|(button(pad,4)?4:0)|(button(pad,0)?8:0),
        look:a.slice(3,5)};
    }
    const down=k=>Number(keys.has(k)),legacy=profile==='legacy';
    return {...idle,...actions,throttle:down('KeyW')-down('KeyS'),steer:down('KeyA')-down('KeyD'),
      pitch:podracer?(POD_PITCH_SIGN*(down('ArrowUp')-down('ArrowDown'))||0):0,
      flags:(down('KeyX')||(legacy && down('Space')))|((down('ShiftLeft')||down('ShiftRight'))<<1)
        |((down('KeyC')||(!legacy && down('Space')))<<2)
        |(down('KeyJ')<<3),
      look:[down('ArrowRight')-down('ArrowLeft'),podracer?0:down('ArrowUp')-down('ArrowDown')]};
  }
}
