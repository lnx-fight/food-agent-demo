// Tool 执行评测：验证指定 Tool 是否实际调用且执行成功。
// 用法：NODE_ENV=test node scripts/tool-execution-eval.mjs
// 可选：TOOL_EXEC_EVAL_LIMIT=3、TOOL_EXEC_EVAL_CONCURRENCY=2。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

process.env.NODE_ENV='test';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const {agentChat}=await import(join(ROOT,'server.mjs'));
const CASES=JSON.parse(readFileSync(join(ROOT,'test/fixtures/tool-execution-cases.json'),'utf8'));

if(!process.env.DASHSCOPE_API_KEY)throw new Error('DASHSCOPE_API_KEY 未配置');

const limit=Math.max(1,Math.min(CASES.length,Number(process.env.TOOL_EXEC_EVAL_LIMIT)||CASES.length));
const concurrency=Math.max(1,Math.min(10,Number(process.env.TOOL_EXEC_EVAL_CONCURRENCY)||2));
const profile={name:'Tool 评测用户',age:30,sex:'female',height:165,weight:60,targetWeight:58,targetDate:'2026-10-20',activity:'sedentary',budgetAdjustmentKcal:0};
const invalid=CASES.filter(item=>!item.id||!item.message||!item.expectedTool);
if(invalid.length)throw new Error(`夹具不合法：${invalid.map(item=>item.id||'(缺 id)').join('、')}`);
if(new Set(CASES.map(item=>item.id)).size!==CASES.length)throw new Error('夹具存在重复 id');

async function evaluate(item,index){
  const row={index,id:item.id,expectedTool:item.expectedTool,toolLog:[],targetCalled:false,targetSucceeded:false,error:''};
  try{
    const out=await agentChat({message:item.message,clientId:`tool-execution-eval:${item.id}`,profile,pendingMeal:item.pendingMeal||null});
    row.toolLog=Array.isArray(out.toolLog)?out.toolLog:[];
    const targetCalls=row.toolLog.filter(entry=>entry.tool===item.expectedTool);
    row.targetCalled=targetCalls.length>0;
    row.targetSucceeded=targetCalls.some(entry=>entry.ok===true);
  }catch(error){row.error=error.message}
  return row;
}

const selected=CASES.slice(0,limit);let next=0;
const rows=(await Promise.all(Array.from({length:Math.min(concurrency,selected.length)},async()=>{
  const result=[];while(next<selected.length){const index=next++;result.push(await evaluate(selected[index],index));}return result;
}))).flat().sort((a,b)=>a.index-b.index);
const countable=rows.filter(row=>!row.error);
const successfulCases=countable.filter(row=>row.targetSucceeded);
const allCalls=countable.flatMap(row=>row.toolLog);
const successfulCalls=allCalls.filter(call=>call.ok).length;
const percent=(value,total)=>total?`${(value/total*100).toFixed(1)}%`:'-';

console.log(`\n===== Tool 执行评测（${rows.length} 条，并发 ${concurrency}）=====`);
for(const row of rows){
  const actual=row.toolLog.length?row.toolLog.map(call=>`${call.tool}:${call.ok?'ok':'fail'}`).join(', '):'未调用';
  const mark=row.error?'E':row.targetSucceeded?'✓':'✗';
  console.log(`${mark} ${row.id.padEnd(22)} expected=${row.expectedTool.padEnd(24)} actual=${actual}${row.error?` error=${row.error}`:''}`);
}
console.log('\n===== Tool 执行指标 =====');
console.log(`  目标 Tool 成功率  ${successfulCases.length}/${countable.length}  ${percent(successfulCases.length,countable.length)}`);
console.log(`  实际调用成功率  ${successfulCalls}/${allCalls.length}  ${percent(successfulCalls,allCalls.length)}`);
console.log(`  漏调目标 Tool    ${countable.filter(row=>!row.targetCalled).length}`);
console.log(`  目标 Tool 调用失败 ${countable.filter(row=>row.targetCalled&&!row.targetSucceeded).length}`);

const failed=rows.filter(row=>row.error||!row.targetSucceeded);
if(failed.length){
  console.log('\n===== 失败诊断 =====');
  for(const row of failed)console.log(`- ${row.id}：${row.error||(!row.targetCalled?'未调用目标 Tool':'目标 Tool 返回失败')}`);
}
if(failed.length)process.exitCode=1;
