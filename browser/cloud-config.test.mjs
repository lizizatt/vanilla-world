import test from 'node:test';
import assert from 'node:assert/strict';
import {TIERS,tier,CLOUD_TOWER,MAELSTROM,WHIRLPOOL_DIP,FUNNEL,FUNNEL_STEPS,CLOUD_THICKNESS} from './cloud-config.js';
import {cloudShader,cloudShaderHigh} from './clouds.js';
import {steps,slab,MIN_SPAN} from './cloud-march.js';

const num=(v,d=1)=>v.toFixed(d);

test('tier budgets are mirrored by the CPU march', () => {
  assert.equal(steps(false),TIERS.standard.steps);
  assert.equal(steps(true),TIERS.high.steps);
  assert.equal(MIN_SPAN,TIERS.standard.minSpan);
  assert.deepEqual(slab(true).up,CLOUD_TOWER.up);
  assert.equal(slab(false).up,0);
  assert.equal(tier(true),TIERS.high);
});

test('each tier shader carries its config constants', () => {
  for(const [high,src] of [[false,cloudShader],[true,cloudShaderHigh]]) {
    const t=tier(high);
    assert.match(src,new RegExp(`const NS=${t.steps};`));
    assert.match(src,new RegExp(`const NF=${FUNNEL_STEPS};`));
    assert.match(src,new RegExp(`const UP=${t.tower.up}\\.0;`));
    assert.match(src,new RegExp(`const DOWN=${t.tower.down}\\.0;`));
    assert.ok(src.includes(`max(${num(t.minSpan)},.3*s0)`));
    assert.ok(src.includes(`const THICK=${num(CLOUD_THICKNESS)};`));
  }
});

test('maelstrom, funnel and whirlpool radii reach the shader from one place', () => {
  assert.ok(cloudShader.includes(`exp(-r/${num(MAELSTROM.radius)})`));
  assert.ok(cloudShader.includes(`smoothstep(${num(MAELSTROM.eyeRadius)},${num(MAELSTROM.eyeRadius*1.5)},r)`));
  assert.ok(cloudShader.includes(`const SEA=${num(-WHIRLPOOL_DIP.depth)};`));
  assert.equal(FUNNEL.seaLevel,-WHIRLPOOL_DIP.depth);
});

test('configs are frozen', () => {
  assert.throws(()=>{'use strict';TIERS.high.steps=1;});
  assert.throws(()=>{'use strict';TIERS.standard.tower.up=1;});
});
