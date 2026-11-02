// Garage turntable: a small standalone WebGL2 view of one craft payload (the renderer's {asset,textures}), independent of the
// world's WebGPU renderer so opening the Garage never touches gameplay state. Vertices are 12 floats (position, normal, uv, rgba),
// model space is x forward, y left, z up. Everything GPU-side belongs to one canvas that dispose() empties and drops.
import {modelPath} from './scene-stream.js';

const STRIDE=12,FOV=.6,SPIN=.5,ELEVATION=.32,DRAG_SENSE=.01;

export function modelBounds(vertices) {
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i+2<vertices.length;i+=STRIDE)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],vertices[i+a]);hi[a]=Math.max(hi[a],vertices[i+a]);}
  if(!Number.isFinite(lo[0]))return {center:[0,0,0],radius:1};
  const center=lo.map((v,a)=>(v+hi[a])/2);
  return {center,radius:Math.max(1e-3,Math.hypot(...hi.map((v,a)=>v-lo[a]))/2)};
}

const sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=v=>{const l=Math.hypot(...v)||1;return v.map(n=>n/l);},dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

/** Column-major view-projection looking at the model's centre from `azimuth` around the z axis, with the eye direction and a camera-side light direction. */
export function previewCamera(bounds,azimuth,aspect) {
  const dir=[Math.cos(azimuth)*Math.cos(ELEVATION),Math.sin(azimuth)*Math.cos(ELEVATION),Math.sin(ELEVATION)];
  const dist=bounds.radius/Math.sin(FOV/2)*1.08,eye=bounds.center.map((c,i)=>c+dir[i]*dist);
  const f=norm(sub(bounds.center,eye)),s=norm(cross(f,[0,0,1])),u=cross(s,f);
  const view=[s[0],u[0],-f[0],0, s[1],u[1],-f[1],0, s[2],u[2],-f[2],0, -dot(s,eye),-dot(u,eye),dot(f,eye),1];
  const near=dist-bounds.radius*1.2,far=dist+bounds.radius*1.2,t=1/Math.tan(FOV/2);
  const proj=[t/aspect,0,0,0, 0,t,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0];
  const mvp=new Array(16).fill(0);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)mvp[c*4+r]+=proj[k*4+r]*view[c*4+k];
  return {mvp:Float32Array.from(mvp),light:norm([dir[0]*.8,dir[1]*.8,dir[2]*.8+.7])};
}

/** Opaque batches first, then blended ones in authored order; beam quads are animated effects and are skipped. */
export function drawOrder(batches) {
  const blended=b=>['alpha','add','mod','mod2x'].includes(b.blend);
  return [...batches.filter(b=>!blended(b)&&!b.beam),...batches.filter(b=>blended(b)&&!b.beam)];
}

const VS=`#version 300 es
layout(location=0) in vec3 aPos;layout(location=1) in vec3 aNormal;layout(location=2) in vec2 aUv;layout(location=3) in vec4 aColor;
uniform mat4 uMvp;out vec3 vN;out vec2 vUv;out vec4 vColor;
void main(){vN=aNormal;vUv=aUv;vColor=aColor;gl_Position=uMvp*vec4(aPos,1.0);}`;
const FS=`#version 300 es
precision mediump float;
in vec3 vN;in vec2 vUv;in vec4 vColor;uniform sampler2D uTex;uniform vec3 uLight;uniform float uCutoff,uEmissive,uTextured;out vec4 o;
void main(){vec4 t=uTextured>.5?texture(uTex,vUv):vec4(1.0);vec4 c=t*vColor;if(c.a<uCutoff)discard;
float l=uEmissive>.5?1.0:.42+.58*max(dot(normalize(vN),uLight),0.0);o=vec4(c.rgb*l,c.a);}`;

