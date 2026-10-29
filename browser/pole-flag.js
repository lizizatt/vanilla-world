// Pole flags (design/poles.md 9): Horde at the NORTH pole, Alliance at the SOUTH pole, on both Azeroth and Elune (Elune pairing is an assumption).
// The flag art is WoW data loaded at runtime through the normal doodad path (nothing WoW-derived is committed or baked); the pole mesh is procedural.
export const POLE_FLAGS=Object.freeze({
  N:Object.freeze({faction:'horde',model:'world\\generic\\pvp\\battlefieldbanners\\battlefieldbannerhorde.m2',fallback:'world\\generic\\orc\\passive doodads\\hordebanners\\hordebanner02.mdx'}),
  S:Object.freeze({faction:'alliance',model:'world\\generic\\pvp\\battlefieldbanners\\battlefieldbanneralliance.m2',fallback:'world\\generic\\human\\passive doodads\\banners\\stormwindlionbanner.mdx'}),
});
export const POLE_HEIGHT=14;// yd

/** Doodad placement at the exact pole (chart origin); `ground` is the terrain height there. */
export const poleFlagPlacement=(frame,ground=0)=>({...POLE_FLAGS[frame],position:[0,ground,0],yaw:0,scale:1,collision:{halfWidth:.4,height:POLE_HEIGHT}});

const u32=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v,true);return b;};
/** ADT doodad chunks (MMDX/MMID/MDDF) that stand the faction banner at the chart origin of a pole tile. `tile` is the tile column/row whose north-west corner is the pole; the model loads from the user's own data at runtime. */
export function poleFlagChunks(frame,ground,tile,tileSize=1600/3) {
  const flag=POLE_FLAGS[frame],name=new TextEncoder().encode(flag.model+'\0'),mddf=new Uint8Array(36),v=new DataView(mddf.buffer);
  v.setUint32(0,0,true);v.setUint32(4,frame==='N'?0x504f4c4e:0x504f4c53,true);
  v.setFloat32(8,tile*tileSize,true);v.setFloat32(12,ground,true);v.setFloat32(16,tile*tileSize,true);
  v.setUint16(32,1024,true);
  return [['MMDX',name],['MMID',u32(0)],['MDDF',mddf]];
}

/** Procedural pole mesh: a 8-sided prism (positions, indices) of the given height/radius; a stand-in is a plain pole with no cloth. */
export function poleMesh(height=POLE_HEIGHT,radius=.18,sides=8) {
  const positions=[],indices=[];
  for(let i=0;i<sides;i++){const a=i/sides*Math.PI*2;positions.push(radius*Math.cos(a),0,radius*Math.sin(a),radius*Math.cos(a),height,radius*Math.sin(a));}
  for(let i=0;i<sides;i++){const a=i*2,b=((i+1)%sides)*2;indices.push(a,b,a+1,b,b+1,a+1);}
  return {positions:new Float32Array(positions),indices:new Uint16Array(indices)};
}
