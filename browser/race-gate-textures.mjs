// Texture scout: lists the textures of candidate M2s and checks guessed BLP paths. Needs WOW_DATA and a server on PORT.
import { openLab } from './race-gate-lab.mjs';

const models = (process.env.WOW || '').split(';').filter(Boolean);
const guesses = (process.env.TEX || '').split(';').filter(Boolean);
const { ctx, page } = await openLab({ swe1r: false });
for (const m of models) console.log(m.split('\\').pop(), await page.evaluate(async p => (await worldTest.propModel(p)).textures.map(t => `${t.key} ${t.width}x${t.height}`), m).catch(e => String(e.message || e)));
for (const g of guesses) console.log(g, await page.evaluate(async p => { const t = await worldTest.propTexture(p); return `${t.width}x${t.height}`; }, g).catch(() => 'MISSING'));
await ctx.close();
