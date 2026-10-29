import {RpcTable,errorFields,replyError} from './worker-rpc.js';

export class AssetSource {
  constructor(worker) {
    this.worker=worker;this.table=new RpcTable();this.stats={};
    worker.onmessage=({data})=>{
      if(['progress','loading-art','loading-art-warning'].includes(data.event)){this.onProgress?.(data);return;}
      const request=this.table.take(data.id);
      if(!request)return;
      if(data.stats)this.stats=data.stats;
      try {
        if(data.error)request.reject(replyError(data));
        else if(request.shouldDefer?.())request.reject(Object.assign(Error('Obsolete background resource'),{code:'DEFERRED'}));
        else request.resolve(data.result);
      } catch(error){request.reject(error);}
      finally {this.post({action:'ack',id:data.id});}
    };
    worker.onerror=event=>{event.preventDefault?.();this.fail(Error(`Asset worker: ${event.message}`));};
    worker.onmessageerror=()=>this.fail(Error('Asset worker message could not be decoded'));
  }
  post(data,transfers=[]) {
    if(this.error)return;
    try {this.worker.postMessage(data,transfers);}
    catch(error){this.fail(error);}
  }
  request(action,fields={},shouldDefer,transfers=[]) {
    if(this.error)return Promise.reject(this.error);
    if(shouldDefer?.())return Promise.reject(Object.assign(Error('Background resource deferred'),{code:'DEFERRED'}));
    return new Promise((resolve,reject)=>{
      const id=this.table.open({resolve,reject,shouldDefer,cancelled:false});
      this.post({action,id,...fields},transfers);
    });
  }
  read(path,{background=false,shouldDefer}={}) {
    return this.request('read',{path,background},shouldDefer);
  }
  readTexture(path,output='rgba',shouldDefer) {
    return this.request('texture',{path,background:true,output},shouldDefer);
  }
  prepareDetail(detail,shouldDefer) {
    return this.request('detail',{detail,background:true},shouldDefer,
      [...detail.tiles,...detail.seams].map(t=>t.vertices.buffer));
  }
  refresh() {
    for(const [id,request] of this.table.entries())if(!request.cancelled&&request.shouldDefer?.()){
      request.cancelled=true;this.post({action:'cancel',id});
    }
  }
  fail(error) {
    this.error=error;this.worker.terminate();
    this.table.rejectAll(error);
  }
  close(){this.fail(Object.assign(Error('Data source closed'),{code:'CLOSED'}));}
  stopLoadingArt(){this.post({action:'stop-art'});}
}

export async function openAssetSource(folder,createWorker=()=>new Worker('./asset-worker.js',{type:'module'}),onProgress,{loadingArt=false,map,graft}={}) {
  const source=new AssetSource(createWorker());
  source.onProgress=onProgress;
  try {Object.assign(source,await source.request('open',{folder,loadingArt,map,graft}));return source;}
  catch(error){source.close();throw error;}
}
