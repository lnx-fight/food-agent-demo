import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControlledAgentResult,
  controlledToolArgs,
  controlledWorkflowTools,
  deterministicRouteDescription
} from '../server.mjs';

const dataset=JSON.parse(readFileSync(new URL('./fixtures/agent-behavior-cases.json',import.meta.url),'utf8'));

test('冻结评测集中的高置信请求由结构化路由稳定分类',()=>{
  for(const item of dataset.cases){
    const message=item.messages.at(-1).content;
    const route=deterministicRouteDescription(message);
    assert.ok(route,`${item.id} 应命中高置信结构化路由`);
    assert.equal(route.intent,item.expected.intent,`${item.id} intent`);
    assert.equal(route.mealScenario||null,item.expected.scenario,`${item.id} scenario`);
    assert.equal(route.skills.includes('next-meal-decision'),Boolean(item.expected.skill),`${item.id} skill`);
  }
});

test('无加热设备时不执行包含隔夜熟食的完整 Tool 方案',()=>{
  const message='今天起晚了，不吃早饭。冰箱里只有昨晚剩的半盒番茄炒蛋、两片面包和一盒快过期的牛奶，微波炉又坏了。下午三点要开会，，晚上可能吃爆米花。';
  const result=buildControlledAgentResult({
    message,
    routeIntent:'meal',
    mealScenario:'diy',
    ctx:{profile:{},targets:{},dayOffset:0},
    proposal:null,
    dispatched:{results:[{tool:'compose_diy_recipe',ok:true,result:{recipe:{name:'常温番茄炒蛋配面包牛奶',ingredients:[],steps:['彻底复热剩菜'],nutrition:{kcal:550,protein:29}}}}]}
  });
  assert.match(result.answer,/不能在未彻底复热/);
  assert.match(result.answer,/两片面包/);
  assert.match(result.answer,/未来可能事件/);
  assert.doesNotMatch(result.answer,/营养值约 550/);
});

test('Workflow 对典型场景给出受控 Tool 链',()=>{
  assert.deepEqual(controlledWorkflowTools('meal','unknown','晚饭吃什么比较好？'),[]);
  assert.deepEqual(controlledWorkflowTools('meal','unknown','按最近记录推荐下一餐，别重复常吃的东西'),['get_memory']);
  assert.deepEqual(controlledWorkflowTools('meal','diy','家里有鸡蛋，晚饭怎么做？'),['compose_diy_recipe']);
  assert.deepEqual(controlledWorkflowTools('meal','restaurants','我在静安寺附近找午饭'),['search_nearby_restaurants','get_restaurant_menu','personalize_restaurant']);
  assert.deepEqual(controlledWorkflowTools('record','','今天体重63.5公斤，帮我记一下'),[]);
});

test('Tool 参数标准化中文时间、营养查询词与过敏过滤',()=>{
  const base={mealType:'早餐',dayOffset:1,profile:{},browserLocation:null};
  assert.deepEqual(controlledToolArgs('compose_diy_recipe','明天早餐有鸡蛋、全麦面包和牛奶，十分钟内怎么搭配？',base),{
    ingredients:['鸡蛋','全麦面包','牛奶'],
    pantry:[],
    cookTime:'10分钟',
    cookTools:'普通厨具',
    mealType:'早餐'
  });
  assert.deepEqual(controlledToolArgs('search_nutrition','鸡胸肉每100克有多少热量和蛋白质？',base),{name:'鸡胸肉'});
  assert.deepEqual(controlledToolArgs('compose_diy_recipe','我花生过敏，用花生酱做晚餐',{
    ...base,
    mealType:'晚餐',
    profile:{allergies:'花生'}
  }).ingredients,[]);
});

test('营养查询保留用户确认的 FDC 编号和烹饪状态',()=>{
  assert.deepEqual(controlledWorkflowTools('other','','查询 fdc:2706888 的营养'),['search_nutrition']);
  assert.deepEqual(controlledToolArgs('search_nutrition','查询 fdc:2706888 的营养',{}),{name:'fdc:2706888'});
  assert.deepEqual(controlledToolArgs('search_nutrition','熟鸡胸肉每100克多少热量？',{}),{name:'熟鸡胸肉'});
});
