// On-demand PREVIEW renders of the race start gantry (A), checkpoint gate (C) and overworld flag-beacon at the Steamwheedle start.
// Local-asset versions need SWE1R_DATA + WOW_DATA; hosted versions are procedural. Output (git-ignored): runtime/gate-preview/p-*.png + preview-sheet.png
//   $env:WOW_DATA=...; $env:SWE1R_DATA=...; $env:PORT=4183; node race-gate-preview-shots.mjs
import fs from 'node:fs';
import path from 'node:path';
import { openLab, track, out, camera } from './race-gate-lab.mjs';

// TEXTURED=1: local versions only, with WoW textures on the procedural parts (t-*.png + textured-sheet.png before/after vs the p-* run).
const TEXTURED = process.env.TEXTURED === '1', PFX = TEXTURED ? 't' : 'p';
const { ctx, page, errors } = await openLab();
const { pos, yaw } = track.start, f = [-Math.sin(yaw), -Math.cos(yaw)];
const ahead = d => [pos[0] + f[0] * d, pos[1], pos[2] + f[1] * d];
const WOW = {
  pole: 'World\\Generic\\Human\\Passive Doodads\\FlagPole\\Flagpole01.m2',
  banner: 'World\\Generic\\PVP\\BattlefieldBanners\\BattlefieldBannerHorde.m2',
  brazier: 'World\\Generic\\Orc\\Passive Doodads\\Braziers\\TallBrazier01.m2',
};

// Palette: wood/iron/stone for the gantry, brazier metal + lightning zap for checkpoints, stone + neutral flag cloth for the label.
const TEX = {
  wood: 'World\\Generic\\Orc\\Passive Doodads\\HordeBanners\\ns_wood01.blp', iron: 'Dungeons\\Textures\\Decoration\\mm_wroughtiron_01.blp',
  stone: 'Dungeons\\Textures\\Trim\\mm_duskwood_stonebase_01.blp', metal: 'Dungeons\\Textures\\Carlo\\MedBrazier01.blp',
  zap: 'Spells\\zap1.blp', flag: 'World\\Generic\\PVP\\BattlefieldBanners\\PvPNeutralBannerFlag.blp',
};
await page.evaluate(async ([WOW, TEX, TEXTURED]) => {
  const real = window.__real = {};
  for (const [k, p] of Object.entries(WOW)) real[k] = await worldTest.propModel(p);
  const lens = await worldTest.swe1rModel(309, 1 / 600);
  real.lens = { asset: lens.asset, textures: lens.textures, k: 2.4 / 57.2 };
  window.__gp = await import('/race-gate-preview.js');
  if (TEXTURED) { real.tex = {}; for (const [k, p] of Object.entries(TEX)) real.tex[k] = await worldTest.propTexture(p); }
}, [WOW, TEX, TEXTURED]);

const show = (kind, local, at, o = {}) => page.evaluate(([kind, local, at, yaw, o]) => {
  const g = window.__gp, args = { at, yaw, real: local ? window.__real : undefined, ...o };
  worldTest.props({ A: g.gantry, C: g.checkpoint, L: g.beacon }[kind](args));
}, [kind, local, at, yaw, o]);

const shots = [];
const snap = async (name, label) => {
  await page.waitForTimeout(1500);
  const file = path.join(out, `${PFX}-${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ file, label });
};
const look = async (at, d, h, pitch = -.08, side = 0) => { await page.evaluate(c => worldTest.focus(c), camera(at, yaw + side, d, h, pitch)); };

const behind = (at, d, h, pitch) => page.evaluate(c => worldTest.focus(c), [at[0] - f[0] * d, at[1] + h, at[2] - f[1] * d, yaw, pitch]);
const views = { A: [[24, 7], [70, 12], [220, 25]], C: [[24, 7], [70, 12], [220, 25]], L: [[45, 8], [160, 22], [420, 70, -.02, 'back']] };
const variants = TEXTURED ? [true] : [true, false];
for (const kind of ['A', 'C', 'L']) for (const local of variants) {
  const at = ahead(kind === 'L' ? 30 : 40), v = local ? 'local' : 'hosted';
  await show(kind, local, at);
  for (const [i, [d, h, p, back]] of views[kind].entries()) { await (back ? behind(at, d, h, p) : look(at, d, h, p)); await snap(`${kind}-${v}-${['near', 'mid', 'far'][i]}`, `${kind} ${v} ${['near', 'mid', 'far'][i]}`); }
  await look(at, 13, 1, 0); await snap(`${kind}-${v}-ground`, `${kind} ${v} ground-level (fade)`);
}
for (const phase of [1, 2, 3]) for (const local of variants) {
  const at = ahead(40); await show('A', local, at, { phase }); await look(at, 20, 11, -.05);
  await snap(`A-${local ? 'local' : 'hosted'}-lights${phase}`, `A ${local ? 'local' : 'hosted'} lights ${['red', 'amber', 'green'][phase - 1]}`);
}
await show('C', true, ahead(40), { state: 'passed' }); await look(ahead(40), 40, 8); await snap('C-local-passed', 'C local passed (dim)');

const skins = await page.evaluate(async () => (await import('/swe1r/skin.js')).podSkinList().slice(0, 2).map(s => s.id));
for (const [name, vehicle] of [['rocket', { vehicle: 'podracer', skin: 'rocket' }], ['pod', { vehicle: 'podracer', skin: skins[1] }]]) {
  await page.evaluate(([v, p, y]) => { worldTest.selectVehicle(v);   worldTest.restore([p[0], p[1] + 1, p[2], y]); }, [vehicle, pos, yaw + Math.PI]);
    await page.waitForTimeout(4000);
    await page.evaluate(([at, y, o]) => worldTest.props(window.__gp.gantry({ at, yaw: y, real: window.__real, phase: 3 })), [ahead(-150), yaw + Math.PI]);
    await page.keyboard.down('KeyW'); await page.waitForTimeout(2200);
  const file = path.join(out, `${PFX}-craft-${name}.png`);
  await page.screenshot({ path: file }); shots.push({ file, label: `A local with ${name} at speed` });
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
}

if (TEXTURED) { // before/after: each textured shot next to its untextured p-* twin
  const pair = shots.flatMap(s => { const b = path.join(path.dirname(s.file), path.basename(s.file).replace(/^t-/, 'p-')); return [...(fs.existsSync(b) ? [{ file: b, label: 'before ' + s.label }] : []), { ...s, label: 'AFTER ' + s.label }]; });
  shots.splice(0, shots.length, ...pair);
}
const imgs = shots.map(s => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/png;base64,${fs.readFileSync(s.file).toString('base64')}"><figcaption>${s.label}</figcaption></figure>`).join('');
const sheet = await ctx.newPage();
await sheet.setViewportSize({ width: 2400, height: 1000 });
await sheet.setContent(`<body style="margin:0;background:#111;color:#ffd24a;font:16px Arial"><div style="display:grid;grid-template-columns:repeat(${TEXTURED ? 4 : 5},1fr);gap:4px">${imgs}</div>`);
await sheet.screenshot({ path: path.join(out, TEXTURED ? 'textured-sheet.png' : 'preview-sheet.png'), fullPage: true });
console.log(`${shots.length} shots; sheet: ${path.join(out, TEXTURED ? 'textured-sheet.png' : 'preview-sheet.png')}`);
console.log(errors.length ? `page errors: ${[...new Set(errors)].join('; ')}` : 'ok');
await ctx.close();
