// Shared scalar helpers (one definition of smoothstep for the whole app).
export const clamp01=x=>Math.min(1,Math.max(0,x));
/** GLSL/WGSL smoothstep(a,b,x). */
export const smoothstep=(a,b,x)=>{const t=clamp01((x-a)/(b-a));return t*t*(3-2*t);};
/** smoothstep over a [start,end] range. */
export const smoothRange=(r,x)=>smoothstep(r[0],r[1],x);
