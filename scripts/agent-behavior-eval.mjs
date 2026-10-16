// 下一餐推荐 Agent 行为评测：固定状态与 Tool fixture → 真实模型 → 规则判定 + 大模型裁判。
// 仅校验数据集：npm run eval:validate
// 运行真实评测：npm run eval:agent
// 可选：AGENT_EVAL_SAMPLE_TYPE=adversarial、AGENT_EVAL_LIMIT=3、AGENT_EVAL_CONCURRENCY=2。
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculateAutomaticMetrics,calculateSampleTypeMetrics,calculateJudgeMetrics,releaseDecision,formatMetricValue} from './agent-eval-metrics.mjs';
import {JUDGE_PROMPT_VERSION,judgeAgentRun} from './agent-model-judge.mjs';

process.env.NODE_ENV='test';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const DATASET_PATH=join(ROOT,'test/fixtures/agent-behavior-cases.json');
const DATASET=JSON.parse(readFileSync(DATASET_PATH,'utf8'));
const METRICS_PATH=join(ROOT,'test/fixtures/agent-eval-metrics.json');
const METRICS=JSON.parse(readFileSync(METRICS_PATH,'utf8'));
const SAMPLE_TYPES=['positive','negative','boundary_ambiguous','exception','adversarial'];
const DIMENSIONS=new Set(['intent','skill_boundary','scenario','clarification','tool_selection','tool_arguments','recommendation','grounding','state','fact_state','state_write','safety','memory','personalization','multi_turn','constraints','failure_recovery','privacy']);
const TOOLS=new Set(['read_user_state','get_meal_budget','compose_diy_recipe','search_nearby_restaurants','get_restaurant_menu','personalize_restaurant','search_nutrition','get_daily_plan','get_memory','propose_meal_record','revise_pending_meal']);
const INTENTS=new Set(['meal','record','other']);
const SCENARIOS=new Set(['diy','restaurants','unknown',null]);
const ACTIONS=new Set(['none','open_meal_choice','open_diy','open_restaurants','open_manual_log']);
const PROPOSALS=new Set(['none','meal','revise']);
const EXTERNAL_TOOLS=new Set(['compose_diy_recipe','search_nearby_restaurants','get_restaurant_menu','personalize_restaurant','search_nutrition','get_daily_plan']);
const DEFAULT_TOOL_FIXTURES={
  compose_diy_recipe:{ok:false,result:{error:'评测样本未提供 compose_diy_recipe fixture'}},
  search_nearby_restaurants:{ok:false,result:{error:'评测样本未提供 search_nearby_restaurants fixture'}},
  get_restaurant_menu:{ok:false,result:{error:'评测样本未提供 get_restaurant_menu fixture'}},
  personalize_restaurant:{ok:false,result:{error:'评测样本未提供 personalize_restaurant fixture'}},
  search_nutrition:{ok:true,result:{nutrition:null,source:'eval_fixture_missing',trace:['eval_fixture_missing']}},
  get_daily_plan:{ok:false,result:{error:'评测样本未提供 get_daily_plan fixture'}}
};
const DEFAULT_PROFILE={
  name:'评测用户',
  age:30,
  sex:'female',
  height:165,
  weight:60,
  targetWeight:56,
  targetDate:'2026-12-31',
  activity:'sedentary',
  budgetAdjustmentKcal:0,
  mealMode:'均衡饮食',
  tastePreference:'清淡',
  preferences:'',
  dislikedFoods:'',
  allergies:''
};

function isObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function duplicateValues(values){const seen=new Set(),duplicates=new Set();for(const value of values){if(seen.has(value))duplicates.add(value);seen.add(value)}return [...duplicates]}
function invalidFixtureResult(fixture){return fixture.ok===false||(Array.isArray(fixture.result)&&fixture.result.length===0)||fixture.result?.nutrition===null}

