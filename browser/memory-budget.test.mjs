import test from 'node:test';
import assert from 'node:assert/strict';
import {BudgetedCache,ByteBudget,RateMeter,deriveBudget,splitBudget,MIB,BUDGET_CAP,BUDGET_FLOOR,BUDGET_FALLBACK} from './memory-budget.js';

test('ByteBudget has hysteresis: nothing is owed until the limit is crossed, then it drains to the target',()=>{
  const b=new ByteBudget(100);b.add(85);
  assert.equal(b.deficit(10),0);
  assert.equal(b.deficit(20),15);
  assert.equal(b.target,90);
  assert.throws(()=>new ByteBudget(0));
});

test('BudgetedCache evicts farthest first, then least recently used, down to ~90%',()=>{
  const evicted=[],c=new BudgetedCache(100,{onEvict:k=>evicted.push(k)});
  for(let i=0;i<10;i++)assert(c.set(`t${i}`,i,10,{priority:i}));
  assert.equal(c.bytes,100);
  c.get('t9');
  assert(c.set('new',0,10,{priority:0}));
  assert.deepEqual(evicted,['t9','t8']);
  assert.equal(c.bytes,90);
});

test('equal priority falls back to LRU',()=>{
  const evicted=[],c=new BudgetedCache(30,{onEvict:k=>evicted.push(k)});
  c.set('a',1,10);c.set('b',2,10);c.set('c',3,10);c.get('a');
  c.set('d',4,10);
  assert.equal(evicted[0],'b');
});

test('pinned items are never evicted and oversize admission is refused',()=>{
  const c=new BudgetedCache(100);
  c.set('near',1,60,{pinned:true,priority:0});c.set('far',2,30,{priority:9});
  assert.equal(c.set('big',3,50),false);
  assert(c.has('near'));assert.equal(c.stats().rejected,1);
  assert.equal(c.set('mid',4,30,{priority:1}),true);
  assert(c.has('near')&&!c.has('far'));
});

test('lowering the limit trims the cache and keeps pins',()=>{
  const c=new BudgetedCache(100);
  c.set('p',1,40,{pinned:true});for(let i=0;i<6;i++)c.set(`x${i}`,i,10,{priority:i});
  c.setLimit(60);
  assert(c.bytes<=60);assert(c.has('p'));
});

// Synthetic drive: tiles along a road, each 8 bytes, view radius wants more than the budget holds.
function drive(limit,steps,wanted,{stationaryAfter=Infinity}={}){
  const c=new BudgetedCache(limit);let peak=0,loads=0;
  for(let s=0;s<steps;s++){
    const pos=Math.min(s,stationaryAfter)/4;
    const rank=Array.from({length:wanted*2+1},(_,i)=>Math.round(pos)-wanted+i)
      .map(t=>({t,d:Math.abs(t-pos)})).sort((a,b)=>a.d-b.d);
    for(const {t,d} of rank)if(c.has(`t${t}`))c.setPriority(`t${t}`,d);
    for(const {t,d} of rank){
      if(c.has(`t${t}`))continue;
      // Only admit a tile if it is nearer than what it would displace, so a full cache stops loading.
      const worst=[...c.items.values()].reduce((m,v)=>Math.max(m,v.priority),-1);
      if(!c.budget.fits(8)&&worst<=d)break;
      if(c.set(`t${t}`,0,8,{priority:d}))loads++;
      break;
    }
    peak=Math.max(peak,c.bytes);
  }
  return {c,peak,loads};
}

test('budget convergence: a long drive never exceeds the limit and hovers near it',()=>{
  const {c,peak}=drive(200,400,40);
  assert(peak<=200);
  assert(c.bytes>=200*0.85,`used ${c.bytes}`);
});

test('no thrash when stationary: no loads or evictions after settling',()=>{
  const settle=drive(200,300,40,{stationaryAfter:100});
  const more=drive(200,600,40,{stationaryAfter:100});
  assert.equal(more.loads,settle.loads);
  assert.equal(more.c.stats().evictions,settle.c.stats().evictions);
});

test('deriveBudget: setting, device memory, heap limit, fallback and bounds',()=>{
  assert.equal(deriveBudget({setting:'1024'}),1024*MIB);
  assert.equal(deriveBudget({setting:'99999'}),BUDGET_CAP);
  assert.equal(deriveBudget({setting:'1'}),BUDGET_FLOOR);
  assert.equal(deriveBudget({}),BUDGET_FALLBACK);
  assert.equal(deriveBudget({deviceMemory:8,heapLimit:8192*MIB}),Math.floor(8*1024*MIB*0.2));
  assert.equal(deriveBudget({deviceMemory:8,heapLimit:1000*MIB}),Math.floor(300*MIB));
  assert.equal(deriveBudget({deviceMemory:.25}),BUDGET_FLOOR);
  const s=splitBudget(1000);assert(s.scene+s.far+s.terrain<1000);
});

test('RateMeter reports evictions per second over its window',()=>{
  const r=new RateMeter(1000);
  assert.equal(r.sample(0,0),0);
  assert.equal(r.sample(5,100),5);
  assert.equal(r.sample(5,1200),0);
});
