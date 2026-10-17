const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const unit=v=>{const length=Math.hypot(...v);return length?v.map(n=>n/length):[0,0,-1];};
const PITCH_LIMIT=89*Math.PI/180;

export function cameraView(rig,state,flight,dt,origin,settings={},lookBack=false) {
  if(rig.camera && rig.origin) {
    rig.camera[0]-=origin[0]-rig.origin[0];rig.camera[2]-=origin[1]-rig.origin[1];
  }
  rig.origin=origin;
  if(flight) {
    rig.camera=[flight[0]-origin[0],flight[1],flight[2]-origin[1]];
    return {look:[-Math.sin(flight[3])*Math.cos(flight[4]),Math.sin(flight[4]),-Math.cos(flight[3])*Math.cos(flight[4])],
      near:Math.max(.1,Math.min(100,Math.abs(flight[1])*.01)),collisionReady:true};
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
