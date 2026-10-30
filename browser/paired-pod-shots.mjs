// Private installed-data comparison; invoke through heavy-lock.mjs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {openLab} from './race-gate-lab.mjs';
import {podSkinList} from './swe1r/skin.js';

const out=path.resolve('..','runtime','paired-pods',process.env.SHOT_DIR||'default');
const only=process.env.POD_ONLY?.split(',');
fs.mkdirSync(out,{recursive:true});
const {ctx,page,errors}=await openLab({width:1000,height:700});
const report=[];
try {
  await page.waitForFunction(()=>!worldEvidence.loading?.active);
  await page.evaluate(async()=>{
    const p=worldEvidence.state.telemetry;
    await worldTest.restore([p[0],p[1]+150,p[2],0]);
    worldTest.freezePresentation(true);
    worldTest.timeLock(1440);
    worldTest.settings({cockpit:false,scenery:false,clouds:false,farClouds:false,shadows:false,particles:'off',music:false,sound:false});
    worldTest.showCraft(true);
    worldTest.mockGates([]);
    worldTest.props([]);
    const sheet=new CSSStyleSheet();sheet.replaceSync('*{visibility:hidden!important}canvas{visibility:visible!important}');
    document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
  });
  await page.waitForTimeout(1000);
  for (const skin of podSkinList().filter(s=>!only||only.includes(s.name))) {
    const row={id:skin.id,name:skin.name};
    {
      const variant='after';
      row[variant]=await page.evaluate(async(skin)=>{
        const payload=await worldTest.swe1rModel(skin.index,skin.scale);
        const r=worldTest.renderer();r.setCraftOverride(payload);r.intakeAngle=0;
        {
          const v=payload.asset.vertices,lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
          for(let i=0;i<v.length;i+=12)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],v[i+a]*skin.scale);hi[a]=Math.max(hi[a],v[i+a]*skin.scale);}
          window.podShotBounds={lo,hi};
          window.podShotCloud=Array.from({length:v.length/12*3},(_,k)=>v[Math.floor(k/3)*12+k%3]*skin.scale);
        }
        return {assembly:payload.assembly,fallback:payload.fallback,triangles:payload.asset.indices.length/3,
          fans:payload.asset.batches.filter(b=>b.intake).map(b=>b.intake),anchor:payload.metadata.posedAttachment0};
      },skin);
      assert.equal(row[variant].assembly,'paired',skin.name);
      for (const view of (process.env.VIEWS||'front,side').split(',')) {
        await page.evaluate(([view,skin])=>{
          const {lo,hi}=window.podShotBounds,s=worldEvidence.state.telemetry;
          const target=[s[0]-(lo[1]+hi[1])/2,s[1]+(lo[2]+hi[2])/2,s[2]-(lo[0]+hi[0])/2];
          if(view.startsWith('close')){
            // Engine close-ups: front of the left (close) or right (close-r) engine, from ahead and slightly above.
            const v=window.podShotCloud,sign=view==='close'?1:-1;let sx=0,sy=0,sz=0,n=0;
            for(let i=0;i<v.length;i+=3)if(v[i]>hi[0]-0.6&&v[i+1]*sign>0){sx+=v[i];sy+=v[i+1];sz+=v[i+2];n++;}
            if(!n)return;
            sx/=n;sy/=n;sz/=n;
            worldTest.focus([s[0]-sy,s[1]+sz+0.6,s[2]-sx-2.2,Math.PI,-0.15]);
          }
          else if(view==='chase') worldTest.focus([target[0],target[1]+Math.max(hi[2]-lo[2],1)*0.8,s[2]-lo[0]+Math.max(hi[1]-lo[1],hi[2]-lo[2])*1.6+3,0,-0.2]);
          else if(view==='back') worldTest.focus([target[0],target[1],s[2]-lo[0]+Math.max(hi[1]-lo[1],hi[2]-lo[2])*0.6+2,0,0]);
          else if(view==='top') worldTest.focus([target[0],target[1]+Math.max(hi[0]-lo[0],hi[1]-lo[1])*1.3+3,target[2],0,-Math.PI/2+0.001]);
          else if(view==='front') worldTest.focus([target[0],target[1],s[2]-hi[0]-Math.max(hi[1]-lo[1],hi[2]-lo[2])*1.2-3,Math.PI,0]);
          else worldTest.focus([target[0]+(hi[0]-lo[0])*1.1+3,target[1],target[2],Math.PI/2,0]);
        },[view,skin]);
        await page.waitForTimeout(200);
        const rendered=await page.evaluate(()=>({triangles:worldEvidence.render.craftTriangles,draws:worldEvidence.render.craftDraws,ready:worldEvidence.render.craftReady}));
        assert.ok(rendered.ready&&rendered.draws>0,skin.name);
        assert.equal(rendered.triangles,row[variant].triangles);
        row[variant][view]=rendered;
        await page.screenshot({path:path.join(out,`${skin.id}-${variant}-${view}.png`)});
      }
    }
    report.push(row);console.log(skin.name,row.after.triangles,row.after.assembly);
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>worldEvidence.errors),[]);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
} finally { await ctx.close(); }