function validateDataset(dataset){
  const errors=[];
  if(dataset.schemaVersion!==1)errors.push('schemaVersion 必须为 1');
  if(dataset.scope!=='next-meal-decision')errors.push('scope 必须为 next-meal-decision');
  if(!isObject(dataset.sampleTypeDefinitions))errors.push('缺少 sampleTypeDefinitions');
  if(!isObject(dataset.toolFixtureCatalog))errors.push('缺少 toolFixtureCatalog');
  if(!Array.isArray(dataset.cases)||!dataset.cases.length)errors.push('cases 必须是非空数组');
  const catalog=isObject(dataset.toolFixtureCatalog)?dataset.toolFixtureCatalog:{};
  for(const [name,fixture] of Object.entries(catalog)){
    if(!isObject(fixture))errors.push(`fixture ${name} 必须是对象`);
    else if(!TOOLS.has(fixture.tool))errors.push(`fixture ${name} 使用未知 Tool：${fixture.tool}`);
    else if(typeof fixture.ok!=='boolean')errors.push(`fixture ${name} 缺少布尔值 ok`);
  }
  const cases=Array.isArray(dataset.cases)?dataset.cases:[];
  for(const id of duplicateValues(cases.map(item=>item.id)))errors.push(`重复样本 id：${id}`);
  for(const item of cases){
    const prefix=item.id||'(缺 id)';
    if(!item.id)errors.push('存在缺少 id 的样本');
    if(!SAMPLE_TYPES.includes(item.sampleType))errors.push(`${prefix} sampleType 无效`);
    if(!item.category)errors.push(`${prefix} 缺少 category`);
    if(!Array.isArray(item.dimensions)||!item.dimensions.length)errors.push(`${prefix} dimensions 不能为空`);
    else for(const dimension of item.dimensions)if(!DIMENSIONS.has(dimension))errors.push(`${prefix} 使用未知 dimension：${dimension}`);
    if(!Array.isArray(item.messages)||!item.messages.length||item.messages.at(-1)?.role!=='user')errors.push(`${prefix} messages 最后一条必须是 user`);
    else for(const message of item.messages)if(!['user','assistant'].includes(message?.role)||!String(message?.content||'').trim())errors.push(`${prefix} messages 含无效消息`);
    if(!isObject(item.stateFixture))errors.push(`${prefix} stateFixture 必须是对象`);
    if(!Array.isArray(item.toolFixtureRefs))errors.push(`${prefix} toolFixtureRefs 必须是数组`);
    else for(const ref of item.toolFixtureRefs)if(!catalog[ref])errors.push(`${prefix} 引用了不存在的 fixture：${ref}`);
    const expected=item.expected;
    if(!isObject(expected)){errors.push(`${prefix} 缺少 expected`);continue}
    if(expected.skill!==null&&expected.skill!=='next-meal-decision')errors.push(`${prefix} expected.skill 无效`);
    if(!INTENTS.has(expected.intent))errors.push(`${prefix} expected.intent 无效`);
    if(!SCENARIOS.has(expected.scenario))errors.push(`${prefix} expected.scenario 无效`);
    if(!ACTIONS.has(expected.action))errors.push(`${prefix} expected.action 无效`);
    if(!PROPOSALS.has(expected.proposal))errors.push(`${prefix} expected.proposal 无效`);
    for(const field of ['requiredTools','allowedTools','toolArgumentAssertions'])if(!Array.isArray(expected[field]))errors.push(`${prefix} expected.${field} 必须是数组`);
    const required=Array.isArray(expected.requiredTools)?expected.requiredTools:[],allowed=Array.isArray(expected.allowedTools)?expected.allowedTools:[];
    for(const tool of [...required,...allowed])if(!TOOLS.has(tool))errors.push(`${prefix} 使用未知 Tool：${tool}`);
    for(const tool of required)if(!allowed.includes(tool))errors.push(`${prefix} required Tool 未列入 allowedTools：${tool}`);
    const fixtureTools=new Set((item.toolFixtureRefs||[]).map(ref=>catalog[ref]?.tool).filter(Boolean));
    for(const tool of fixtureTools)if(!allowed.includes(tool))errors.push(`${prefix} 的 fixture Tool 未列入 allowedTools：${tool}`);
    for(const tool of required)if(EXTERNAL_TOOLS.has(tool)&&!fixtureTools.has(tool))errors.push(`${prefix} 的外部 required Tool 缺少固定 fixture：${tool}`);
    for(const assertion of expected.toolArgumentAssertions||[]){
      if(!TOOLS.has(assertion?.tool)||!String(assertion?.path||'').trim())errors.push(`${prefix} 含无效 Tool 参数断言`);
      else if(!allowed.includes(assertion.tool))errors.push(`${prefix} 的参数断言 Tool 未列入 allowedTools：${assertion.tool}`);
      if(!Object.hasOwn(assertion||{},'equals')&&!Array.isArray(assertion?.includesAll))errors.push(`${prefix} Tool 参数断言必须含 equals 或 includesAll`);
    }
    if(!isObject(expected.answer)||!Array.isArray(expected.answer.mustContainAny)||!Array.isArray(expected.answer.mustNotMatch))errors.push(`${prefix} expected.answer 结构无效`);
    if(!Array.isArray(expected.judgeCriteria)||!expected.judgeCriteria.length)errors.push(`${prefix} 必须有大模型裁判标准`);
    if(!Array.isArray(item.hardConstraints)||!item.hardConstraints.length)errors.push(`${prefix} hardConstraints 不能为空`);
    if(!Array.isArray(item.judgeMethods)||!item.judgeMethods.includes('rule')||!item.judgeMethods.includes('model'))errors.push(`${prefix} judgeMethods 必须同时包含 rule 和 model`);
    if(item.sampleType==='negative'&&expected.skill!==null)errors.push(`${prefix} 负样本不得命中下一餐推荐 Skill`);
    if(item.sampleType==='exception'&&!item.toolFixtureRefs.some(ref=>invalidFixtureResult(catalog[ref])))errors.push(`${prefix} 异常样本必须包含失败、空结果或缺失数据 fixture`);
  }
  for(const type of SAMPLE_TYPES){
    const count=cases.filter(item=>item.sampleType===type).length;
    if(count<5)errors.push(`${type} 样本至少 5 条，当前 ${count} 条`);
  }
  return errors;
}

