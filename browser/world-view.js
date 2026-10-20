const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

export function validateView(view) {
  if(!view || !['eye','right','up','look'].every(key=>Array.isArray(view[key])&&view[key].length===3&&
    view[key].every(v=>Number.isFinite(v)&&Math.abs(v)<1e12)) ||
    !Number.isFinite(view.aspect)||view.aspect<=0 ||
    !['right','up','look'].every(key=>Math.abs(Math.hypot(...view[key])-1)<.01))
    throw Error('Invalid world view');
}

export function viewChanged(previous,next) {
  if(!previous||!next)return previous!==next;
  const angle=.04*Math.min(1,next.aspect,1/next.aspect);
  return previous.aspect!==next.aspect ||
    Math.hypot(...next.eye.map((v,i)=>v-previous.eye[i]))>=16 ||
    ['right','up','look'].some(key=>Math.hypot(...next[key].map((v,i)=>v-previous[key][i]))>=angle);
}

export function sceneVisible(bounds,m,eye,right,up,forward,aspect,margin=.01,slopeScale=.55) {
  if(!bounds)return true;
  const lo=bounds[0],hi=bounds[1],hx=(hi[0]-lo[0])/2,hy=(hi[1]-lo[1])/2,hz=(hi[2]-lo[2])/2;
  const x=lo[0]+hx,y=lo[1]+hy,z=lo[2]+hz;
  const cx=m[0]*x+m[4]*y+m[8]*z+m[12]-eye[0],
    cy=m[1]*x+m[5]*y+m[9]*z+m[13]-eye[1],
    cz=m[2]*x+m[6]*y+m[10]*z+m[14]-eye[2];
  for(let plane=0;plane<5;plane++){
    const axis=plane===0?forward:plane<3?right:up,sign=plane===0?1:plane%2?-1:1,
      slope=plane===0?0:slopeScale*(plane<3?aspect:1);
    const nx=axis[0]*sign+forward[0]*slope,ny=axis[1]*sign+forward[1]*slope,nz=axis[2]*sign+forward[2]*slope;
    const radius=hx*Math.abs(nx*m[0]+ny*m[1]+nz*m[2])+hy*Math.abs(nx*m[4]+ny*m[5]+nz*m[6])
      +hz*Math.abs(nx*m[8]+ny*m[9]+nz*m[10]);
    if(cx*nx+cy*ny+cz*nz+radius<-margin)return false;
  }
  return true;
}

export function boundsVisible(bounds,view) {
  // The guard covers cached-view movement/rotation until viewChanged refreshes it.
  return !view || sceneVisible(bounds,IDENTITY,view.eye,view.right,view.up,view.look,view.aspect,
    32*Math.hypot(1,.66*Math.max(1,view.aspect)),.66);
}
