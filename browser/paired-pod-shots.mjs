// Private installed-data comparison; invoke through heavy-lock.mjs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {openLab} from './race-gate-lab.mjs';
import {podSkinList} from './swe1r/skin.js';

const out=path.resolve('..','runtime','paired-pods');
fs.mkdirSync(out,{recursive:true});
const {ctx,page,errors}=await openLab({width:1000,height:700});
const report=[];
try {
  await page.evaluate(async()=>{
    const p=worldEvidence.state.telemetry;
    await worldTest.restore([p[0],p[1]+150,p[2],0]);
    worldTest.freezePresentation(true);
    worldTest.timeLock(1440);
    worldTest.settings({cockpit:false,scenery:false,clouds:false,farClouds:false,shadows:false,particles:'off',music:false,sound:false});
    worldTest.showCraft(true);
    const sheet=new CSSStyleSheet();sheet.replaceSync('*{visibility:hidden!important}canvas{visibility:visible!important}');
    document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
  });
  await page.waitForTimeout(1000);
  for (const skin of podSkinList()) {
    const row={id:skin.id,name:skin.name};
    for (const full of [false,true]) {
      const variant=full?'after':'before';
      row[variant]=await page.evaluate(async({skin,full})=>{
        history.replaceState(null,'',`?test&fullPods=${full?1:0}`);
        const payload=await worldTest.swe1rModel(skin.index,skin.scale);
        const r=worldTest.renderer();r.setCraftOverride(payload);r.intakeAngle=0;
        if(!full) {
          const v=payload.asset.vertices,lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
          for(let i=0;i<v.length;i+=12)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],v[i+a]*skin.scale);hi[a]=Math.max(hi[a],v[i+a]*skin.scale);}
          window.podShotBounds={lo,hi};
        }
        return {assembly:payload.assembly,fallback:payload.fallback,triangles:payload.asset.indices.length/3,
          fans:payload.asset.batches.filter(b=>b.intake).map(b=>b.intake),anchor:payload.metadata.posedAttachment0};
      },{skin,full});
      for (const view of ['front','side']) {
        await page.evaluate(view=>{
          const {lo,hi}=window.podShotBounds,s=worldEvidence.state.telemetry;
          const target=[s[0]-(lo[1]+hi[1])/2,s[1]+(lo[2]+hi[2])/2,s[2]-(lo[0]+hi[0])/2];
          if(view==='front') worldTest.focus([target[0],target[1],s[2]-hi[0]-Math.max(hi[1]-lo[1],hi[2]-lo[2])*1.2-3,Math.PI,0]);
          else worldTest.focus([target[0]+(hi[0]-lo[0])*1.1+3,target[1],target[2],Math.PI/2,0]);
        },view);
        await page.waitForTimeout(200);
        const rendered=await page.evaluate(()=>({triangles:worldEvidence.render.craftTriangles,draws:worldEvidence.render.craftDraws,ready:worldEvidence.render.craftReady}));
        assert.ok(rendered.ready&&rendered.draws>0,skin.name);
        assert.equal(rendered.triangles,row[variant].triangles);
        row[variant][view]=rendered;
        await page.screenshot({path:path.join(out,`${skin.id}-${variant}-${view}.png`)});
      }
    }
    assert.deepEqual(row.after.anchor,row.before.anchor);
    assert.deepEqual(row.after.fans,row.before.fans);
    report.push(row);console.log(skin.name,row.before.triangles,'->',row.after.triangles,row.after.assembly,row.after.fallback||'');
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
} finally { await ctx.close(); }