function validateMetricsConfig(config){
  const errors=[];
  if(config.schemaVersion!==1)errors.push('指标 schemaVersion 必须为 1');
  if(!String(config.metricsVersion||'').trim())errors.push('缺少 metricsVersion');
  if(!isObject(config.releasePolicy))errors.push('缺少 releasePolicy');
  for(const field of ['automaticMetrics','sampleTypeGates','judgeMetrics','hardViolationCodes'])if(!Array.isArray(config[field])||!config[field].length)errors.push(`${field} 必须是非空数组`);
  const definitions=[...(config.automaticMetrics||[]),...(config.judgeMetrics||[])];
  for(const id of duplicateValues(definitions.map(item=>item.id)))errors.push(`重复指标 id：${id}`);
  for(const item of definitions){
    if(!item.id||!item.name||!item.definition)errors.push(`指标定义不完整：${item.id||'(缺 id)'}`);
    if(!['gte','lte'].includes(item.direction))errors.push(`${item.id} direction 必须是 gte 或 lte`);
    if(!Number.isFinite(Number(item.threshold)))errors.push(`${item.id} threshold 必须是数字`);
    if(typeof item.hardGate!=='boolean')errors.push(`${item.id} hardGate 必须是布尔值`);
  }
  for(const item of config.sampleTypeGates||[])if(!SAMPLE_TYPES.includes(item.sampleType)||!Number.isFinite(Number(item.threshold)))errors.push(`无效 sampleTypeGate：${item.sampleType||'(缺类型)'}`);
  for(const id of duplicateValues((config.hardViolationCodes||[]).map(item=>item.id)))errors.push(`重复一票否决代码：${id}`);
  return errors;
}

function resolvedToolFixtures(item){
  const fixtures=structuredClone(DEFAULT_TOOL_FIXTURES);
  for(const ref of item.toolFixtureRefs){
    const fixture=DATASET.toolFixtureCatalog[ref];
    fixtures[fixture.tool]={ok:fixture.ok,result:structuredClone(fixture.result)};
  }
  return fixtures;
}
function toolFixtureEvidence(item){
  return Object.fromEntries(item.toolFixtureRefs.map(ref=>[ref,structuredClone(DATASET.toolFixtureCatalog[ref])]));
}
function pathValue(value,path){return String(path).split('.').reduce((current,key)=>current==null?undefined:current[key],value)}
function valueIncludesAll(value,expected){
  if(!Array.isArray(value))return false;
  return expected.every(needle=>value.some(actual=>String(actual).includes(String(needle))));
}
function sameValue(actual,expected){return typeof expected==='number'?Number(actual)===expected:String(actual)===String(expected)}
function uniqueToolCalls(calls){
  const seen=new Set(),duplicates=[];
  for(const call of calls){const key=`${call.tool}:${JSON.stringify(call.args||{})}`;if(seen.has(key))duplicates.push(key);seen.add(key)}
  return duplicates;
}
function forbiddenClaimMatches(answer,pattern){
  let regex;
  try{regex=new RegExp(pattern,'ig')}catch{return true}
  const matches=[...String(answer||'').matchAll(regex)];
  if(!matches.length)return false;
  const negation=/(?:不建议|不推荐|不能|不会|无法|禁止|拒绝|不要|绝对不|并非|不是|未曾|没有|未获取|未找到|排除|避开|去除|不含)/;
  return matches.some(match=>{
    const index=Number(match.index)||0;
    const before=String(answer||'').slice(Math.max(0,index-18),index);
    const after=String(answer||'').slice(index+match[0].length,index+match[0].length+18);
    return !negation.test(`${before}${match[0]}${after}`);
  });
}
function addCheck(checks,name,pass,details=''){checks.push({name,pass:Boolean(pass),details:String(details||'')})}

