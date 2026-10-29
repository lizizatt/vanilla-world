// Pole spike (design/poles.md 13): JS-only measurements for the procedural caps. node pole-spike.mjs [outDir]
// Reports tile synthesis p50/p99, pre-stream budget, seam/continuity, shelf + berg stats, and writes shots (top-down, shelf close-up, shelf profile) to outDir.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {poleAdt,poleHeightChart,poleAlbedoChart,poleLattice,POLE_TILES} from './pole-source.js';
import {moonAdt} from './moon-terrain.js';
import {MOON_SEED} from './moon-source.js';
import {CAP,edgeColat} from './pole-cap.js';
import {chartToDir,hop,dirToChart,trueLength} from './frames.js';
import {PLANET_RADIUS as R,WORLD_CENTRE} from './space.js';
import {ADT_TILE} from './adt-synth.js';

const out=process.argv[2]??'..\\runtime\\pole-spike';mkdirSync(out,{recursive:true});
const deg=Math.PI/180,pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
const result={};

function png(path,w,h,rgb) {
  const raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++){raw[y*(w*3+1)]=0;rgb.copy?.(raw,y*(w*3+1)+1,y*w*3,(y+1)*w*3);}
  const crc=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return b=>{let c=0xffffffff;for(const v of b)c=t[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;};})();
  const chunk=(type,data)=>{const b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length,0);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,8+data.length)),8+data.length);return b;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  writeFileSync(path,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}

// 1) synthesis timing: Azeroth N cap tiles (cap-bearing 6x6 around the pole, the ones a pole drive touches first), Elune N tiles, and the existing Elune E tile as baseline.
const time=(fn,n)=>{const ms=[];fn();for(let i=0;i<n;i++){const t=performance.now();fn(i);ms.push(performance.now()-t);}return {p50:+pct(ms,.5).toFixed(1),p99:+pct(ms,.99).toFixed(1),max:+Math.max(...ms).toFixed(1),n};};
const c=POLE_TILES/2;
result.synthMs={
  azerothCap:time(i=>poleAdt('azeroth','N',c-3+((i??0)%6),c-3+(((i??0)/6|0)%6)),36),
  azerothCapBergTiles:time(i=>poleAdt('azeroth','S',c+((i??0)%4),c-6+(((i??0)/4|0)%3)),12),
  eluneNorth:time(i=>poleAdt('elune','N',c-3+((i??0)%6),c-3+(((i??0)/6|0)%6)),36),
  eluneEquatorBaseline:time(i=>moonAdt(MOON_SEED,28+((i??0)%4),14+(((i??0)/4|0)%4)),16),
};
const window5=result.synthMs.azerothCap.p50*25;
result.preStream={window5x5Ms:+window5.toFixed(0),firstTileMs:result.synthMs.azerothCap.p50,rampZoneYd:+(10*deg*R).toFixed(0),secondsAt60ydps:+(10*deg*R/60).toFixed(0)};

// 2) shelf + berg stats over the whole cap grid, sampled at 8 yd
{
  const rim=POLE_TILES/2*ADT_TILE,step=8;let belt=0,bergCells=0,shelf=0,lo=1e9,hi=-1e9,tallest=0,edgeMin=1e9,edgeMax=-1e9;
  const bergs=new Set();
  for(let z=-rim;z<rim;z+=step)for(let x=-rim;x<rim;x+=step) {
    const d=chartToDir('N',x,z,WORLD_CENTRE,R),col=Math.acos(Math.min(1,d[1])),e=edgeColat(d),h=poleHeightChart('azeroth','N',x,z);
    if(col<e-2/R){shelf++;lo=Math.min(lo,h);hi=Math.max(hi,h);}
    if(col>e+2/R&&col<e+CAP.bergBand/R){belt++;if(h>0){bergCells++;tallest=Math.max(tallest,h);}}
  }
  // count bergs as connected blobs on a coarse raster
  const n=Math.round(2*rim/step),seen=new Uint8Array(n*n),H=new Float32Array(n*n);
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){const x=-rim+i*step,z=-rim+j*step,d=chartToDir('N',x,z,WORLD_CENTRE,R),col=Math.acos(Math.min(1,d[1]));H[j*n+i]=col>edgeColat(d)+2/R&&poleHeightChart('azeroth','N',x,z)>0?1:0;}
  let count=0;for(let s=0;s<n*n;s++){if(!H[s]||seen[s])continue;count++;const q=[s];seen[s]=1;while(q.length){const k=q.pop(),i=k%n,j=k/n|0;for(const [a,b] of [[1,0],[-1,0],[0,1],[0,-1]]){const ii=i+a,jj=j+b;if(ii<0||jj<0||ii>=n||jj>=n)continue;const kk=jj*n+ii;if(H[kk]&&!seen[kk]){seen[kk]=1;q.push(kk);}}}}
  for(let a=0;a<720;a++){const e=edgeColat([Math.sin(.3)*Math.cos(a*.0087),Math.cos(.3),Math.sin(.3)*Math.sin(a*.0087)]);edgeMin=Math.min(edgeMin,e);edgeMax=Math.max(edgeMax,e);}
  result.cap={shelfHeightYd:[+lo.toFixed(2),+hi.toFixed(2)],shelfHeightM:[+(lo/1.0936).toFixed(1),+(hi/1.0936).toFixed(1)],iceEdgeDeg:[+(edgeMin/deg).toFixed(2),+(edgeMax/deg).toFixed(2)],beltCoveragePct:+(100*bergCells/belt).toFixed(2),bergsInBelt:count,tallestBergYd:+tallest.toFixed(2),gridRimYd:rim,capRadiusYd:+(CAP.edge*R).toFixed(0)};
}

