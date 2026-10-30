// Right-edge flight instruments: a round compass whose card turns so its gold arrow points at the nearest body's north pole,
// a drum-roll altimeter (yd above that body) and the signed climb rate. DOM only; the maths lives in compass.js / altimeter.js.
import {drumWheels,formatClimb,ClimbRate} from './altimeter.js';
import {flightInstruments} from './compass.js';
import {RING_CROP} from './hud-art.js';

const strip=()=>`<i>${[...'01234567890'].join('</i><i>')}</i>`;

export class FlightHud {
  constructor(root) {
    this.root=root;this.card=root.querySelector('.fh-card');this.drum=root.querySelector('.fh-drum');this.rate=root.querySelector('.fh-rate');
    this.climb=new ClimbRate();this.count=0;this.key='';this.shown={};
  }
  /** Feed one frame: `body` is activeFramedBody(), `view` the renderer view (eye,look,up,right), `t` sim time, `now` wall seconds (for the smoothing). */
  update(body,view,t,now) {
    const r=flightInstruments(body,view.eye,view,t),alt=Math.max(0,r.altitude);
    this.set('overhead',String(r.overhead));
    const deg=Math.round(r.angle*180/Math.PI*2)/2;
    if(this.shown.deg!==deg){this.shown.deg=deg;this.card.style.transform=`rotate(${deg}deg)`;}
    this.wheels(alt);
    const text=formatClimb(this.climb.update(alt,now,r.body));
    if(this.shown.rate!==text){this.shown.rate=text;this.rate.textContent=text;this.rate.dataset.sign=text[0]==='+'?'up':text[0]==='0'?'zero':'down';}
    return r;
  }
  set(name,value){if(this.shown[name]!==value){this.shown[name]=value;this.root.dataset[name]=value;}}
  wheels(alt) {
    const w=drumWheels(alt);
    if(w.length!==this.count){
      this.count=w.length;this.key='';
      this.drum.replaceChildren(...w.map(()=>{const cell=document.createElement('span');cell.className='fh-wheel';cell.innerHTML=`<b>${strip()}</b>`;return cell;}));
      this.drum.style.setProperty('--n',String(w.length));
    }
    const key=w.map(x=>Math.round(x.pos*25)).join(',');
    if(key===this.key)return;
    this.key=key;
    w.forEach((x,i)=>{this.drum.children[i].firstChild.style.transform=`translateY(${(-x.pos*100/11).toFixed(2)}%)`;});
    this.drum.setAttribute('aria-label',`Altitude ${Math.floor(alt).toLocaleString('en-US')} yards`);
  }
  /** Decoded WoW art from the worker: crops the gold ring, registers the game font. Both are optional. */
  art(data) {
    if(data.ring){
      const {width,height,rgba}=data.ring,src=document.createElement('canvas'),dst=document.createElement('canvas'),{x,y,size}=RING_CROP;
      src.width=width;src.height=height;src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer,rgba.byteOffset,rgba.length),width,height),0,0);
      dst.width=dst.height=size;dst.className='fh-ring';dst.setAttribute('aria-hidden','true');dst.getContext('2d').drawImage(src,x,y,size,size,0,0,size,size);
      this.card.prepend(dst);this.root.dataset.art='ring';
    }
    if(data.font&&typeof FontFace==='function'){
      new FontFace('WoW Friz',data.font).load().then(f=>{document.fonts.add(f);this.root.dataset.font='wow';}).catch(()=>{});
    }
  }
}
