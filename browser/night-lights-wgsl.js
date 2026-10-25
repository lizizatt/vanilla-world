export const NIGHT_W=2048,NIGHT_H=1024;
/** WGSL for surface(): `lightsAt(tc,time)` returns the additive night glow colour (before the night/altitude/land masks). */
export const nightLightsWgsl=`
fn lightsAt(tc:vec2f,t:f32)->vec3f {
  let L=textureSampleLevel(lightsTex,surfaceSamp,tc,0.0);
  let cell=floor(tc*vec2f(${NIGHT_W}.0,${NIGHT_H}.0));let ph=h2(cell)*6.2831853;
  let arc=smoothstep(.25,.5,L.a)*(1.0-smoothstep(.6,.8,L.a));let eer=smoothstep(.7,1.0,L.a);
  var k=1.0+.12*sin(t*2.3+ph);
  k=k*(1.0+arc*.3*sin(t*.8+ph*.2))*(1.0+eer*.22*sin(t*3.1+ph)*sin(t*1.3+ph*.5));
  return L.rgb*k*(1.0+arc*.35+eer*.25);
}`;