function judgeCase(item,out){
  const checks=[],expected=item.expected,answer=String(out.answer||'');
  const actualSkills=Array.isArray(out.evaluation?.routedSkills)?out.evaluation.routedSkills:[];
  const calls=Array.isArray(out.evaluation?.toolCalls)?out.evaluation.toolCalls:[];
  const calledTools=[...new Set(calls.map(call=>call.tool))];
  const proposalKind=out.proposal?.kind||'none';
  const skillCorrect=expected.skill?actualSkills.includes(expected.skill):!actualSkills.includes('next-meal-decision');
  const intentCorrect=out.routing?.intent===expected.intent;
  const scenarioCorrect=(out.routing?.mealScenario??null)===expected.scenario;
  const actionCorrect=out.action?.type===expected.action;
  const proposalCorrect=proposalKind===expected.proposal;
  addCheck(checks,'Skill',skillCorrect,`expected=${expected.skill||'none'} actual=${actualSkills.join(',')||'none'}`);
  addCheck(checks,'Intent',intentCorrect,`expected=${expected.intent} actual=${out.routing?.intent||'none'}`);
  addCheck(checks,'Scenario',scenarioCorrect,`expected=${expected.scenario??'none'} actual=${out.routing?.mealScenario??'none'}`);
  addCheck(checks,'Action',actionCorrect,`expected=${expected.action} actual=${out.action?.type||'none'}`);
  let requiredToolHits=0;
  for(const tool of expected.requiredTools){const hit=calledTools.includes(tool);if(hit)requiredToolHits++;addCheck(checks,`Required Tool: ${tool}`,hit,`called=${calledTools.join(',')||'none'}`)}
  const unexpected=calledTools.filter(tool=>!expected.allowedTools.includes(tool));
  addCheck(checks,'No unexpected Tool',unexpected.length===0,unexpected.join(','));
  addCheck(checks,'Proposal',proposalCorrect,`expected=${expected.proposal} actual=${proposalKind}`);
  for(const ref of item.toolFixtureRefs){
    const fixture=DATASET.toolFixtureCatalog[ref];
    addCheck(checks,`Fixture applied: ${ref}`,calls.some(call=>call.tool===fixture.tool&&call.ok===fixture.ok),`tool=${fixture.tool} expected ok=${fixture.ok}`);
  }
  let toolArgumentHits=0;
  for(const assertion of expected.toolArgumentAssertions){
    const matching=calls.filter(call=>call.tool===assertion.tool);
    const passed=matching.some(call=>{
      const actual=pathValue(call.args,assertion.path);
      return Object.hasOwn(assertion,'equals')?sameValue(actual,assertion.equals):valueIncludesAll(actual,assertion.includesAll);
    });
    if(passed)toolArgumentHits++;
    addCheck(checks,`Tool args: ${assertion.tool}.${assertion.path}`,passed,JSON.stringify(matching.map(call=>pathValue(call.args,assertion.path))));
  }
  const answerSignalApplicable=expected.answer.mustContainAny.length>0;
  const missingResultSignal=expected.answer.mustContainAny.some(term=>['没有','没找到','暂无','换个'].includes(term))&&/(?:没有|没找到|暂无|未获取|未找到|未发现|换个)/.test(answer);
  const answerSignalCorrect=!answerSignalApplicable||missingResultSignal||expected.answer.mustContainAny.some(term=>answer.includes(term));
  if(answerSignalApplicable)addCheck(checks,'Answer signal',answerSignalCorrect,`one of=${expected.answer.mustContainAny.join('|')}`);
  let forbiddenClaimHits=0;
  for(const pattern of expected.answer.mustNotMatch){
    const matches=forbiddenClaimMatches(answer,pattern);
    if(!matches)forbiddenClaimHits++;
    addCheck(checks,`Forbidden claim: /${pattern}/`,!matches,matches?answer.slice(0,240):'');
  }
  const duplicates=uniqueToolCalls(calls);
  addCheck(checks,'No duplicate Tool call with same args',duplicates.length===0,duplicates.join(','));
  const signals={
    expectedSkill:Boolean(expected.skill),
    actualSkill:actualSkills.includes('next-meal-decision'),
    skillCorrect,
    intentCorrect,
    scenarioCorrect,
    actionCorrect,
    proposalCorrect,
    requiredToolHits,
    requiredToolTotal:expected.requiredTools.length,
    allowedToolCalls:calls.filter(call=>expected.allowedTools.includes(call.tool)).length,
    toolCallTotal:calls.length,
    toolArgumentHits,
    toolArgumentTotal:expected.toolArgumentAssertions.length,
    answerSignalApplicable,
    answerSignalCorrect,
    forbiddenClaimHits,
    forbiddenClaimTotal:expected.answer.mustNotMatch.length,
    duplicateFree:duplicates.length===0,
    decisionSignature:JSON.stringify({skill:actualSkills.includes('next-meal-decision'),intent:out.routing?.intent||null,scenario:out.routing?.mealScenario??null,action:out.action?.type||'none',tools:calledTools.slice().sort()})
  };
  return {checks,passed:checks.every(check=>check.pass),answer,calledTools,actualSkills,judgeCriteria:expected.judgeCriteria,hardConstraints:item.hardConstraints,signals};
}

