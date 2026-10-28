// Private real-data front audit. Run from browser under heavy-lock with WOW_DATA,
// SWE1R_DATA and PORT. Never commit runtime/intakes (screenshots contain user art).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {openLab} from './race-gate-lab.mjs';
import {podSkinList} from './swe1r/skin.js';
const label=process.env.INTAKE_LABEL||'after';
const out=new URL(`../runtime/intakes/${label}/`,import.meta.url);
fs.mkdirSync(out,{recursive:true});
const {ctx,page,errors}=await openLab({width:1000,height:700});
const report=[];
try {
  await page.evaluate(async()=>{
    const p=worldEvidence.state.telemetry;
    await worldTest.restore([p[0],p[1]+150,p[2],0]);
    worldTest.freezePresentation(true);
    worldTest.settings({cockpit:false,scenery:false,clouds:false,farClouds:false,shadows:false,particles:'off',music:false,sound:false});
    worldTest.showCraft(true);
    const sheet=new CSSStyleSheet();sheet.replaceSync('*{visibility:hidden!important}canvas{visibility:visible!important}');
    document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
  });
  for(const skin of podSkinList()){
    const row=await page.evaluate(async skin=>{
      const payload=await worldTest.swe1rModel(skin.index,skin.scale);
      const r=worldTest.renderer();r.setCraftOverride(payload);
      const v=payload.asset.vertices,lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
      for(let i=0;i<v.length;i+=12)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],v[i+a]*skin.scale);hi[a]=Math.max(hi[a],v[i+a]*skin.scale);}
      const s=worldEvidence.state.telemetry;
      const distance=Math.max(hi[1]-lo[1],hi[2]-lo[2]*1.4)*1.1+3;
      const target=[s[0]-(lo[1]+hi[1])/2,s[1]+(lo[2]+hi[2])/2,s[2]-hi[0]];
      worldTest.focus([target[0],target[1],target[2]-distance,Math.PI,0]);
      r.intakeAngle=0;
      return {id:skin.id,name:skin.name,model:skin.index,
        rotors:payload.asset.batches.filter(b=>b.intake).map(b=>({pivot:b.intake,texture:b.texture})),
        mirrored:payload.asset.batches.filter(b=>b.addressU==='mirror-repeat'||b.addressV==='mirror-repeat').length};
    },skin);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>worldEvidence.render.craftReady),true,skin.name);
    assert.ok(await page.evaluate(()=>worldEvidence.render.craftDraws)>0,skin.name);
    await page.screenshot({path:path.join(fileURLToPath(out),`${skin.id}-front.png`)});
    if(row.rotors.length){
      await page.evaluate(()=>{worldTest.renderer().intakeAngle=.37;});
      await page.waitForTimeout(100);
      await page.screenshot({path:path.join(fileURLToPath(out),`${skin.id}-spin.png`)});
    }
    report.push(row);console.log(skin.name,row.rotors.length,'rotors');
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  fs.writeFileSync(new URL('report.json',out),JSON.stringify(report,null,2));
} finally {await ctx.close();}
