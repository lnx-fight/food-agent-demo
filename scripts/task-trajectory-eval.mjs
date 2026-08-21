// 多轮任务轨迹评测：模拟用户补充信息或作出选择，只有全部轮次将用户带到目标工作区才算完成。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

process.env.NODE_ENV='test';
const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const {agentChat}=await import(join(ROOT,'server.mjs'));
const CASES=JSON.parse(readFileSync(join(ROOT,'test/fixtures/task-trajectory-cases.json'),'utf8'));
if(!process.env.DASHSCOPE_API_KEY)throw new Error('DASHSCOPE_API_KEY 未配置');
const ACTIONS=new Set(['open_diy','open_restaurants','open_meal_choice']);
const limit=Math.max(1,Math.min(CASES.length,Number(process.env.TASK_TRAJECTORY_EVAL_LIMIT)||CASES.length));
const concurrency=Math.max(1,Math.min(10,Number(process.env.TASK_TRAJECTORY_EVAL_CONCURRENCY)||6));
const progress=process.env.TASK_TRAJECTORY_EVAL_PROGRESS==='1';
const profile={name:'轨迹评测用户',age:30,sex:'female',height:165,weight:60,targetWeight:58,targetDate:new Date(Date.now()+60*86400000).toISOString().slice(0,10),activity:'sedentary',budgetAdjustmentKcal:0};
const invalid=CASES.filter(item=>!item.id||!item.start||!item.followup||!item.completion||!Array.isArray(item.expected)||item.expected.length!==2||item.expected.some(action=>!ACTIONS.has(action)));
if(invalid.length)throw new Error(`任务夹具不合法：${invalid.map(item=>item.id).join('、')}`);
if(new Set(CASES.map(item=>item.id)).size!==CASES.length)throw new Error('任务夹具存在重复 id');

function isSuccess(out,expected){
  const routing=out.routing||{};
  return out.action?.type===expected&&routing.routerAction===expected&&routing.actionSource==='router'&&Boolean(String(out.answer||'').trim());
}
async function runCase(item,index){
  const history=[],turns=[];
  const started=Date.now(),clientId=`task-trajectory-eval:${item.id}`;
  for(const [turnIndex,message] of [item.start,item.followup].entries()){
    try{
      const out=await agentChat({message,history,clientId,profile});
      const actual=String(out.action?.type||'none'),success=isSuccess(out,item.expected[turnIndex]);
      turns.push({expected:item.expected[turnIndex],actual,success});
      history.push({role:'user',content:message},{role:'assistant',content:String(out.answer||'')});
      if(!success)break;
    }catch(error){turns.push({expected:item.expected[turnIndex],actual:'error',success:false,error:error.message});break}
  }
  const row={index,id:item.id,category:item.category,completion:item.completion,turns,success:turns.length===2&&turns.every(turn=>turn.success),ms:Date.now()-started};
  if(progress)console.log(`进度 ${index+1}/${selected.length} ${row.success?'✓':'✗'} ${row.id}`);
  return row;
}
const selected=CASES.slice(0,limit);let next=0;
const rows=(await Promise.all(Array.from({length:Math.min(concurrency,selected.length)},async()=>{
  const result=[];while(next<selected.length){const index=next++;result.push(await runCase(selected[index],index));}return result;
}))).flat().sort((a,b)=>a.index-b.index);
const completed=rows.filter(row=>row.success);
const percentage=(value,total)=>total?`${(value/total*100).toFixed(1)}%`:'-';
console.log(`\n===== Task Trajectory（${rows.length} 条，并发 ${concurrency}）=====`);
for(const row of rows)console.log(`${row.success?'✓':'✗'} ${row.category.padEnd(20)} ${row.id.padEnd(16)} ${row.turns.map(turn=>`${turn.expected}→${turn.actual}`).join(' | ')}${row.success?` → ${row.completion}`:''} ${(row.ms/1000).toFixed(1)}s`);
console.log('\n===== Task Completion 指标 =====');
console.log(`  任务数       ${rows.length}`);
console.log(`  Agent 任务成功 ${completed.length}/${rows.length}  ${percentage(completed.length,rows.length)}`);
console.log(`  模拟完成     ${completed.length}/${rows.length}  ${percentage(completed.length,rows.length)}`);
for(const category of [...new Set(rows.map(row=>row.category))]){const group=rows.filter(row=>row.category===category),ok=group.filter(row=>row.success).length;console.log(`  ${category.padEnd(20)} ${ok}/${group.length}  ${percentage(ok,group.length)}`)}
const failed=rows.filter(row=>!row.success);
if(failed.length){console.log('\n===== 未完成任务 =====');for(const row of failed){const bad=row.turns.find(turn=>!turn.success);console.log(`- ${row.id}：期望 ${bad?.expected||'-'}，实际 ${bad?.actual||'-'}${bad?.error?`；${bad.error}`:''}`)}}
if(failed.length)process.exitCode=1;
