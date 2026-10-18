const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const unit=v=>{const length=Math.hypot(...v);return length?v.map(n=>n/length):[0,0,-1];};
const PITCH_LIMIT=89*Math.PI/180;

export function craftMatrix(state,origin,scale) {
  const c=Math.cos(state[3]),s=Math.sin(state[3]),cb=Math.cos(state[4]),sb=Math.sin(state[4]);
  const m=new Float32Array(16);
  for(const [column,v] of [[0,[0,0,-1]],[1,[-1,0,0]],[2,[0,1,0]]]){
    const x=v[0]*cb-v[1]*sb,y=v[0]*sb+v[1]*cb,z=v[2];
    m.set([(x*c+z*s)*scale,y*scale,(-x*s+z*c)*scale,0],column*4);
  }
  m.set([state[0]-origin[0],state[1],state[2]-origin[1],1],12);
  return m;
}
export function cockpitAnchor(metadata) {
  const seat=metadata.posedAttachment0;
  if(!seat)return undefined;
  if(seat.space!=='model-local'||seat.pose!=='stand-frame-0'||!Array.isArray(seat.position)||
    seat.position.length!==3||!seat.position.every(Number.isFinite))throw Error('Invalid posed cockpit seat');
  // Functional eye height above the authored seat, not a selected avatar's animated head.
  return [seat.position[0],seat.position[1],seat.position[2]+.75];
}

export function cameraView(rig,state,flight,dt,origin,settings={},lookBack=false) {
  if(rig.camera && rig.origin) {
    rig.camera[0]-=origin[0]-rig.origin[0];rig.camera[2]-=origin[1]-rig.origin[1];
  }
  rig.origin=origin;
  const mode=flight?'fly':settings.cockpit&&rig.craft?.anchor&&rig.clipCamera?'cockpit':'chase';
  if(rig.cameraMode!==undefined && mode!==rig.cameraMode)rig.camera=undefined;
  rig.cameraMode=mode;
  if(flight) {
    rig.camera=[flight[0]-origin[0],flight[1],flight[2]-origin[1]];
    return {look:[-Math.sin(flight[3])*Math.cos(flight[4]),Math.sin(flight[4]),-Math.cos(flight[3])*Math.cos(flight[4])],
      near:Math.max(.1,Math.min(100,Math.abs(flight[1])*.01)),collisionReady:true};
  }
  if(mode==='cockpit') {
    if(!rig.camera || !rig.cockpitLook || lookBack!==rig.lookBack)rig.cockpitLook=[0,0];
    const look=settings.cameraLook||[0,0],orbit=settings.cameraOrbit||[0,0];
    if(look.some(Boolean)||orbit.some(Boolean)){
      rig.cockpitLook[0]=wrap(rig.cockpitLook[0]-look[0]*Math.PI*dt-orbit[0]*.004);
      rig.cockpitLook[1]=Math.max(-PITCH_LIMIT,Math.min(PITCH_LIMIT,rig.cockpitLook[1]+look[1]*Math.PI/2*dt-orbit[1]*.004));
    } else {
      const follow=Math.exp(-7*Math.max(0,dt));
      rig.cockpitLook=rig.cockpitLook.map(n=>n*follow);
    }
    rig.lookBack=lookBack;
    const matrix=craftMatrix(state,origin,rig.craft.metadata.scale),anchor=rig.craft.anchor;
    const transform=v=>[0,1,2].map(i=>matrix[i]*v[0]+matrix[4+i]*v[1]+matrix[8+i]*v[2]);
    const eye=transform(anchor).map((n,i)=>n+matrix[12+i]);
    const pivot=[state[0]-origin[0],state[1],state[2]-origin[1]];
    rig.camera=rig.clipCamera(pivot,eye,origin);
    const heading=rig.cockpitLook[0]+(lookBack?Math.PI:0),pitch=rig.cockpitLook[1];
    return {look:unit(transform([Math.cos(heading)*Math.cos(pitch),Math.sin(heading)*Math.cos(pitch),Math.sin(pitch)])),
      up:unit(Array.from(matrix.slice(8,11))),near:.1,collisionReady:true};
  }
  const reset=!rig.camera,yaw=state[3]+(lookBack?Math.PI:0),pitch=-Math.atan(.3);
  const look=settings.cameraLook || [0,0],orbit=settings.cameraOrbit || [0,0];
  if(reset || !rig.chase || lookBack!==rig.lookBack)rig.chase=[yaw,pitch];
  else if(look.some(Boolean) || orbit.some(Boolean)) {
    rig.chase[0]=wrap(rig.chase[0]-look[0]*Math.PI*dt-orbit[0]*.004);
    rig.chase[1]=Math.max(-PITCH_LIMIT,Math.min(PITCH_LIMIT,rig.chase[1]+look[1]*Math.PI/2*dt-orbit[1]*.004));
  } else {
    const follow=-Math.expm1(-7*Math.max(0,dt));
    rig.chase[0]=wrap(rig.chase[0]+wrap(yaw-rig.chase[0])*follow);
    rig.chase[1]+=(pitch-rig.chase[1])*follow;
  }
  rig.lookBack=lookBack;
  const distance=settings.cameraDistance ?? 15,seconds=settings.cameraSeconds ?? .5;
  const [heading,tilt]=rig.chase,pivot=[state[0]-origin[0],state[1]+3,state[2]-origin[1]];
  const direction=[Math.sin(heading)*Math.cos(tilt),-Math.sin(tilt),Math.cos(heading)*Math.cos(tilt)];
  const clip=point=>rig.clipCamera?rig.clipCamera(pivot,point,origin):point;
  const wanted=clip(pivot.map((n,i)=>n+direction[i]*Math.max(0,distance-.15)));
  const blend=reset || seconds===0?1:-Math.expm1(-Math.max(0,dt)/seconds);
  rig.camera=clip(reset?wanted:rig.camera.map((n,i)=>n+(wanted[i]-n)*blend));
  const offset=pivot.map((n,i)=>n-rig.camera[i]);
  return {look:Math.hypot(...offset)>1e-6?unit(offset):direction.map(n=>-n),near:.1,collisionReady:!!rig.clipCamera};
}
