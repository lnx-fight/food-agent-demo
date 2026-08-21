import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mealTargets} from '../server.mjs';

const future=()=>new Date(Date.now()+60*86400000).toISOString().slice(0,10);
const baseProfile={age:30,sex:'female',height:165,weight:60,targetWeight:58,targetDate:future(),activity:'sedentary'};

test('预算调整参与每日目标计算',()=>{
  const base=mealTargets({...baseProfile,budgetAdjustmentKcal:0},{}).dailyTarget;
  const adjusted=mealTargets({...baseProfile,budgetAdjustmentKcal:-100},{}).dailyTarget;
  assert.equal(adjusted,base-100);
});

test('已记录早餐后，午餐预算只占剩余额度的一部分并为后续预留',()=>{
  const t=mealTargets(baseProfile,{calories:300,protein:10,meals:[{type:'早餐'}]},'午餐');
  assert.ok(t.mealKcal>0);
  assert.ok(t.mealKcal<t.remainingKcal);
  assert.ok(t.reservedKcal>0);
});

test('今日已超预算时状态为 exhausted 且本餐预算为0',()=>{
  const target=mealTargets(baseProfile,{}).dailyTarget;
  const t=mealTargets(baseProfile,{calories:target+100,protein:100,meals:[{type:'早餐'},{type:'午餐'},{type:'晚餐'}]},'晚餐');
  assert.equal(t.budgetStatus,'exhausted');
  assert.equal(t.remainingKcal,0);
});

test('极端目标返回 safety 风险提示，正常目标不返回',()=>{
  const shortDate=new Date(Date.now()+20*86400000).toISOString().slice(0,10);
  const extreme=mealTargets({age:30,sex:'female',height:165,weight:60,targetWeight:50,targetDate:shortDate,activity:'sedentary'},{});
  assert.equal(extreme.safety.extreme,true);
  assert.ok(extreme.safety.warning.length>0);
  const normal=mealTargets(baseProfile,{});
  assert.equal(normal.safety,null);
});