// 3) seam checks
{
  let worstBorder=0,pairs=0;
  for(const [tx,ty] of [[7,7],[8,8],[9,8],[8,9],[10,10]])for(const [dx,dy] of [[1,0],[0,1]]){
    const a=poleLattice('azeroth','N',tx,ty),b=poleLattice('azeroth','N',tx+dx,ty+dy);pairs++;
    for(let k=0;k<259;k++){const ia=dx?k*259+257:257*259+k,ib=dx?k*259+1:259+k;worstBorder=Math.max(worstBorder,Math.abs(a.H[ia]-b.H[ib]));}
  }
  const rim=POLE_TILES/2*ADT_TILE;let rimStep=0;for(let t=-rim;t<rim;t+=16)for(const [x,z] of [[t,-rim],[t,rim-1],[-rim,t],[rim-1,t]])rimStep=Math.max(rimStep,Math.abs(poleHeightChart('azeroth','N',x,z)-CAP.seabed));
  // hop at 72 deg: pose round trip and true-speed ratio, and the tile-grid rim vs the hop circle
  const lat=72*deg,d=[Math.cos(lat),Math.sin(lat),0],[x,z]=dirToChart('E',d,WORLD_CENTRE,R);
  const s={x,z,yaw:.7,vx:-Math.sin(.7)*30,vz:-Math.cos(.7)*30},n=hop(s,'E','N',WORLD_CENTRE,R),b=hop(n,'N','E',WORLD_CENTRE,R);
  const stretch=lat_=>1/Math.cos(lat_*deg);
  result.seam={tileBorderMaxDiffYd:worstBorder,tilePairs:pairs,gridRimStepYd:rimStep,hopRoundTripErrYd:+Math.hypot(b.x-s.x,b.z-s.z).toExponential(2),hopTrueSpeedRatio:+(trueLength('N',n.x,n.z,n.vx,n.vz,WORLD_CENTRE,R)/trueLength('E',s.x,s.z,s.vx,s.vz,WORLD_CENTRE,R)).toFixed(6),
    hopCircleColatYd:+((90-72)*deg*R).toFixed(0),gridRimYd:rim,gridInsideHopCircle:rim<(90-72)*deg*R,
    eStretchAt62:+stretch(62).toFixed(2),eStretchAt72:+stretch(72).toFixed(2),poleFrameStretchAtGridRim:+(1/Math.cos(Math.atan(rim/R))).toFixed(3),poleFrameStretchEluneRim30deg:+(1/Math.cos(30*deg)).toFixed(3)};
}

// 4) shots
function shot(name,body,frame,half,size,shade=true,cx=0,cz=0) {
  const buf=Buffer.alloc(size*size*3),px=2*half/size,e=px;
  for(let j=0;j<size;j++)for(let i=0;i<size;i++) {
    const x=cx-half+(i+.5)*px,z=cz-half+(j+.5)*px,h=poleHeightChart(body,frame,x,z);
    const a=poleAlbedoChart(body,frame,x,z);let rgb;
    if(body==='azeroth'&&h<=0){rgb=[.04,.2,.34];}else{
      const gx=(poleHeightChart(body,frame,x+e,z)-poleHeightChart(body,frame,x-e,z))/(2*e),gz=(poleHeightChart(body,frame,x,z+e)-poleHeightChart(body,frame,x,z-e))/(2*e);
      const l=shade?Math.max(.25,Math.min(1.2,(-.5*gx+.8-.4*gz)/Math.hypot(gx,gz,1))*(body==='azeroth'?1:1)*1.1):1;rgb=a.map(v=>v*l);
    }
    for(let k=0;k<3;k++)buf[(j*size+i)*3+k]=Math.max(0,Math.min(255,Math.round(rgb[k]*255)));
  }
  png(join(out,name),size,size,buf);
}
shot('azeroth-cap-topdown.png','azeroth','N',4267,1024);
shot('azeroth-cap-shelf-closeup.png','azeroth','N',450,1024,true,(CAP.edge*R)*0.7,-(CAP.edge*R)*0.7);
shot('elune-pole-topdown.png','elune','N',4267,1024);
{ // shelf profile: height along a radial line through the edge, exaggerated vertical scale, side view
  const w=1200,h=300,buf=Buffer.alloc(w*h*3,255),lon=.4,span=120;
  const e=edgeColat([Math.sin(.17)*Math.cos(lon),Math.cos(.17),Math.sin(.17)*Math.sin(lon)]);
  for(let i=0;i<w;i++){
    const col=e+((i/w-.5)*span)/R,d=[Math.sin(col)*Math.cos(lon),Math.cos(col),Math.sin(col)*Math.sin(lon)];
    const hh=poleHeightChart('azeroth','N',...(()=>{const p=dirToChart('N',d,WORLD_CENTRE,R);return p;})());
    const y=Math.round(h*0.55-hh*12);for(let yy=Math.max(0,y);yy<h;yy++){const k=(yy*w+i)*3;const water=yy>h*0.55;buf[k]=water&&yy>y?10:235;buf[k+1]=water&&yy>y?60:240;buf[k+2]=water&&yy>y?110:250;}
  }
  png(join(out,'azeroth-shelf-profile.png'),w,h,buf);
}
writeFileSync(join(out,'spike.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
