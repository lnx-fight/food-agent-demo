// Skill routing 评测：固定样本集 → 单次调用 routeDescription → 输出每个 Skill 的 Precision / Recall / F1 与集合准确率。
// 用法：NODE_ENV=test node scripts/skill-route-eval.mjs
// 可选：SKILL_ROUTE_EVAL_LIMIT=3、SKILL_ROUTE_EVAL_CONCURRENCY=6。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

process.env.NODE_ENV='test';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const {routeDescription}=await import(join(ROOT,'server.mjs'));
const CASES=JSON.parse(readFileSync(join(ROOT,'test/fixtures/skill-route-cases.json'),'utf8'));

if(!process.env.DASHSCOPE_API_KEY)throw new Error('DASHSCOPE_API_KEY 未配置');

const TARGET_SKILLS=[...new Set(CASES.flatMap(testCase=>Array.isArray(testCase.expectSkills)?testCase.expectSkills:[]))];
const limit=Number(process.env.SKILL_ROUTE_EVAL_LIMIT)||CASES.length;
const concurrency=Math.max(1,Math.min(10,Number(process.env.SKILL_ROUTE_EVAL_CONCURRENCY)||6));

function sameSkillSet(a=[],b=[]){return [...a].sort().join('|')===[...b].sort().join('|')}

function calcMetrics(rows,skill){
  const tp=rows.filter(row=>row.expectedSkills.includes(skill)&&row.actualSkills.includes(skill)).length;
  const fp=rows.filter(row=>!row.expectedSkills.includes(skill)&&row.actualSkills.includes(skill)).length;
  const fn=rows.filter(row=>row.expectedSkills.includes(skill)&&!row.actualSkills.includes(skill)).length;
  const tn=rows.filter(row=>!row.expectedSkills.includes(skill)&&!row.actualSkills.includes(skill)).length;
  const precision=tp+fp?tp/(tp+fp):0;
  const recall=tp+fn?tp/(tp+fn):0;
  const f1=precision+recall?2*precision*recall/(precision+recall):0;
  return {count:rows.length,tp,fp,fn,tn,precision,recall,f1};
}

function percent(value){
  return `${(Number(value)*100).toFixed(1)}%`;
}

function printMetrics(label,metrics){
  console.log(`\n${label}`);
  console.log(`  Count      ${metrics.count}`);
  console.log(`  Precision  ${percent(metrics.precision)}`);
  console.log(`  Recall     ${percent(metrics.recall)}`);
  console.log(`  F1         ${percent(metrics.f1)}`);
  console.log(`  TP/FP/TN/FN ${metrics.tp}/${metrics.fp}/${metrics.tn}/${metrics.fn}`);
}

async function evaluateCase(testCase,index){
  const row={
    id:testCase.id,
    category:testCase.category,
    message:testCase.message,
    expectedSkills:Array.isArray(testCase.expectSkills)?testCase.expectSkills:[],
    actualSkills:[],
    actualIntent:'',
    expectedIntent:testCase.expectIntent||'',
    error:'',
    countable:true
  };
  try{
    const routed=await routeDescription(testCase.message);
    row.actualSkills=routed.skills||[];
    row.actualIntent=routed.intent||'';
  }catch(error){
    row.error=error.message;
    row.countable=false;
  }
  row.correct=row.countable&&sameSkillSet(row.expectedSkills,row.actualSkills);
  row.intentMismatch=row.countable&&row.expectedIntent&&row.actualIntent!==row.expectedIntent;
  return {...row,index};
}
const selected=CASES.slice(0,limit);let next=0;
const results=(await Promise.all(Array.from({length:Math.min(concurrency,selected.length)},async()=>{
  const rows=[];while(next<selected.length){const index=next++;rows.push(await evaluateCase(selected[index],index));}return rows;
}))).flat().sort((a,b)=>a.index-b.index);
console.log(`\n并发数：${concurrency}`);

console.log('\n===== Skill Routing 逐条结果 =====');
for(const row of results){
  const mark=row.error?'E':row.correct?'✓':'✗';
  const skills=row.actualSkills.length?row.actualSkills.join(','):'[]';
  const expected=row.expectedSkills.length?row.expectedSkills.join(','):'[]';
  const actual=row.error?`error:${row.error}`:skills;
  console.log(`${mark} ${row.category.padEnd(26)} ${row.id.padEnd(34)} expected=${expected.padEnd(24)} actual=${actual.padEnd(24)} intent=${row.actualIntent||'-'}`);
  if(row.intentMismatch)console.log(`   intent mismatch: expected=${row.expectedIntent} actual=${row.actualIntent}`);
}

const countable=results.filter(row=>row.countable);
const exact=countable.filter(row=>row.correct).length,intentCorrect=countable.filter(row=>!row.intentMismatch).length;
console.log('\n===== Skill Routing 整体指标 =====');
console.log(`  Skill 集合准确率  ${percent(countable.length?exact/countable.length:0)} (${exact}/${countable.length})`);
console.log(`  Intent 准确率     ${percent(countable.length?intentCorrect/countable.length:0)} (${intentCorrect}/${countable.length})`);
for(const skill of TARGET_SKILLS)printMetrics(`===== ${skill} =====`,calcMetrics(countable,skill));

const categories=[...new Set(results.map(row=>row.category))];
console.log('\n===== Skill Routing 按 category =====');
for(const category of categories){
  const rows=countable.filter(row=>row.category===category);
  if(!rows.length)continue;
  const correct=rows.filter(row=>row.correct).length;
  console.log(`  ${category.padEnd(28)} ${percent(correct/rows.length)} (${correct}/${rows.length})`);
}

const wrong=countable.filter(row=>!row.correct);
if(wrong.length){
  console.log('\n===== 错误样本 =====');
  for(const row of wrong){
    console.log(`- [${row.category}] ${row.id}：${row.message}`);
    console.log(`  期望 skills=${row.expectedSkills.join(',')||'[]'}，实际 skills=${row.actualSkills.join(',')||'[]'}，intent=${row.actualIntent||'-'}`);
  }
}

const errors=results.filter(row=>!row.countable);
if(errors.length){
  console.log('\n===== 调用错误 =====');
  for(const row of errors)console.log(`- [${row.category}] ${row.id}：${row.error}`);
}

if(errors.length)process.exit(1);
