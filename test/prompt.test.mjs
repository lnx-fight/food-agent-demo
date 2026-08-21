import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PROMPT_VERSION,PROMPTS_VERSION,SYSTEM_BASE,buildAgentContext,sanitizePlanSteps,mealRecordFailureResult,isNearbyRestaurantRequest,normalizeBrowserLocation,controlledToolArgs,executionArgsForLog} from '../server.mjs';

const baseCtx={profile:{},weights:[],pendingMeal:null,recentConfirmed:[],targets:{},today:{},mealType:'午餐'};

test('提示词版本号已定义',()=>{
  assert.equal(PROMPT_VERSION,'v9');
  assert.equal(PROMPTS_VERSION,'v3');
});

test('规划器步骤过滤未知工具名并限制步数',()=>{
  const tools=[{function:{name:'read_user_state'}},{function:{name:'get_meal_budget'}},{function:{name:'compose_diy_recipe'}}];
  const plan=sanitizePlanSteps({goal:'g',fallback:'f',steps:[
    {tool:'read_user_state',why:'a'},
    {tool:'不存在的工具',why:'b'},
    {tool:'compose_diy_recipe',why:'c'},
    {tool:'d',why:'d'},{tool:'e',why:'e'},{tool:'f',why:'f'},{tool:'g',why:'g'},{tool:'h',why:'h'}
  ]},tools);
  assert.deepEqual(plan.steps.map(s=>s.tool),['read_user_state','compose_diy_recipe']);
  assert.ok(plan.steps.length<=6);
});

test('规划器对非法输入返回空计划',()=>{
  const plan=sanitizePlanSteps(null,[]);
  assert.deepEqual(plan.steps,[]);
});

test('提示词包含写库唯一路径约束',()=>{
  assert.ok(SYSTEM_BASE.includes('propose_meal_record'));
  assert.ok(!SYSTEM_BASE.includes('propose_weight_record'));
  assert.ok(SYSTEM_BASE.includes('不得声称已写入'));
  assert.ok(SYSTEM_BASE.includes('revise_pending_meal'));
});

test('文字记餐提案失败时必须返回未记录状态和手动记录入口',()=>{
  const result=mealRecordFailureResult('无法从本地营养库可靠估算：品牌汉堡',{mealType:'早餐'});
  assert.match(result.answer,/尚未记录/);
  assert.doesNotMatch(result.answer,/已确认记录|已记录到/);
  assert.equal(result.action.type,'open_manual_log');
  assert.equal(result.action.mealType,'早餐');
});

test('附近餐食请求使用浏览器位置，且执行日志不保存原始坐标',()=>{
  assert.equal(isNearbyRestaurantRequest('我附近有什么吃的？'),true);
  assert.equal(isNearbyRestaurantRequest('今天早餐吃什么？'),false);
  const location=normalizeBrowserLocation({latitude:31.2304,longitude:121.4737});
  assert.deepEqual(location,{latitude:31.2304,longitude:121.4737});
  assert.equal(normalizeBrowserLocation({latitude:100,longitude:121}),null);
  const args=controlledToolArgs('search_nearby_restaurants','我附近有什么吃的？',{browserLocation:location});
  assert.equal(args.latitude,31.2304);
  assert.equal(args.longitude,121.4737);
  assert.deepEqual(executionArgsForLog('search_nearby_restaurants',args),{area:'',cuisine:'',locationSource:'browser_authorized'});
});

test('提示词要求估算数值只返回单一近似值，不使用区间',()=>{
  assert.ok(SYSTEM_BASE.includes('只返回单一数值'));
  assert.ok(!SYSTEM_BASE.includes('内部区间'));
  assert.ok(!SYSTEM_BASE.includes('热量给区间'));
});

test('提示词输出契约不再包含旧写库 action',()=>{
  assert.ok(!SYSTEM_BASE.includes('save_pending_meal'));
  assert.ok(!SYSTEM_BASE.includes('save_weight'));
  // revise_pending_meal 现在是修正工具（规则4），应作为工具名出现而非旧 action
  assert.ok(SYSTEM_BASE.includes('revise_pending_meal'));
});

test('场景路由不写入全局 System Prompt，改由 Skill 与确定性兜底负责',()=>{
  assert.ok(!SYSTEM_BASE.includes('action.type 必须返回 open_meal_choice'));
  assert.ok(!SYSTEM_BASE.includes('不得直接返回 open_diy 或 open_restaurants'));
});

test('上下文不再注入体重记录与趋势摘要',()=>{
  const weights=Array.from({length:14},(_,i)=>({date:`2026-08-${String(i+1).padStart(2,'0')}`,weight:+(60-i*0.1).toFixed(1)}));
  const ctx=JSON.parse(buildAgentContext({...baseCtx,weights},{memory:[],memoryHits:[]}));
  assert.ok(!('weights' in ctx));
  assert.ok(!('trend' in ctx));
});

test('上下文长文本截断到200字',()=>{
  const ctx=JSON.parse(buildAgentContext({...baseCtx,profile:{habit:'x'.repeat(500),preferences:'y'.repeat(500)}},{memory:[],memoryHits:[]}));
  assert.ok(ctx.longTermMemory.habit.length<=200);
  assert.ok(ctx.longTermMemory.preferences.length<=200);
});

test('上下文记忆合并为 recent + hits 单块',()=>{
  const ctx=JSON.parse(buildAgentContext(baseCtx,{memory:[{kind:'meal_confirmed'}],memoryHits:[{kind:'weekly_review'}]}));
  assert.equal(ctx.memory.recent.length,1);
  assert.equal(ctx.memory.hits.length,1);
  assert.ok(!('goals' in ctx));
});
