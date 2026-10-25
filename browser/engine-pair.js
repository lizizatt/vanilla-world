// Two resident engines (design/elune.md step D, user decision): one worker per body. The parent body's engine is "near" (collision, physics, near streaming); the other is "far" (horizon patches only) until the parent well swaps.
import {TILE_CAP_MIN,residentTileCap,BUDGET_FLOOR} from './memory-budget.js';
import {BODIES} from './bodies.js';

export const NEAR_SHARE=.8;

/** Memory split of one device budget over N bodies: the near engine gets NEAR_SHARE, the far engines split the rest evenly (each at least the floor needed for horizon patches, capped by an even split of the total). */
export function splitEngines(total,parent,ids=Object.keys(BODIES)) {
  const others=ids.filter(id=>id!==parent),each=others.length?Math.max(Math.floor(total*(1-NEAR_SHARE)/others.length),Math.min(BUDGET_FLOOR/2,Math.floor(total/ids.length))):0;
  const plan={[parent]:{role:'near',bytes:total-each*others.length,tiles:0}};
  plan[parent].tiles=residentTileCap(plan[parent].bytes);
  for(const id of others)plan[id]={role:'far',bytes:each,tiles:0};
  return plan;
}

/** Engine pair state: which body each worker serves and which one is near. */
export class EnginePair {
  constructor(total,parent='azeroth',ids=Object.keys(BODIES)) {this.total=total;this.parent=parent;this.ids=ids;this.plan=splitEngines(total,parent,ids);}
  /** Re-plan on a parent-well swap; returns the roles that changed so callers only send budget/role messages to engines that need them. */
  swap(parent) {
    if(parent===this.parent)return [];
    const before=this.plan;this.parent=parent;this.plan=splitEngines(this.total,parent,this.ids);
    return Object.keys(this.plan).filter(id=>before[id].role!==this.plan[id].role||before[id].bytes!==this.plan[id].bytes);
  }
  /** Only the near engine steps physics. */
  steps(id){return this.plan[id].role==='near';}
}
export {TILE_CAP_MIN};
