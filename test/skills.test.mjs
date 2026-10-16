import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildNaturalWeekPlan,createDailyMealPlan,mealTargets,normalizeRouterIntent,scanSkills,selectSkillReferences} from '../server.mjs';

const profile={age:30,sex:'female',height:165,weight:60,targetWeight:58,targetDate:'2026-12-31',activity:'light'};

test('仓库只注册下一餐决策 Skill，并只保留下一餐 reference',()=>{
  const skills=scanSkills(),names=skills.map(skill=>skill.name);
  assert.deepEqual(names,['next-meal-decision']);
  assert.deepEqual(skills[0].referenceFiles,[
    'references/amap-api.md',
    'references/nutrition-data.md',
    'references/recommendation-rules.md',
    'references/tool-guide.md'
  ]);
});

test('下一餐请求命中 Skill，纯周计划调整不再作为 Skill workflow',()=>{
  assert.equal(normalizeRouterIntent('meal','中午吃多了，晚餐具体吃什么',['next-meal-decision']),'meal');
  assert.equal(normalizeRouterIntent('other','周五到周日出差，修改本周计划',[]),'other');
  assert.equal(normalizeRouterIntent('meal','周五到周日出差，修改本周计划',['next-meal-decision']),'other');
  assert.equal(normalizeRouterIntent('other','早餐吃了鸡蛋，帮我记一下',['next-meal-decision']),'record');
  assert.equal(normalizeRouterIntent('record','刚记录完体重，中午吃什么',['next-meal-decision']),'meal');
});

test('下一餐 Skill 只加载规划器实际选择的 reference',()=>{
  const skill=scanSkills()[0],context=[{skill}],selected=selectSkillReferences({references:['references/recommendation-rules.md']},context,'meal')[0];
  assert.deepEqual(selected.references,['references/recommendation-rules.md']);
});

test('今日理论参考超出后，下一餐使用正常餐次参考而不是 0 kcal',()=>{
  const targets=mealTargets(profile,{calories:2600,protein:80,meals:[{type:'早餐'},{type:'午餐'}]},'晚餐');
  assert.equal(targets.remainingKcal,0);
  assert.equal(targets.budgetStatus,'exhausted');
  assert.equal(targets.recommendationMode,'regular_meal_no_compensation');
  assert.ok(targets.mealKcal>0);
  assert.equal(targets.reservedKcal,0);
});

test('早餐午餐已超出目标时，今日计划仍给晚餐正常参考并标记非补偿',async()=>{
  const today={calories:2600,protein:80,meals:[
    {type:'早餐',name:'早餐记录',calories:1000,protein:30},
    {type:'午餐',name:'午餐记录',calories:1600,protein:50}
  ]};
  const plan=await createDailyMealPlan({profile,today}),dinner=plan.meals.find(meal=>meal.type==='晚餐');
  assert.equal(plan.budgetStatus,'exhausted');
  assert.equal(dinner.status,'planned');
  assert.equal(dinner.guidanceOnly,true);
  assert.ok(dinner.mealKcal>0);
  assert.match(dinner.adjustmentReason,/不.*补偿/);
});

test('自然周计划保存每餐基准，供餐后滚动刷新与删除记录恢复',()=>{
  const plan=buildNaturalWeekPlan({profile,anchorDate:'2026-09-10'}),today=plan.days.find(day=>day.date==='2026-09-10');
  for(const meal of today.meals){
    assert.equal(meal.baselineName,meal.name);
    assert.equal(meal.baselineMealKcal,meal.mealKcal);
  }
});
