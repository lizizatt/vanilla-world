import test from 'node:test';
import assert from 'node:assert/strict';
import {FlightHud,flightHudVisible} from './flight-hud.js';
import {readFileSync} from 'node:fs';

test('instruments show when driving and hide in fly mode', () => {
  assert.equal(flightHudVisible(false),true);
  assert.equal(flightHudVisible(true),false);
});

test('setFlying toggles the data-fly flag the stylesheet hides on', () => {
  const root={dataset:{},querySelector:()=>({})};
  const hud=new FlightHud(root);
  hud.setFlying(true);assert.equal(root.dataset.fly,'true');
  hud.setFlying(false);assert.equal(root.dataset.fly,'false');
  assert.match(readFileSync(new URL('./style.css',import.meta.url),'utf8'),/#flight-hud\[data-fly="true"\]\s*\{\s*display:\s*none/);
});