const validationErrors=[...validateDataset(DATASET),...validateMetricsConfig(METRICS)];
if(validationErrors.length){
  console.error('\n===== Eval 数据集校验失败 =====');
  for(const error of validationErrors)console.error(`- ${error}`);
  process.exit(1);
}
const counts=Object.fromEntries(SAMPLE_TYPES.map(type=>[type,DATASET.cases.filter(item=>item.sampleType===type).length]));
console.log(`\nEval 数据集有效：${DATASET.cases.length} 条；${SAMPLE_TYPES.map(type=>`${type}=${counts[type]}`).join('，')}`);
if(process.env.AGENT_EVAL_VALIDATE_ONLY==='1')process.exit(0);
const {agentChat,qwenChat,PROMPT_VERSION,PROMPTS_VERSION}=await import(join(ROOT,'server.mjs'));
if(!process.env.DASHSCOPE_API_KEY)throw new Error('DASHSCOPE_API_KEY 未配置；可先运行 npm run eval:validate 做离线校验');
const evaluatedModel=process.env.QWEN_CHAT_MODEL||process.env.QWEN_WEB_MODEL||'qwen-plus';
const judgeModel=process.env.QWEN_JUDGE_MODEL||evaluatedModel;
const skipModelJudge=process.env.AGENT_EVAL_SKIP_MODEL_JUDGE==='1';
if(judgeModel===evaluatedModel&&!skipModelJudge)console.warn(`警告：裁判模型与被测模型均为 ${judgeModel}；正式发布评测建议通过 QWEN_JUDGE_MODEL 配置不同模型，降低自评偏差。`);
const typeFilter=String(process.env.AGENT_EVAL_SAMPLE_TYPE||'').trim();
const idFilter=String(process.env.AGENT_EVAL_CASE_ID||'').trim();
let selected=DATASET.cases.filter(item=>(!typeFilter||item.sampleType===typeFilter)&&(!idFilter||item.id===idFilter));
if(!selected.length)throw new Error(`没有匹配的评测样本：sampleType=${typeFilter||'*'} caseId=${idFilter||'*'}`);
const limit=Number(process.env.AGENT_EVAL_LIMIT)||selected.length;
selected=selected.slice(0,Math.max(1,limit));
const concurrency=Math.max(1,Math.min(4,Number(process.env.AGENT_EVAL_CONCURRENCY)||2));
const repeats=Math.max(1,Math.min(5,Number(process.env.AGENT_EVAL_REPEATS)||1));
const jobs=selected.flatMap(item=>Array.from({length:repeats},(_,repeatIndex)=>({item,repeatIndex})));
let nextIndex=0;

