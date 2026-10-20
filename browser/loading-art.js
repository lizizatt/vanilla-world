export function loadingScreen(bytes,map) {
  if(!(bytes instanceof Uint8Array)||bytes.length<20||bytes.length>1024*1024||
    String.fromCharCode(...bytes.subarray(0,4))!=='WDBC')throw Error('Invalid loading-screen DBC');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint32(4,true),
    fields=view.getUint32(8,true),stride=view.getUint32(12,true),strings=view.getUint32(16,true),base=20+count*stride;
  if(!count||count>4096||fields!==3||stride!==12||!strings||base+strings!==bytes.length)
    throw Error('Unsupported loading-screen DBC layout');
  const text=offset=>{
    if(offset>=strings)throw Error('Loading-screen string is out of bounds');
    const end=bytes.indexOf(0,base+offset);
    if(end<0)throw Error('Unterminated loading-screen string');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(base+offset,end));
  };
  const rows=Array.from({length:count},(_,i)=>({
    name:text(view.getUint32(24+i*stride,true)),path:text(view.getUint32(28+i*stride,true)),
  })).filter(row=>row.path);
  for(const row of rows)if(row.path.length>1024||!/^interface[\\/]glues[\\/]loadingscreens[\\/][^\\/:]+\.blp$/i.test(row.path))
    throw Error('Invalid loading-screen image path');
  const selected=rows.find(row=>row.name.toLowerCase()===map?.toLowerCase())||rows[0];
  if(!selected)throw Error('No loading-screen artwork in DBC');
  return selected;
}

export async function loadLoadingArt(source,decode,emit,stopped,map) {
  let screen;
  try {screen=loadingScreen(await source.read('DBFilesClient\\LoadingScreens.dbc'),map);}
  catch(error){
    if(!stopped())emit({event:'loading-art-warning',message:`Loading artwork: ${error.message||error}`});
    return;
  }
  const images=[['screen',screen.path],...['Background','Fill','Border'].map(part=>
    [part.toLowerCase(),`Interface\\Glues\\LoadingBar\\Loading-Bar${part}.blp`])];
  for(const [kind,path] of images)while(!stopped()){
    try {
      const bytes=await source.read(path,{background:true,shouldDefer:stopped});
      if(stopped())return;
      if(bytes.byteLength>8*1024*1024)throw Error('Loading artwork exceeds 8 MiB encoded limit');
      const image=decode(bytes);
      if(!Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<1||image.height<1||
        image.width>2048||image.height>2048||image.rgba.length!==image.width*image.height*4)
        throw Error('Invalid loading artwork dimensions');
      if(!stopped())emit({event:'loading-art',kind,...image});
      break;
    } catch(error){
      if(stopped())return;
      if(error.code==='DEFERRED'){await new Promise(resolve=>setTimeout(resolve,25));continue;}
      emit({event:'loading-art-warning',message:`Loading ${kind} artwork: ${error.message||error}`});
      break;
    }
  }
}

export class LoadingArt {
  constructor(screen,bar,dialog) {this.screen=screen;this.bar=bar;this.dialog=dialog;this.parts=new Map();}
  event(data) {
    if(!this.dialog.open)return;
    const {width,height,rgba,kind}=data;
    if(!['screen','background','fill','border'].includes(kind)||!Number.isInteger(width)||!Number.isInteger(height)||
      width<1||height<1||width>2048||height>2048||!(rgba instanceof Uint8Array)||rgba.length!==width*height*4)
      throw Error('Invalid loading artwork payload');
    const canvas=kind==='screen'?this.screen:this.screen.ownerDocument.createElement('canvas');
    canvas.width=width;canvas.height=height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer,rgba.byteOffset,rgba.byteLength),width,height),0,0);
    if(kind==='screen'){canvas.hidden=false;this.dialog.classList.add('has-loading-art');}
    else {this.parts.set(kind,canvas);this.progress(this.completed,this.total);}
  }
  progress(completed,total) {
    this.completed=completed;this.total=total;
    if(!this.parts.has('border')||!this.parts.has('fill')||!this.parts.has('background'))return;
    const border=this.parts.get('border'),canvas=this.bar;
    canvas.width=border.width;canvas.height=border.height;
    const context=canvas.getContext('2d'),draw=kind=>context.drawImage(this.parts.get(kind),0,0,canvas.width,canvas.height);
    draw('background');
    if(Number.isFinite(total)&&total>0&&Number.isFinite(completed)){
      context.save();context.beginPath();context.rect(0,0,canvas.width*Math.max(0,Math.min(1,completed/total)),canvas.height);
      context.clip();draw('fill');context.restore();
    }
    draw('border');canvas.hidden=false;this.dialog.classList.add('has-loading-bar');
  }
  clear() {
    for(const canvas of [this.screen,this.bar,...this.parts.values()]){canvas.width=canvas.height=0;canvas.hidden=true;}
    this.parts.clear();this.completed=this.total=undefined;
    this.dialog.classList.remove('has-loading-art','has-loading-bar');
  }
}
