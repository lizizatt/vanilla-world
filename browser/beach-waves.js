// Visual-only beach waves (no physics): a wave train runs along the averaged shore normal (shore-field.js), shoals (grows and shortens, Green's law),
// steepens into a forward-leaning crest that overturns into a foam lip, collapses into a bore, washes up the beach as a thin foam sheet and retreats.
// Additive layer on the clipmap (material 9): crest-only (never below the flat sea), fades out by distance and where the shore field has no open sea.
// Amplitude: deep train A0 = .5 yd x (.75+.5*wind); shoaled up to x2.5 just before the break (~1.2 yd at default wind, hard cap ~1.6 yd at full wind); swash sheet <= .07 yd; +.03 yd lift.
// The clock is the wave sim clock (waveTime), reduced to a fraction of the beach period in f64, so pause pauses it and the 1024 s master period wraps seamlessly.
import {SHORE_D_MIN,SHORE_D_MAX} from './shore-field.js';
import {MASK_EPS} from './wave-render.js';
import {waveTime} from './wave-math.js';
import {WATER_LOOK} from './water-shader.js';

const TAU=Math.PI*2;
// Phase wobble coordinate. A fixed direction, not the local coast tangent: the tangent turns around islands and bends, and dot(P,tangent) with P ~ 1e4 yd then slides the phase by many radians per pixel (radial foam streaks, moire rings, starbursts).
export const ALONG_DIR=[.8,.6];
export const BEACH={
  L0:28,D0:40,E:4,                 // deep wavelength (yd), shoaling reference distance, offset that keeps the wavelength finite at the line
  PERIOD:1024/200,                 // beach wave period (s): 200 periods per master period
  A0:.5,SHOAL:1.5,LIFT:.03,
  BREAK:[26,13],                    // distance (yd) where steepening starts / is complete
  KAPPA:.92,DELTA:.6,LEAN:2.2,     // phase-warp skew (steep front, gentle back) and forward lean of the crest (x height, yd)
  ZONE:[70,90],RUP:8,SWASH:.07,    // wave zone fades out between these distances; swash run-up (yd landward of the line) and sheet height
  FADE:[150,240],GEO:[70,130],     // foam/normal fade and vertex-displacement fade by eye distance (yd)
  WINDOW_FADE:[.36,.46],
  Q_MAX:3.5,                       // hard bound on the shoreward crest displacement (yd); the full-wind maximum is LEAN x 1.6 = 3.4
};
export const beachPeriodFraction=t=>{const x=t/BEACH.PERIOD;return x-Math.floor(x);};
const smoothstep=(e0,e1,x)=>{const s=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return s*s*(3-2*s);};

/** Swash envelope for the wash phase w in [0,1): landward front of the sheet (yd, <= 0 is up the beach) and its seaward tail (yd from the line). */
export function swashEnvelope(w){
  const rise=smoothstep(0,.28,w)*(1-smoothstep(.28,1,w));
  return {front:-BEACH.RUP*rise,tail:1.5+5*(1-smoothstep(.15,.8,w))};
}
/**
 * CPU mirror of the shader's beachSurface() geometry. d: signed distance to the waterline (yd, + is water), along: chart coordinate along the coast,
 * tFrac: beachPeriodFraction, wind 0..1, weight: field x fade weight 0..1. Returns height h (yd), shoreward displacement q (yd), slope dh/dd, b (break 0..1),
 * c (crest profile 0..1), jac = dX/dd (< .08 is clamped in shading) and the swash sheet height.
 */
export function beachProfile(d,along,tFrac,wind=.35,weight=1){
  const B=BEACH,dd=Math.max(d,0)+B.E,psi=2*Math.sqrt(B.D0*dd),thetaDot=TAU/B.L0*Math.sqrt(B.D0/dd)*(d>0?1:0);
  const theta=TAU*(psi/B.L0+tFrac)+.55*Math.sin(along/41+1.7)+.35*Math.sin(along/17-.6);
  const b=smoothstep(B.BREAK[0],B.BREAK[1],d);
  const zone=1-smoothstep(B.ZONE[0],B.ZONE[1],d),land=smoothstep(-.5,3,d);
  const A=B.A0*(.75+.5*wind)*(1+B.SHOAL*smoothstep(44,16,d))*(1-.55*smoothstep(11,5,d))*zone*land*weight;
  const kappa=B.KAPPA*(.15+.85*b),warp=1+kappa*Math.cos(theta+B.DELTA),tw=theta+kappa*Math.sin(theta+B.DELTA);
  const c=.5+.5*Math.cos(tw),h=A*c**1.6,lean=B.LEAN*b;
  const dh=-A*1.6*.5*c**.6*Math.sin(tw)*warp*thetaDot,jac=1-lean*dh;
  const line=(TAU*(2*Math.sqrt(B.D0*B.E)/B.L0+tFrac)+.55*Math.sin(along/41+1.7)+.35*Math.sin(along/17-.6))/TAU,wash=line-Math.floor(line),env=swashEnvelope(wash);
  const sheet=smoothstep(env.front-.5,env.front+.4,d)*(1-smoothstep(env.tail-1.5,env.tail,d))*weight;
  return {h,q:Math.min(lean*h,B.Q_MAX),slope:dh/Math.max(jac,.08),b,c,jac,sheet,sheetH:B.SWASH*sheet*(1-smoothstep(0,5,d)),wash};
}

