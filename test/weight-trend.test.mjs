import {test} from 'node:test';
import assert from 'node:assert/strict';
import {weightTrend} from '../server.mjs';

function dayKeys(n){
  const out=[];
  for(let i=n-1;i>=0;i--){const d=new Date(Date.now()-i*86400000);out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)}
  return out;
}

test('不足7条不判定趋势',()=>{
  const t=weightTrend([{date:'2026-08-01',weight:47},{date:'2026-08-02',weight:46.9}]);
  assert.equal(t.enough,false);
});

test('14天下行趋势斜率与周变化为负',()=>{
  const keys=dayKeys(14);
  const logs=keys.map((date,i)=>({date,weight:+(47-i*0.05).toFixed(2)}));
  const t=weightTrend(logs);
  assert.equal(t.enough,true);
  assert.ok(t.slopePerWeek<0);
  assert.ok(t.deltaWeek<0);
});

test('14天平稳时周变化接近零',()=>{
  const keys=dayKeys(14);
  const logs=keys.map((date,i)=>({date,weight:47}));
  const t=weightTrend(logs);
  assert.equal(t.enough,true);
  assert.ok(Math.abs(t.deltaWeek)<1e-9);
});
