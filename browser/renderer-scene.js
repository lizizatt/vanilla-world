import {modelPath} from './scene-stream.js';
import {renderMatrix} from './renderer-helpers.js';
export function scenePipeline(r,batch) {
  const blend=batch.blend,key=`${blend}:${!!batch.doubleSided}:${!!batch.noDepthWrite}`;
  if(r.pipelines.has(key))return r.pipelines.get(key);
  let colorBlend;
  if(blend==='alpha')colorBlend={color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
  if(blend==='add')colorBlend={color:{srcFactor:'src-alpha',dstFactor:'one'},alpha:{srcFactor:'one',dstFactor:'one'}};
  if(blend==='mod')colorBlend={color:{srcFactor:'dst',dstFactor:'zero'},alpha:{srcFactor:'zero',dstFactor:'one'}};
  if(blend==='mod2x')colorBlend={color:{srcFactor:'dst',dstFactor:'src'},alpha:{srcFactor:'zero',dstFactor:'one'}};
  const pipeline=r.device.createRenderPipeline({
    layout:r.scenePipelineLayout,vertex:{module:r.sceneModule,entryPoint:'vs',buffers:[{arrayStride:48,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32x4'}]}]},
    fragment:{module:r.sceneModule,entryPoint:'fs',targets:[{format:r.format,...(colorBlend?{blend:colorBlend}:{})}]},
    primitive:{topology:'triangle-list',cullMode:batch.doubleSided?'none':'back'},
    depthStencil:{format:'depth24plus',depthWriteEnabled:!batch.noDepthWrite && !colorBlend,depthCompare:'less'},
  });
  r.pipelines.set(key,pipeline);return pipeline;
}
export function prepareBatches(r,batches) {
  return batches.map(batch=>{
    if(batch.water!==undefined&&typeof batch.water!=='boolean')throw Error('Invalid scene water flag');
    return {...batch,texture:batch.texture?modelPath(batch.texture):null,
      transparent:['alpha','add','mod','mod2x'].includes(batch.blend),pipeline:r.scenePipeline(batch)};
  });
}
export function sceneMatrix(r,instance,region,origin) {
  const cached=instance.rendered;
  if(!cached || cached.source!==instance.matrix || cached.region!==region ||
    cached.x!==origin[0] || cached.z!==origin[1])
    instance.rendered={source:instance.matrix,region,x:origin[0],z:origin[1],matrix:renderMatrix(instance.matrix,region,origin)};
  return instance.rendered.matrix;
}
export function drawScene(r,pass,draws) {
  const firstTransparent=draws.findIndex(draw=>draw.batch.transparent);
  const count=firstTransparent<0?draws.length:firstTransparent,cached=r.sceneBundle;
  const encode=(encoder,{asset,batch,item,pipeline})=>{
    encoder.setPipeline(pipeline);encoder.setBindGroup(0,item.group,[item.offset]);
    encoder.setVertexBuffer(0,asset.vertices);encoder.setIndexBuffer(asset.indices,'uint32');
    encoder.drawIndexed(batch.indexCount,1,batch.firstIndex);
  };
  if(!cached || cached.draws.length!==count || cached.draws.some((draw,i)=>
    draw.asset!==draws[i].asset || draw.batch!==draws[i].batch || draw.item!==draws[i].item ||
    draw.offset!==draws[i].item.offset)) {
    const encoder=r.device.createRenderBundleEncoder({colorFormats:[r.format],depthStencilFormat:'depth24plus'});
    for(let i=0;i<count;i++)encode(encoder,draws[i]);
    r.sceneBundle={draws:draws.slice(0,count).map(({asset,batch,item})=>({asset,batch,item,offset:item.offset})),
      bundle:encoder.finish()};
    r.sceneBundleBuilds++;
  }
  pass.executeBundles([r.sceneBundle.bundle]);
  // Transparent batches retain their camera-dependent back-to-front order.
  for(let i=count;i<draws.length;i++)encode(pass,draws[i]);
}
