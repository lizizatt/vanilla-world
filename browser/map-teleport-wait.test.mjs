import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {teleportPlan} from './elune-pose.js';

const src=readFileSync(new URL('./world-app.js',import.meta.url),'utf8');

test('map teleport waits for the target engine and falls back to the reload handoff instead of refusing',()=>{
  assert.ok(!/Cannot reach \$\{plan\.body\} yet/.test(src),'dead-end refusal message is gone');
  assert.match(src,/Preparing \$\{icon\.label\}/);
  assert.match(src,/app\.soiHandoff\(plan\.body,plan\.pose\)/);
});

test('teleport plan to another body swaps and carries a chart pose',()=>{
  const plan=teleportPlan({body:'elune',label:'Elune'},'azeroth');
  assert.equal(plan.swap,true);assert.equal(plan.pose.length,5);
  assert.equal(teleportPlan({label:'Orgrimmar'},'elune').swap,true);
});
