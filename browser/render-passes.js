// Single table for depth state across the frame. Pipelines take their depthStencil from DEPTH_STATE; render passes
// take their depth attachment from depthAttachment(). Order of the frame:
//   main (clear): sky, dome, space/planet, patches, terrain, scene -> shadows, clouds (colour only, scene depth read in shader)
//   props (depth load) -> fx (depth read-only).
export const DEPTH_FORMAT='depth24plus';
export const DEPTH_CLEAR=1;

// name: [depthWriteEnabled, depthCompare]
const STATE={
  terrain:[true,'less'],
  splat:[true,'less'],
  scene:[true,'less'],
  particles:[false,'less'],
  sky:[false,'always'],
  dome:[false,'always'],
  space:[true,'always'],
  patch:[true,'less-equal'],
  other:[false,'less-equal'],
};

export const DEPTH_STATE=Object.freeze(Object.fromEntries(Object.entries(STATE).map(([name,[depthWriteEnabled,depthCompare]])=>
  [name,Object.freeze({format:DEPTH_FORMAT,depthWriteEnabled,depthCompare})])));

/** Depth state for a pipeline; `write` overrides the table's write flag (scene batches without depth write). */
export const depthState=(name,write)=>write===undefined?DEPTH_STATE[name]:{...DEPTH_STATE[name],depthWriteEnabled:write};

const ATTACHMENT={
  main:{depthClearValue:DEPTH_CLEAR,depthLoadOp:'clear',depthStoreOp:'store'},
  props:{depthLoadOp:'load',depthStoreOp:'store'},
  fx:{depthReadOnly:true},
};
export const depthAttachment=(pass,view)=>({view,...ATTACHMENT[pass]});

export const depthTexture=(device,width,height)=>device.createTexture({size:[width,height],format:DEPTH_FORMAT,
  usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
export const bundleFormats=format=>({colorFormats:[format],depthStencilFormat:DEPTH_FORMAT});