export class GaragePreview {
  constructor(host,payload,{doc=document,raf=f=>requestAnimationFrame(f),caf=id=>cancelAnimationFrame(id),now=performance.now.bind(performance)}={}) {
    this.canvas=doc.createElement('canvas');this.canvas.className='garage-preview-canvas';this.canvas.setAttribute('aria-hidden','true');
    this.host=host;this.raf=raf;this.caf=caf;this.now=now;this.textures=new Map();this.angle=.6;this.dragging=false;
    const gl=this.canvas.getContext('webgl2',{antialias:true,alpha:true,powerPreference:'low-power'});
    if(!gl)throw Error('WebGL2 unavailable');
    this.gl=gl;this.bounds=modelBounds(payload.asset.vertices);this.batches=drawOrder(payload.asset.batches);
    this.program=this.link();this.u=Object.fromEntries(['uMvp','uTex','uLight','uCutoff','uEmissive','uTextured'].map(n=>[n,gl.getUniformLocation(this.program,n)]));
    this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
    this.vbo=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.vbo);gl.bufferData(gl.ARRAY_BUFFER,payload.asset.vertices,gl.STATIC_DRAW);
    for(const [loc,size,offset] of [[0,3,0],[1,3,12],[2,2,24],[3,4,32]]){gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,STRIDE*4,offset);}
    this.ibo=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ibo);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,payload.asset.indices,gl.STATIC_DRAW);
    for(const t of payload.textures){
      const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,t.width,t.height,0,gl.RGBA,gl.UNSIGNED_BYTE,t.rgba);gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      this.textures.set(t.key,tex);
    }
    host.replaceChildren(this.canvas);
    this.onDown=e=>{this.dragging=true;this.lastX=e.clientX;this.canvas.setPointerCapture?.(e.pointerId);};
    this.onMove=e=>{if(this.dragging){this.angle-=(e.clientX-this.lastX)*DRAG_SENSE;this.lastX=e.clientX;}};
    this.onUp=()=>{this.dragging=false;};
    this.canvas.addEventListener('pointerdown',this.onDown);this.canvas.addEventListener('pointermove',this.onMove);
    this.canvas.addEventListener('pointerup',this.onUp);this.canvas.addEventListener('pointercancel',this.onUp);
    this.last=this.now();this.frame=this.raf(()=>this.tick());
  }
  link() {
    const gl=this.gl,program=gl.createProgram();
    for(const [type,src] of [[gl.VERTEX_SHADER,VS],[gl.FRAGMENT_SHADER,FS]]){
      const shader=gl.createShader(type);gl.shaderSource(shader,src);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(`Preview shader: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program,shader);gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(`Preview program: ${gl.getProgramInfoLog(program)}`);
    return program;
  }
  tick() {
    if(!this.gl)return;
    const t=this.now(),dt=Math.min(.1,(t-this.last)/1000);this.last=t;
    if(!this.dragging)this.angle+=dt*SPIN;
    this.draw();this.frame=this.raf(()=>this.tick());
  }
  draw() {
    const gl=this.gl,canvas=this.canvas,dpr=Math.min(2,globalThis.devicePixelRatio||1);
    const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);gl.bindVertexArray(this.vao);
    const cam=previewCamera(this.bounds,this.angle,w/h);
    gl.uniformMatrix4fv(this.u.uMvp,false,cam.mvp);gl.uniform3fv(this.u.uLight,cam.light);gl.uniform1i(this.u.uTex,0);
    for(const batch of this.batches) {
      const tex=batch.texture?this.textures.get(modelPath(batch.texture)):undefined,add=batch.blend==='add';
      if(batch.doubleSided){gl.disable(gl.CULL_FACE);}else{gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);}
      gl.depthMask(!batch.noDepthWrite&&!['alpha','add','mod','mod2x'].includes(batch.blend));
      gl.blendFunc(gl.SRC_ALPHA,add?gl.ONE:gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex??null);
      gl.uniform1f(this.u.uTextured,tex?1:0);gl.uniform1f(this.u.uCutoff,batch.alphaCutoff||0);gl.uniform1f(this.u.uEmissive,batch.emissive?1:0);
      gl.drawElements(gl.TRIANGLES,batch.indexCount,gl.UNSIGNED_INT,batch.firstIndex*4);
    }
  }
  /** Stops the loop and frees every GPU object, then the context itself; safe to call twice. */
  dispose() {
    const gl=this.gl;if(!gl)return;
    this.gl=undefined;this.caf(this.frame);
    this.canvas.removeEventListener('pointerdown',this.onDown);this.canvas.removeEventListener('pointermove',this.onMove);
    this.canvas.removeEventListener('pointerup',this.onUp);this.canvas.removeEventListener('pointercancel',this.onUp);
    for(const tex of this.textures.values())gl.deleteTexture(tex);
    this.textures.clear();gl.deleteBuffer(this.vbo);gl.deleteBuffer(this.ibo);gl.deleteVertexArray(this.vao);gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}