async function runCase(item,index,repeatIndex){
  const messages=item.messages,latest=messages.at(-1),history=messages.slice(0,-1);
  const state=item.stateFixture||{},profile={...DEFAULT_PROFILE,...(state.profile||{})},started=Date.now();
  try{
    const out=await agentChat({
      message:latest.content,
      history,
      clientId:`agent-behavior-eval:${Date.now()}:${item.id}:${repeatIndex+1}`,
      profile,
      todayMeals:Array.isArray(state.todayMeals)?state.todayMeals:[],
      weeklyPlan:state.weeklyPlan||null,
      pendingMeal:state.pendingMeal||null,
      location:state.location||null,
      mealType:state.mealType||'',
      toolFixtures:resolvedToolFixtures(item)
    });
    const ms=Date.now()-started,judgement=judgeCase(item,out);
    if(skipModelJudge)return {index,repeatIndex,item,out,judgement,modelJudgement:null,judgeError:'',ms,error:''};
    try{
      const judgeItem={...item,stateFixture:{...state,profile}};
      const modelJudgement=await judgeAgentRun({item:judgeItem,out,ruleJudgement:judgement,toolFixtures:toolFixtureEvidence(item),hardViolationCodes:METRICS.hardViolationCodes,model:judgeModel,chat:qwenChat});
      return {index,repeatIndex,item,out,judgement,modelJudgement,judgeError:'',ms,error:''};
    }catch(error){return {index,repeatIndex,item,out,judgement,modelJudgement:null,judgeError:error.message,ms,error:''}}
  }catch(error){return {index,repeatIndex,item,out:null,judgement:null,modelJudgement:null,judgeError:'',ms:Date.now()-started,error:error.message}}
}

const rows=(await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{
  const group=[];
  while(nextIndex<jobs.length){const index=nextIndex++,job=jobs[index];group.push(await runCase(job.item,index,job.repeatIndex))}
  return group;
}))).flat().sort((a,b)=>a.index-b.index);

console.log(`\n===== Agent 行为 Eval（${selected.length} 个样本 × ${repeats} 次 = ${rows.length} 次运行，并发 ${concurrency}）=====`);
for(const row of rows){
  const mark=row.error?'E':row.judgement.passed?'✓':'✗';
  const judgeFailed=row.modelJudgement?.hardViolations.length||row.modelJudgement?.scores.constraintCompliance===0||row.modelJudgement?.scores.safetyCompliance===0||row.modelJudgement?.criterionResults.some(item=>!item.pass);
  const judgeMark=skipModelJudge||row.error||!row.modelJudgement&&!row.judgeError?'-':row.judgeError?'E':judgeFailed?'✗':'✓';
  const failed=row.judgement?.checks.filter(check=>!check.pass).map(check=>check.name).join('、')||'';
  console.log(`${mark} ${row.item.sampleType.padEnd(20)} ${row.item.id.padEnd(38)} run=${row.repeatIndex+1} agent=${(row.ms/1000).toFixed(1)}s judge=${judgeMark}${row.modelJudgement?`/${(row.modelJudgement.ms/1000).toFixed(1)}s`:''}${failed?` failed=${failed}`:''}${row.error?` error=${row.error}`:''}${row.judgeError?` judgeError=${row.judgeError}`:''}`);
}

const completed=rows.filter(row=>!row.error);
const automaticMetrics=calculateAutomaticMetrics(rows,METRICS);
const sampleTypeMetrics=calculateSampleTypeMetrics(rows,METRICS);
const judgeMetrics=calculateJudgeMetrics(rows,METRICS);
const decision=releaseDecision({rows,automaticMetrics,sampleTypeMetrics,judgeMetrics,config:METRICS,totalDatasetCases:DATASET.cases.length});

