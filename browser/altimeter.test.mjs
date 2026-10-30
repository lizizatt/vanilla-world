import test from 'node:test';
import assert from 'node:assert/strict';
import {drumWheels,formatClimb,ClimbRate} from './altimeter.js';

test('drum shows at least five wheels and grows with altitude', () => {
  assert.equal(drumWheels(0).length,5);
  assert.deepEqual(drumWheels(1234).map(w=>w.digit),[0,1,2,3,4]);
  assert.equal(drumWheels(1234567).length,7);
  assert.equal(drumWheels(-50).length,5);
  assert.equal(drumWheels(NaN)[4].pos,0);
});

test('units wheel rolls continuously, higher wheels only turn through a carry', () => {
  const w=drumWheels(1234.5);
  near(w[4].pos,4.5);assert.equal(w[3].pos,3);assert.equal(w[2].pos,2);
  const c=drumWheels(1239.5);
  near(c[4].pos,9.5);near(c[3].pos,3.5);assert.equal(c[2].pos,2);
  const cc=drumWheels(1999.5);
  near(cc[4].pos,9.5);near(cc[3].pos,9.5);near(cc[2].pos,9.5);near(cc[1].pos,1.5);
});

test('signed climb text', () => {
  assert.equal(formatClimb(12.4),'+12 yd/s');
  assert.equal(formatClimb(-1900.2),'\u22121,900 yd/s');
  assert.equal(formatClimb(0.3),'0 yd/s');
  assert.equal(formatClimb(-0.4),'0 yd/s');
  assert.equal(formatClimb(NaN),'0 yd/s');
});

test('climb rate converges to the true rate, smooths noise, and resets on teleport or body swap', () => {
  const c=new ClimbRate();let alt=100,t=0,v=0;
  for(let i=0;i<120;i++){t+=1/60;alt+=50/60;v=c.update(alt,t,'azeroth');}
  assert.ok(Math.abs(v-50)<2,String(v));
  const v1=c.update(alt+500,t+1/60,'azeroth');// one-frame spike is damped
  assert.ok(v1<50+500*60*(1-Math.exp(-1/60/.35))+1&&v1>50);
  assert.equal(c.update(9e5,t+10,'azeroth'),0);
  c.update(100,t+10.016,'azeroth');
  assert.equal(c.update(5e3,t+10.032,'elune'),0);
  assert.equal(c.update(5e3,t+10.032,'elune'),0);
});
function near(a,b,e=1e-9){assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);}
