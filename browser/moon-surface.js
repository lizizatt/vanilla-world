// Elune's surface as seen from space (design/elune.md step D): the same procedural albedo the chunk generator uses, baked to an equirect texture in the body frame (lon 0 = +X toward Azeroth).
import {moonAlbedo,moonHeightDir} from './moon-terrain.js';
import {MOON_SEED} from './moon-source.js';

export const MOON_TEX_W=512,MOON_TEX_H=256;

/** RGBA8 bytes, MOON_TEX_W x MOON_TEX_H, direction convention x=cos(lat)cos(lon), y=sin(lat), z=cos(lat)sin(lon) (same as planet-frame toPlanet). */
export function bakeMoonSurface(seed=MOON_SEED,w=MOON_TEX_W,h=MOON_TEX_H) {
  const out=new Uint8Array(w*h*4);
  for(let j=0;j<h;j++) {
    const lat=(.5-(j+.5)/h)*Math.PI,cl=Math.cos(lat),sl=Math.sin(lat);
    for(let i=0;i<w;i++) {
      const lon=((i+.5)/w-.5)*2*Math.PI,x=cl*Math.cos(lon),z=cl*Math.sin(lon);
      const c=moonAlbedo(seed,x,sl,z),k=(j*w+i)*4;
      out[k]=Math.round(255*Math.min(1,c[0]));out[k+1]=Math.round(255*Math.min(1,c[1]));out[k+2]=Math.round(255*Math.min(1,c[2]));out[k+3]=255;
    }
  }
  return out;
}
export {moonHeightDir};
