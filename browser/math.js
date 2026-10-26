// Shared scalar helpers (one definition of smoothstep for the whole app).
export const clamp01=x=>Math.min(1,Math.max(0,x));
/** GLSL/WGSL smoothstep(a,b,x). */
export const smoothstep=(a,b,x)=>{const t=clamp01((x-a)/(b-a));return t*t*(3-2*t);};
/** smoothstep over a [start,end] range. */
export const smoothRange=(r,x)=>smoothstep(r[0],r[1],x);
/** Wrap d into [-turn/2, turn/2). */
export const wrapTurn=(d,turn)=>((d+turn/2)%turn+turn)%turn-turn/2;
/** Wrap an angle into [-pi, pi). */
export const wrapAngle=a=>wrapTurn(a,2*Math.PI);
/** The copy of x (mod turn) nearest to 
ear, so continuous motion never jumps a full turn. */
export const unwrapNear=(x,near,turn)=>x+Math.round((near-x)/turn)*turn;