/** Uniform block (8 floats): a=(on, field origin x,z render-relative, 1/window) b=(period fraction, render origin x, z, 0). */
export function packBeachUniform(out,{field,origin,ticks,params}){
  out.fill(0);
  if(!field)return out;
  out.set([1,field.origin[0]-origin[0],field.origin[1]-origin[1],1/(field.n*field.cell)],0);
  out.set([beachPeriodFraction(waveTime(params,ticks)),origin[0],origin[1],0],4);
  return out;
}

export const beachShading=`
struct Beach {a:vec4f,b:vec4f};
@group(0) @binding(7) var<uniform> bc:Beach;
@group(0) @binding(8) var shoreTex:texture_2d<f32>;
struct BF {d:f32,n:vec2f,w:f32};
struct BS {h:f32,q:f32,slope:vec2f,n:vec2f,d:f32,w:f32,b:f32,c:f32,sheet:f32,sheetH:f32,wash:f32,crest:f32,geo:f32};
// Swap point for the weather: 0..1 wind strength driving the beach swell (seaState().x today; a procedural wind function can replace this one line).
fn beachWind()->f32 {return seaState().x;}
fn bSmooth(a:f32,b:f32,x:f32)->f32 {let t=clamp((x-a)/(b-a),0.0,1.0);return t*t*(3.0-2.0*t);}
fn bHash(p:vec2f)->f32 {return fract(sin(dot(p,vec2f(127.1,311.7)))*43758.5453);}
fn bNoise(p:vec2f)->f32 {
  let i=floor(p);let f=fract(p);let s=f*f*(3.0-2.0*f);
  return mix(mix(bHash(i),bHash(i+vec2f(1.0,0.0)),s.x),mix(bHash(i+vec2f(0.0,1.0)),bHash(i+vec2f(1.0,1.0)),s.x),s.y);
}
fn beachField(xz:vec2f)->BF {
  var f:BF;f.d=${SHORE_D_MAX.toFixed(1)};f.n=vec2f(1.0,0.0);f.w=0.0;
  if(bc.a.x<.5){return f;}
  let uv=(xz-bc.a.yz)*bc.a.w;
  if(any(uv<=vec2f(0.0))||any(uv>=vec2f(1.0))){return f;}
  let s=textureSampleLevel(shoreTex,waveSampler,uv,0.0);
  f.d=${SHORE_D_MIN.toFixed(1)}+s.r*${(SHORE_D_MAX-SHORE_D_MIN).toFixed(1)};
  let n=s.gb*2.0-1.0;f.n=n/max(length(n),.001);
  f.w=s.a*(1.0-bSmooth(${BEACH.WINDOW_FADE[0]},${BEACH.WINDOW_FADE[1]},max(abs(uv.x-.5),abs(uv.y-.5))));
  return f;
}
// Everything the vertex and fragment stages need at lattice point P (render-space xz): mirrors beach-waves.js beachProfile().
fn beachSurface(P:vec2f,eyeXZ:vec2f)->BS {
  var s:BS;let f=beachField(P);s.n=f.n;s.d=f.d;s.geo=0.0;
  let dist=length(P-eyeXZ);
  let w=f.w*(1.0-bSmooth(${BEACH.FADE[0].toFixed(1)},${BEACH.FADE[1].toFixed(1)},dist))*step(${(-BEACH.RUP-2).toFixed(1)},f.d);
  s.w=w;if(w<=.001){return s;}
  s.geo=1.0-bSmooth(${BEACH.GEO[0].toFixed(1)},${BEACH.GEO[1].toFixed(1)},dist);
  let d=f.d;let along=dot(P+bc.b.yz,vec2f(${ALONG_DIR[0]},${ALONG_DIR[1]}));
  let dd=max(d,0.0)+${BEACH.E.toFixed(1)};let psi=2.0*sqrt(${BEACH.D0.toFixed(1)}*dd);
  let thetaDot=${(TAU/BEACH.L0).toFixed(5)}*sqrt(${BEACH.D0.toFixed(1)}/dd)*step(0.0,d);
  let theta=${TAU.toFixed(5)}*(psi/${BEACH.L0.toFixed(1)}+bc.b.x)+.55*sin(along/41.0+1.7)+.35*sin(along/17.0-.6);
  let b=bSmooth(${BEACH.BREAK[0].toFixed(1)},${BEACH.BREAK[1].toFixed(1)},d);
  let wind=beachWind();
  let zone=1.0-bSmooth(${BEACH.ZONE[0].toFixed(1)},${BEACH.ZONE[1].toFixed(1)},d);let land=bSmooth(-.5,3.0,d);
  let A=${BEACH.A0}*(.75+.5*wind)*(1.0+${BEACH.SHOAL}*bSmooth(44.0,16.0,d))*(1.0-.55*bSmooth(11.0,5.0,d))*zone*land*w;
  let kappa=${BEACH.KAPPA}*(.15+.85*b);let warp=1.0+kappa*cos(theta+${BEACH.DELTA});let tw=theta+kappa*sin(theta+${BEACH.DELTA});
  let c=.5+.5*cos(tw);let lean=${BEACH.LEAN}*b;
  let h=A*pow(c,1.6);let dh=-A*.8*pow(c,.6)*sin(tw)*warp*thetaDot;
  let jac=1.0-lean*dh;
  s.h=h;s.q=min(lean*h,${BEACH.Q_MAX.toFixed(1)});s.b=b;s.c=c;
  s.slope=f.n*(dh/max(jac,.08));
  let lineTheta=${TAU.toFixed(5)}*(${(2*Math.sqrt(BEACH.D0*BEACH.E)/BEACH.L0).toFixed(5)}+bc.b.x)+.55*sin(along/41.0+1.7)+.35*sin(along/17.0-.6);let wp=lineTheta/${TAU.toFixed(5)};let wash=wp-floor(wp);s.wash=wash;
  let rise=bSmooth(0.0,.28,wash)*(1.0-bSmooth(.28,1.0,wash));
  let front=-${BEACH.RUP.toFixed(1)}*rise;let tail=1.5+5.0*(1.0-bSmooth(.15,.8,wash));
  s.sheet=bSmooth(front-.5,front+.4,d)*(1.0-bSmooth(tail-1.5,tail,d))*w;
  s.sheetH=${BEACH.SWASH}*s.sheet*(1.0-bSmooth(0.0,5.0,d));
  s.crest=clamp(b*smoothstep(.2,.9,length(s.slope)*4.0)*w,0.0,1.0);
  return s;
}
// The clipmap is also live in the beach zone (the fill below stays, the layer is crest-only and lifted ${BEACH.LIFT} yd).
fn clipLive(P:vec2f)->bool {return waveAmp(P)>=${MASK_EPS}||beachSurface(P,u.eye.xz).w>.001;}
fn beachApply(P:vec2f,eyeXZ:vec2f,wave:ptr<function,WV>) {
  let s=beachSurface(P,eyeXZ);
  if(s.w<=.001){return;}
  (*wave).xz=(*wave).xz-s.n*s.q*s.geo;
  (*wave).h=(*wave).h+(s.h+s.sheetH)*s.geo+${BEACH.LIFT}*clamp(s.w*4.0,0.0,1.0);
}
// Depth ramp for waterColor from the shore field, so the layer keeps the shallow turquoise the tile liquid would have given.
fn beachRamp(s:BS)->f32 {return mix(1.0,clamp(s.d/70.0,0.0,1.0),clamp(s.w*3.0,0.0,1.0));}
fn beachFoam(color:vec3f,s:BS,P:vec2f)->vec3f {
  if(s.w<=.001){return color;}
  let t=u.settings.y;let n1=bNoise(P*1.3+vec2f(t*.15,-t*.1));let n2=bNoise(P*4.1-vec2f(t*.3,t*.2));let hf=bHash(floor(P*7.0)+floor(t*9.0));
  let d=s.d;
  let lip=s.b*bSmooth(.62,.95,s.c)*(.55+.45*n1)*bSmooth(-.5,1.5,d);
  let spray=s.b*bSmooth(.86,1.0,s.c)*step(.78,hf)*(.4+.6*n2);
  let bore=bSmooth(12.0,7.0,d)*bSmooth(.12,.55,s.c)*(.6+.4*n2)*bSmooth(-.5,.5,d);
  let thr=mix(.25,.72,bSmooth(.2,1.0,s.wash));
  let lace=bSmooth(thr-.12,thr+.12,.55*n1+.45*n2);
  let sheet=s.sheet*lace*(1.0-.8*bSmooth(.3,1.0,s.wash));
  let band=(1.0-bSmooth(.4,1.8+.8*n1,d))*bSmooth(-.8,.2,d)*(.45+.55*n2)*s.w;
  let foam=clamp(lip+spray+bore+sheet+band,0.0,1.0);
  let tint=vec3f(${WATER_LOOK.foam.map(x=>x.toFixed(3)).join(',')})*mix(1.0,.35,nightK());
  return mix(color,tint,foam*.92);
}
`;
