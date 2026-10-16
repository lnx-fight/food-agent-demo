import {test} from 'node:test';
import assert from 'node:assert/strict';
import {naturalWeekRange,buildNaturalWeekPlan,createDailyMealPlan,parseMenuText,reminderCanRun} from '../server.mjs';

const profile={age:30,sex:'female',height:165,weight:60,targetWeight:58,targetDate:'2026-12-31',activity:'light'};

test('自然周始终按周一至周日计算',()=>{
  assert.deepEqual(naturalWeekRange('2026-09-10'),{
    weekStart:'2026-09-07',
    weekEnd:'2026-09-13',
    dates:['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13']
  });
});

test('周日用次日作锚点时生成完整的下一自然周提案',()=>{
  const next=buildNaturalWeekPlan({profile,anchorDate:'2026-09-14',reason:'周日生成下周自然周计划提案'});
  assert.equal(next.weekStart,'2026-09-14');
  assert.equal(next.weekEnd,'2026-09-20');
  assert.equal(next.days.length,7);
  assert.equal(next.days.every(day=>day.meals.length===3),true);
  assert.equal(next.days.every(day=>day.meals.every(meal=>meal.diy?.ingredients.length>=3&&meal.diy?.steps.length>=2)),true);
});

test('自然周每个未执行餐次都直接包含具体食谱',()=>{
  const plan=buildNaturalWeekPlan({profile,anchorDate:'2026-09-07'}),meals=plan.days.flatMap(day=>day.meals);
  assert.equal(meals.length,21);
  assert.equal(meals.every(meal=>meal.diy?.name&&meal.diy.minutes>0),true);
  assert.equal(meals.every(meal=>meal.diy.ingredients.some(item=>/\d/.test(item))),true);
  assert.equal(meals.every(meal=>meal.baselineDiy?.steps.length>=2),true);
});

test('周中首次生成时不补写过去计划，并用已确认餐食覆盖当天安排',()=>{
  const plan=buildNaturalWeekPlan({profile,anchorDate:'2026-09-10',mealLogs:[{date:'2026-09-10',type:'早餐',name:'鸡蛋和豆浆',calories:310,protein:19}]});
  assert.equal(plan.weekStart,'2026-09-07');
  assert.equal(plan.weekEnd,'2026-09-13');
  assert.equal(plan.days[0].meals.length,0);
  assert.equal(plan.days[3].meals.find(meal=>meal.type==='早餐').status,'recorded');
  assert.equal(plan.days[3].meals.find(meal=>meal.type==='早餐').name,'鸡蛋和豆浆');
  assert.equal(plan.days[4].meals.length,3);
});

test('重新生成自然周计划时保留已锁定日期',()=>{
  const existing=buildNaturalWeekPlan({profile,anchorDate:'2026-09-10'});
  existing.status='confirmed';
  existing.days[4].locked=true;
  existing.days[4].meals[0].name='用户锁定早餐';
  const next=buildNaturalWeekPlan({profile,anchorDate:'2026-09-10',existingPlan:existing,reason:'测试重新生成'});
  assert.equal(next.version,existing.version+1);
  assert.equal(next.days[4].locked,true);
  assert.equal(next.days[4].meals[0].name,'用户锁定早餐');
});

test('粘贴菜单文字会保留全部可识别分类、菜品和价格',()=>{
  const items=parseMenuText('热菜\n宫保鸡丁 38\n清炒时蔬 22\n主食\n米饭 3\n宫保鸡丁 38');
  assert.deepEqual(items.map(item=>[item.category,item.name,item.price]),[
    ['热菜','宫保鸡丁',38],
    ['热菜','清炒时蔬',22],
    ['主食','米饭',3],
    ['主食','宫保鸡丁',38]
  ]);
});

test('每条确认记录都会重新分配当天尚未执行餐次',async()=>{
  const today={calories:900,protein:40,meals:[{type:'早餐',name:'实际早餐',calories:900,protein:40}]},plan=await createDailyMealPlan({profile,today}),lunch=plan.meals.find(meal=>meal.type==='午餐'),dinner=plan.meals.find(meal=>meal.type==='晚餐');
  assert.equal(plan.meals.find(meal=>meal.type==='早餐').status,'recorded');
  assert.equal(lunch.status,'planned');
  assert.equal(dinner.status,'planned');
  assert.equal(lunch.mealKcal+dinner.mealKcal,plan.remainingKcal);
  assert.match(lunch.adjustmentReason,/重新分配/);
});

test('主动提醒必须先授权，并遵守跨午夜免打扰时段',()=>{
  assert.equal(reminderCanRun({enabled:false},12*60),false);
  assert.equal(reminderCanRun({enabled:true,quietStart:'22:00',quietEnd:'08:00'},23*60),false);
  assert.equal(reminderCanRun({enabled:true,quietStart:'22:00',quietEnd:'08:00'},7*60+30),false);
  assert.equal(reminderCanRun({enabled:true,quietStart:'22:00',quietEnd:'08:00'},12*60),true);
});
