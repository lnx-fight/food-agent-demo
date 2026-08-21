// 场景分流评测：固定样本集 → 每条调用完整 agentLoop → 检查最终 action.type 是否进入期望分支。
// 口径：场景分流准确率 = 最终进入正确场景分支的样本数 / 总场景分流样本数。
// 用法：NODE_ENV=test node scripts/meal-choice-eval.mjs
// 可选：MEAL_CHOICE_EVAL_LIMIT=3 只跑前 3 条；MEAL_CHOICE_EVAL_CONCURRENCY=6 控制并发数。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

process.env.NODE_ENV='test';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const {agentChat}=await import(join(ROOT,'server.mjs'));
const CASES=JSON.parse(readFileSync(join(ROOT,'test/fixtures/meal-choice-cases.json'),'utf8'));

if(!process.env.DASHSCOPE_API_KEY)throw new Error('DASHSCOPE_API_KEY 未配置');

const VALID_ACTIONS=new Set(['open_diy','open_restaurants','open_meal_choice']);
const limit=Number(process.env.MEAL_CHOICE_EVAL_LIMIT)||CASES.length;
const concurrency=Math.max(1,Math.min(10,Number(process.env.MEAL_CHOICE_EVAL_CONCURRENCY)||6));
const clientPrefix=String(process.env.MEAL_CHOICE_EVAL_CLIENT||'meal-choice-eval');
const PROFILE={
  name:'评测用户',
  age:30,
  sex:'female',
  height:165,
  weight:60,
  targetWeight:58,
  targetDate:new Date(Date.now()+60*86400000).toISOString().slice(0,10),
  activity:'sedentary',
  budgetAdjustmentKcal:0
};

const invalid=CASES.filter(testCase=>!testCase.id||!testCase.category||!testCase.message||!VALID_ACTIONS.has(testCase.expectedAction));
if(invalid.length){
  console.error('夹具不合法，请检查以下条目：');
  for(const row of invalid)console.error(`- ${row.id||'(缺 id)'} category=${row.category||'(缺 category)'} message=${row.message||'(缺 message)'} expectedAction=${row.expectedAction||'(缺 expectedAction)'}`);
  process.exit(1);
}
const idSet=new Set();
for(const row of CASES)idSet.add(row.id);
if(idSet.size!==CASES.length)throw new Error('夹具存在重复 id');

function percent(value,count){
  return count?`${(Number(value)*100).toFixed(1)}%`:'-';
}
const ACTION_SCENARIOS={open_diy:'diy',open_restaurants:'restaurants',open_meal_choice:'unknown'};

async function evaluateCase(testCase,index){
  const row={
    index,
    id:testCase.id,
    category:testCase.category,
    message:testCase.message,
    expected:testCase.expectedAction,
    routerAction:'',
    agentAction:'',
    actual:'',
    correct:false,
    routerCorrect:false,
    expectedScenario:ACTION_SCENARIOS[testCase.expectedAction]||'',
    scenarioCorrect:false,
    guarded:false,
    mealScenario:'',
    scenarioSource:'',
    adversarial:!!testCase.adversarial,
    note:testCase.note||'',
    ms:0,
    error:'',
    countable:true
  };
  const started=Date.now();
  try{
    const out=await agentChat({
      message:testCase.message,
      clientId:`${clientPrefix}:${testCase.id}`,
      profile:PROFILE
    });
    const routing=out.routing||{};
    row.routerAction=String(routing.routerAction||'none');
    row.agentAction=String(routing.agentAction||'none');
    row.actual=String(out.action?.type||'none');
    row.correct=row.actual===testCase.expectedAction;
    row.routerCorrect=row.routerAction===testCase.expectedAction;
    row.scenarioCorrect=row.mealScenario===row.expectedScenario;
    row.guarded=!!routing.correctionAttempted;
    row.mealScenario=String(routing.mealScenario||'');
    row.scenarioSource=String(routing.scenarioSource||'');
  }catch(error){
    row.error=error.message;
    row.countable=false;
  }
  row.ms=Date.now()-started;
  return row;
}
const selectedCases=CASES.slice(0,limit);
let nextIndex=0;
const results=(await Promise.all(Array.from({length:Math.min(concurrency,selectedCases.length)},async()=>{
  const rows=[];
  while(nextIndex<selectedCases.length){
    const index=nextIndex++;
    rows.push(await evaluateCase(selectedCases[index],index));
  }
  return rows;
}))).flat().sort((a,b)=>a.index-b.index);
console.log(`\n并发数：${concurrency}`);

console.log('\n===== 场景分流逐条结果 =====');
for(const row of results){
  const mark=row.error?'E':row.correct?'✓':'✗';
  const guard=row.guarded?' [语义纠错]':'';
  const ms=`${(row.ms/1000).toFixed(1)}s`;
  if(row.error){
    console.log(`${mark} ${row.category.padEnd(18)} ${row.id.padEnd(12)} expected=${row.expected.padEnd(16)} error=${row.error}`);
  }else{
    console.log(`${mark} ${row.category.padEnd(18)} ${row.id.padEnd(12)} scenario=${(row.mealScenario||'-').padEnd(11)} expected=${row.expectedScenario.padEnd(11)} action=${row.actual.padEnd(16)} ${ms}${guard}`);
  }
}

const countable=results.filter(row=>row.countable);
const correct=countable.filter(row=>row.correct);
const routerCorrect=countable.filter(row=>row.routerCorrect);
const scenarioCorrect=countable.filter(row=>row.scenarioCorrect);
const guarded=countable.filter(row=>row.guarded);
console.log('\n===== 场景分流整体指标 =====');
console.log(`  样本数    ${countable.length}`);
console.log(`  条件场景准确率 ${scenarioCorrect.length}/${countable.length}  ${percent(scenarioCorrect.length,countable.length)}`);
console.log(`  Router action  ${routerCorrect.length}/${countable.length}  ${percent(routerCorrect.length,countable.length)}`);
console.log(`  最终入口准确率 ${correct.length}/${countable.length}  ${percent(correct.length,countable.length)}`);
console.log(`  语义纠错  ${guarded.length}`);

console.log('\n===== 按类别 =====');
const categories=[...new Set(results.map(row=>row.category))];
for(const category of categories){
  const rows=countable.filter(row=>row.category===category);
  if(!rows.length)continue;
  const ok=rows.filter(row=>row.correct).length;
  console.log(`  ${category.padEnd(18)} ${ok}/${rows.length}  ${percent(ok/rows.length,rows.length)}`);
}

const adversarial=countable.filter(row=>row.adversarial);
if(adversarial.length){
  const ok=adversarial.filter(row=>row.correct).length;
  console.log('\n===== 对抗样本子集 =====');
  console.log(`  ${ok}/${adversarial.length}  ${percent(ok/adversarial.length,adversarial.length)}`);
}

const wrong=countable.filter(row=>!row.correct);
if(wrong.length){
  console.log('\n===== 错误样本 =====');
  for(const row of wrong){
    console.log(`- [${row.category}] ${row.id}：${row.message}`);
    console.log(`  场景 ${row.mealScenario||'-'}（${row.scenarioSource||'-'}）；期望 ${row.expectedScenario}，Router ${row.routerAction}，最终 ${row.actual}`);
  }
}

const errors=results.filter(row=>!row.countable);
if(errors.length){
  console.log('\n===== 调用错误 =====');
  for(const row of errors)console.log(`- [${row.category}] ${row.id}：${row.error}`);
}

if(errors.length)process.exit(1);
