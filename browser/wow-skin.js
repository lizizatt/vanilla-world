// Garage skins that are creature models read from the user's own WoW Data at runtime ('wow' source).
// Nothing is derived, cached or shipped: the worker decodes the M2 and its skin textures on demand.

const DRIVE_MIN_SPEED=.5,YARDS_PER_LOOP=4,MAX_LOOPS_PER_SECOND=3;

// Craft payload for the renderer's override slot: the M2 stand pose, display 0 as for any override.
export async function loadWowModel(client,skin) {
  const {asset,textures,metadata,frames}=await client.request('craft-model',{display:skin.display});
  if(!asset.indices.length)throw Error('model has no geometry');
  return {asset,textures,frames,flame:undefined,key:`wow:${skin.display}`,
    metadata:{...metadata,display:0,scale:skin.scale??metadata.scale,exhausts:[]}};
}

// Moving craft roll the Walk clip a fixed travel per loop (wheels follow the ground); a parked one plays Stand in real time.
export function advanceAnimation(anim,dt,speed) {
  const driving=Math.abs(speed)>DRIVE_MIN_SPEED;
  const rate=driving?Math.min(MAX_LOOPS_PER_SECOND,Math.abs(speed)/YARDS_PER_LOOP):0;
  return {driving,time:(anim?.time??0)+dt,phase:(((anim?.phase??0)+dt*rate*Math.sign(speed||1))%1+1)%1};
}

// Sampled pose for this animation state: Walk by travel phase, Stand by clock.
export function framePose(frames,anim) {
  const useDrive=anim.driving&&frames.drive,clip=useDrive?frames.drive:frames.idle,n=clip.poses.length;
  const loop=useDrive?anim.phase:(anim.time/clip.duration)%1;
  return clip.poses[Math.min(n-1,Math.floor(loop*n))];
}
