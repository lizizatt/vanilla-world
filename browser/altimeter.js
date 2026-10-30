// Altimeter drum and climb-rate readout (pure model; flight-hud.js owns the DOM).

export const MIN_DIGITS=5,MAX_DIGITS=7,MAX_ALTITUDE=10**MAX_DIGITS-1;

/** Odometer wheels for an altitude in yd, most significant first. Each wheel's `pos` is its scroll position in [0,10): the units wheel rolls smoothly and every higher wheel only turns
 *  while all lower wheels roll 9 -> 0, like a mechanical counter. At least MIN_DIGITS wheels; negative or non-finite altitudes read 0. */
export function drumWheels(altitude) {
  const a=Number.isFinite(altitude)?Math.min(Math.max(0,altitude),MAX_ALTITUDE):0;
  const count=Math.max(MIN_DIGITS,Math.floor(a).toString().length),wheels=[];
  for(let i=0;i<count;i++) {
    const unit=10**i,digit=Math.floor(a/unit)%10;
    wheels.unshift({digit,pos:digit+Math.max(0,a%unit-(unit-1))});
  }
  return wheels;
}

/** Signed climb rate text: "+12 yd/s", "\u2212340 yd/s", "0 yd/s"; thousands grouped. */
export function formatClimb(rate) {
  const v=Number.isFinite(rate)?Math.round(rate):0;
  return `${v>0?'+':v<0?'\u2212':''}${Math.abs(v).toLocaleString('en-US')} yd/s`;
}

/** Exponentially smoothed d(altitude)/dt. A teleport, body swap or long stall restarts the estimate instead of spiking it. */
export class ClimbRate {
  constructor(tau=.35,reset=2) {this.tau=tau;this.reset=reset;this.value=0;this.last=undefined;}
  update(altitude,time,body) {
    const p=this.last;this.last={altitude,time,body};
    if(!p||p.body!==body||!(time>p.time)||time-p.time>this.reset||!Number.isFinite(altitude)){this.value=0;return 0;}
    const dt=time-p.time,raw=(altitude-p.altitude)/dt,k=1-Math.exp(-dt/this.tau);
    this.value+=(raw-this.value)*k;
    return this.value;
  }
}