function printMetricGroup(title,metrics){
  console.log(`\n===== ${title} =====`);
  for(const item of metrics){
    const mark=item.status==='pass'?'✓':item.status==='fail'?'✗':'-';
    const threshold=`${item.direction==='lte'?'≤':'≥'} ${item.format==='percentage'?`${(item.threshold*100).toFixed(0)}%`:item.format==='milliseconds'?`${item.threshold}ms`:item.format==='score_5'?`${item.threshold}/5`:item.threshold}`;
    const fraction=Number.isFinite(item.numerator)&&Number.isFinite(item.denominator)?` (${item.numerator}/${item.denominator})`:'';
    const confusion=Number.isFinite(item.tp)?` TP/FP/FN=${item.tp}/${item.fp}/${item.fn}`:'';
    console.log(`${mark} ${item.name.padEnd(24)} ${formatMetricValue(item).padEnd(10)}${fraction} 门槛 ${threshold}${confusion}`);
  }
}
printMetricGroup('自动指标',automaticMetrics);
printMetricGroup('五类样本切片',sampleTypeMetrics);
printMetricGroup('大模型裁判指标',judgeMetrics);
console.log(`\n===== 发布判定：${decision.status==='pass'?'PASS':'NOT READY'} =====`);
if(decision.blockers.length)for(const blocker of decision.blockers)console.log(`- ${blocker}`);
console.log(`- 被测模型：${evaluatedModel}；裁判模型：${skipModelJudge?'已跳过':judgeModel}`);

const failed=rows.filter(row=>row.error||!row.judgement?.passed);
if(failed.length){
  console.log('\n===== 失败诊断 =====');
  for(const row of failed){
    console.log(`- [${row.item.sampleType}] ${row.item.id}`);
    if(row.error){console.log(`  调用错误：${row.error}`);continue}
    for(const check of row.judgement.checks.filter(item=>!item.pass))console.log(`  ${check.name}：${check.details||'未通过'}`);
    console.log(`  回答：${row.judgement.answer.slice(0,500)}`);
  }
}

if(process.env.AGENT_EVAL_SHOW_JUDGE==='1'){
  console.log('\n===== 大模型裁判明细 =====');
  for(const row of completed){
    console.log(`- ${row.item.id} run=${row.repeatIndex+1}`);
    if(row.judgeError){console.log(`  裁判错误：${row.judgeError}`);continue}
    if(!row.modelJudgement){console.log('  未调用大模型裁判');continue}
    for(const result of row.modelJudgement.criterionResults)console.log(`  ${result.pass?'✓':'✗'} ${result.criterion}：${result.reason}`);
    console.log(`  总结：${row.modelJudgement.reason}（confidence=${row.modelJudgement.confidence}）`);
    console.log(`  回答：${row.judgement.answer.slice(0,800)}`);
  }
}

const reportPath=String(process.env.AGENT_EVAL_REPORT_PATH||'').trim();
if(reportPath){
  const report={
    schemaVersion:1,
    metricsVersion:METRICS.metricsVersion,
    generatedAt:new Date().toISOString(),
    dataset:{name:DATASET.name,scope:DATASET.scope,selectedCases:selected.map(item=>item.id),repeats},
    models:{agent:evaluatedModel,judge:skipModelJudge?null:judgeModel,sameModel:!skipModelJudge&&evaluatedModel===judgeModel},
    versions:{datasetSchema:DATASET.schemaVersion,metrics:METRICS.metricsVersion,agentPrompt:PROMPT_VERSION,agentPrompts:PROMPTS_VERSION,judgePrompt:JUDGE_PROMPT_VERSION},
    metrics:{automatic:automaticMetrics,sampleTypes:sampleTypeMetrics,modelJudge:judgeMetrics},
    releaseDecision:decision,
    cases:rows.map(row=>({id:row.item.id,sampleType:row.item.sampleType,run:row.repeatIndex+1,agentMs:row.ms,agentError:row.error||null,agentOutput:row.out,automaticJudgement:row.judgement,modelJudgement:row.modelJudgement,judgeError:row.judgeError||null}))
  };
  const absoluteReportPath=resolve(ROOT,reportPath);
  mkdirSync(dirname(absoluteReportPath),{recursive:true});
  writeFileSync(absoluteReportPath,`${JSON.stringify(report,null,2)}\n`);
  console.log(`- 评测报告已保存：${absoluteReportPath}`);
}

const automaticGateFailed=[...automaticMetrics,...sampleTypeMetrics].some(item=>item.hardGate&&item.status==='fail');
const judgeGateFailed=!skipModelJudge&&judgeMetrics.some(item=>item.hardGate&&item.status==='fail');
if(failed.length||automaticGateFailed||judgeGateFailed||(process.env.AGENT_EVAL_ENFORCE_RELEASE==='1'&&decision.status!=='pass'))process.exitCode=1;
