// Pure translate-gizmo math (no DOM): pixel rays, axis/plane handle picking and drags. view = renderer.view {eye,right,up,look,aspect}.
// Hot-path functions write into caller-supplied scratch objects so a frame allocates nothing.
import {TAN_HALF} from './track-edit.js';

export const AXES={x:[1,0,0],y:[0,1,0],z:[0,0,1]};
export const AXIS_KEYS=['x','y','z'];
export const PICK_PX=10,GIZMO_PX=120;
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

export const makeRay=()=>({o:[0,0,0],d:[0,0,1]});
// Ray through pixel (sx,sy) of a w*h canvas.
export function pixelRay(view,w,h,sx,sy,ray) {
  const nx=(sx/w*2-1)*TAN_HALF*view.aspect,ny=(1-sy/h*2)*TAN_HALF;
  let l=0;
  for(let i=0;i<3;i++){ray.o[i]=view.eye[i];ray.d[i]=view.look[i]+view.right[i]*nx+view.up[i]*ny;l+=ray.d[i]*ray.d[i];}
  l=Math.sqrt(l)||1;for(let i=0;i<3;i++)ray.d[i]/=l;
  return ray;
}

// World length that appears `px` pixels tall at `center`, so the gizmo keeps one screen size at any zoom.
export function worldPerPixel(view,h,center) {
  const z=(center[0]-view.eye[0])*view.look[0]+(center[1]-view.eye[1])*view.look[1]+(center[2]-view.eye[2])*view.look[2];
  return 2*TAN_HALF*Math.max(z,1)/h;
}

// Closest approach of the ray (o+s*d, d unit) to the infinite line (p+t*a, a unit). Returns false when they are near-parallel.
export function closestOnLine(ray,p,a,out) {
  const o=ray.o,d=ray.d,b=dot(d,a),w0x=o[0]-p[0],w0y=o[1]-p[1],w0z=o[2]-p[2];
  const dd=d[0]*w0x+d[1]*w0y+d[2]*w0z,e=a[0]*w0x+a[1]*w0y+a[2]*w0z,den=1-b*b;
  if(den<1e-6)return false;
  const s=(b*e-dd)/den,t=e+s*b;
  const dx=w0x+s*d[0]-t*a[0],dy=w0y+s*d[1]-t*a[1],dz=w0z+s*d[2]-t*a[2];
  out.s=s;out.t=t;out.dist=Math.sqrt(dx*dx+dy*dy+dz*dz);
  return true;
}

// Distance from the ray to the point p+t*a with t clamped to [0,len]; out.s is the depth along the ray (<=0: behind the eye).
function segmentHit(ray,p,a,len,out) {
  if(!closestOnLine(ray,p,a,out))return false;
  const t=Math.max(0,Math.min(len,out.t));
  const x=p[0]+a[0]*t-ray.o[0],y=p[1]+a[1]*t-ray.o[1],z=p[2]+a[2]*t-ray.o[2];
  const s=x*ray.d[0]+y*ray.d[1]+z*ray.d[2];
  out.s=s;out.dist=Math.sqrt(Math.max(0,x*x+y*y+z*z-s*s));
  return true;
}

const hitScratch={s:0,t:0,dist:0};
// Pick a gizmo handle at `origin`: 'x'|'y'|'z' for an axis arrow (length len), 'xz' for the small ground-plane square, else undefined.
export function pickHandle(ray,origin,len,tol) {
  let best,bestS=Infinity;
  for(const k of AXIS_KEYS){
    if(!segmentHit(ray,origin,AXES[k],len,hitScratch)||hitScratch.s<=0||hitScratch.dist>tol)continue;
    if(hitScratch.s<bestS){bestS=hitScratch.s;best=k;}
  }
  if(best)return best;
  if(Math.abs(ray.d[1])<1e-6)return;
  const s=(origin[1]-ray.o[1])/ray.d[1];
  if(s<=0)return;
  const dx=ray.o[0]+ray.d[0]*s-origin[0],dz=ray.o[2]+ray.d[2]*s-origin[2],lo=len*PLANE_LO,hi=len*PLANE_HI;
  return dx>=lo&&dx<=hi&&dz>=lo&&dz<=hi?'xz':undefined;
}
// The ground-plane handle is the square from PLANE_LO to PLANE_HI of the gizmo length along +x and +z.
export const PLANE_LO=.2,PLANE_HI=.5;

export const makeDrag=()=>({axis:'',t0:0,x0:0,z0:0,pos0:[0,0,0],tmp:{s:0,t:0,dist:0}});
// Start dragging `axis` of a gate at pos; returns false if the ray cannot be projected onto it.
export function beginDrag(drag,ray,pos,axis) {
  drag.axis=axis;drag.pos0[0]=pos[0];drag.pos0[1]=pos[1];drag.pos0[2]=pos[2];
  if(axis==='xz'){
    if(Math.abs(ray.d[1])<1e-6)return false;
    const s=(pos[1]-ray.o[1])/ray.d[1];if(s<=0)return false;
    drag.x0=ray.o[0]+ray.d[0]*s;drag.z0=ray.o[2]+ray.d[2]*s;return true;
  }
  if(!closestOnLine(ray,pos,AXES[axis],drag.tmp))return false;
  drag.t0=drag.tmp.t;return true;
}
// New gate position for the current ray, written into out; returns false when the ray is degenerate (position unchanged).
export function dragTo(drag,ray,out) {
  const p=drag.pos0;out[0]=p[0];out[1]=p[1];out[2]=p[2];
  if(drag.axis==='xz'){
    if(Math.abs(ray.d[1])<1e-6)return false;
    const s=(p[1]-ray.o[1])/ray.d[1];if(s<=0)return false;
    out[0]=p[0]+ray.o[0]+ray.d[0]*s-drag.x0;out[2]=p[2]+ray.o[2]+ray.d[2]*s-drag.z0;return true;
  }
  if(!closestOnLine(ray,p,AXES[drag.axis],drag.tmp))return false;
  const k=drag.axis==='x'?0:drag.axis==='y'?1:2;
  out[k]=p[k]+drag.tmp.t-drag.t0;
  return true;
}

// Writes the projected screen point into out [sx,sy,depth]; returns false behind the eye.
export function projectInto(view,w,h,x,y,z,out) {
  const rx=x-view.eye[0],ry=y-view.eye[1],rz=z-view.eye[2];
  const d=rx*view.look[0]+ry*view.look[1]+rz*view.look[2];
  if(!(d>1))return false;
  out[0]=((rx*view.right[0]+ry*view.right[1]+rz*view.right[2])/(TAN_HALF*view.aspect*d)+1)/2*w;
  out[1]=(1-(rx*view.up[0]+ry*view.up[1]+rz*view.up[2])/(TAN_HALF*d))/2*h;
  out[2]=d;return true;
}
