// Transport mechanics shared by the world, asset and far worker protocols. Domain payloads stay in each domain.
export const errorText=error=>String(error?.message||error);
/** Worker -> main failure fields: spread into a reply envelope next to its id. */
export const errorFields=error=>({error:errorText(error),code:error?.code});
/** Main-side Error rebuilt from a failure reply. */
export const replyError=data=>Object.assign(Error(data.error),{code:data.code});
export const isRequestId=id=>Number.isSafeInteger(id)&&id>0;

/** Id-keyed table of in-flight requests; an entry is any object with resolve/reject. */
export class RpcTable {
  constructor() {this.pending=new Map();this.serial=0;}
  get size() {return this.pending.size;}
  open(entry) {const id=++this.serial;this.pending.set(id,entry);return id;}
  /** Removes and returns the entry for a reply, or undefined for an unknown/stale id. */
  take(id) {
    const entry=this.pending.get(id);
    if(entry)this.pending.delete(id);
    return entry;
  }
  entries() {return this.pending.entries();}
  values() {return this.pending.values();}
  /** Settles every in-flight request (worker closed or failed) so no promise is left unresolved. */
  rejectAll(error) {
    const entries=[...this.pending.values()];
    this.pending.clear();
    for(const entry of entries)entry.reject(error);
  }
}
