// Pole flags (design/poles.md 9): Horde at the NORTH pole, Alliance at the SOUTH pole, on both Azeroth and Elune (Elune pairing is an assumption).
// The flag art is WoW data loaded at runtime through the normal doodad path (nothing WoW-derived is committed or baked); the pole mesh is procedural.
export const POLE_FLAGS=Object.freeze({
  N:Object.freeze({faction:'horde',model:'world\\generic\\pvp\\battlefieldbanners\\battlefieldbannerhorde.mdx',fallback:'world\\generic\\orc\\passive doodads\\hordebanners\\hordebanner02.mdx'}),
  S:Object.freeze({faction:'alliance',model:'world\\generic\\pvp\\battlefieldbanners\\battlefieldbanneralliance.mdx',fallback:'world\\generic\\human\\passive doodads\\banners\\stormwindlionbanner.mdx'}),
});
export const POLE_HEIGHT=14;// yd

/** Doodad placement at the exact pole (chart origin); `ground` is the terrain height there. */
export const poleFlagPlacement=(frame,ground=0)=>({...POLE_FLAGS[frame],position:[0,ground,0],yaw:0,scale:1,collision:{halfWidth:.4,height:POLE_HEIGHT}});

/** Procedural pole mesh: a 8-sided prism (positions, indices) of the given height/radius; a stand-in is a plain pole with no cloth. */
export function poleMesh(height=POLE_HEIGHT,radius=.18,sides=8) {
  const positions=[],indices=[];
  for(let i=0;i<sides;i++){const a=i/sides*Math.PI*2;positions.push(radius*Math.cos(a),0,radius*Math.sin(a),radius*Math.cos(a),height,radius*Math.sin(a));}
  for(let i=0;i<sides;i++){const a=i*2,b=((i+1)%sides)*2;indices.push(a,b,a+1,b,b+1,a+1);}
  return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
}
