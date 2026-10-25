// Two resident engines (design/elune.md step D, user decision): one worker per body. The parent body's engine is "near" (collision, physics, near streaming); the other is "far" (horizon patches only) until the parent well swaps.
import {TILE_CAP_MIN,residentTileCap,BUDGET_FLOOR} from './memory-budget.js';

export const NEAR_SHARE=.8;

/** Memory split of one device budget: far engines get a fixed slice but never less than the floor needed for horizon patches. */
export function splitEngines(total,parent) {
  const far=Math.max(Math.floor(total*(1-NEAR_SHARE)),Math.min(BUDGET_FLOOR/2,total/2)),near=total-far;
  return {[parent]:{role:'near',bytes:near,tiles:residentTileCap(near)},[parent==='azeroth'?'elune':'azeroth']:{role:'far',bytes:far,tiles:0}};
}

/** Engine pair state: which body each worker serves and which one is near. */
export class EnginePair {
  constructor(total,parent='azeroth') {this.total=total;this.parent=parent;this.plan=splitEngines(total,parent);}
  /** Re-plan on a parent-well swap; returns the roles that changed so callers only send budget/role messages to engines that need them. */
  swap(parent) {
    if(parent===this.parent)return [];
    const before=this.plan;this.parent=parent;this.plan=splitEngines(this.total,parent);
    return Object.keys(this.plan).filter(id=>before[id].role!==this.plan[id].role||before[id].bytes!==this.plan[id].bytes);
  }
  /** Only the near engine steps physics. */
  steps(id){return this.plan[id].role==='near';}
}
export {TILE_CAP_MIN};
