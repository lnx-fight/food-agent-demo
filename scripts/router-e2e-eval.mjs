// 端到端 Router 评测：餐食与非餐食输入一起检查最终前端入口。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

process.env.NODE_ENV='test';
const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const {agentChat}=await import(join(ROOT,'server.mjs'));
const mealCases=JSON.parse(readFileSync(join(ROOT,'test/fixtures/meal-choice-cases.json'),'utf8'));
const nonMealCases=[
  ['other-01','今天天气怎么样'],['other-02','介绍一下你自己'],['other-03','鸡胸肉每100克多少热量'],['other-04','帮我翻译这句话'],['other-05','我糖尿病饮食要注意什么'],
  ['other-06','高血压患者晚饭吃什么'],['other-07','帮我算一下房贷利息'],['other-08','最近有什么电影'],['other-09','我昨天点了外卖'],['other-10','帮我记一下今天的体重']
].map(([id,message])=>({id,category:'non_meal',message,expectedAction:'none'}));
const CASES=[...mealCases,...nonMealCases];
if(!process.env.DASHSCOPE_API_KEY)throw new Error('DASHSCOPE_API_KEY 未配置');
const limit=Math.max(1,Math.min(CASES.length,Number(process.env.ROUTER_E2E_EVAL_LIMIT)||CASES.length));
const concurrency=Math.max(1,Math.min(10,Number(process.env.ROUTER_E2E_EVAL_CONCURRENCY)||6));
const profile={name:'端到端评测用户',age:30,sex:'female',height:165,weight:60,targetWeight:58,targetDate:new Date(Date.now()+60*86400000).toISOString().slice(0,10),activity:'sedentary',budgetAdjustmentKcal:0};
function percent(value,total){return total?`${(value/total*100).toFixed(1)}%`:'-'}
async function evaluate(item,index){
  try{
    const out=await agentChat({message:item.message,clientId:`router-e2e-eval:${item.id}`,profile});
    const actual=String(out.action?.type||'none');
    return {index,...item,actual,correct:actual===item.expectedAction,routeIntent:String(out.routing?.intent||''),scenario:String(out.routing?.mealScenario||''),error:''};
  }catch(error){return {index,...item,actual:'error',correct:false,routeIntent:'',scenario:'',error:error.message}}
}
const selected=CASES.slice(0,limit);let next=0;
const rows=(await Promise.all(Array.from({length:Math.min(concurrency,selected.length)},async()=>{const items=[];while(next<selected.length){const index=next++;items.push(await evaluate(selected[index],index));}return items}))).flat().sort((a,b)=>a.index-b.index);
const countable=rows.filter(row=>!row.error),correct=countable.filter(row=>row.correct);
console.log(`\n===== Router End-to-End（${rows.length} 条，并发 ${concurrency}）=====`);
for(const row of rows)console.log(`${row.error?'E':row.correct?'✓':'✗'} ${row.category.padEnd(18)} ${row.id.padEnd(16)} expected=${row.expectedAction.padEnd(16)} actual=${row.actual.padEnd(16)} intent=${row.routeIntent||'-'} scenario=${row.scenario||'-'}${row.error?` error=${row.error}`:''}`);
console.log('\n===== 端到端入口准确率 =====');
console.log(`  Overall  ${correct.length}/${countable.length}  ${percent(correct.length,countable.length)}`);
for(const category of [...new Set(rows.map(row=>row.category))]){const group=countable.filter(row=>row.category===category),ok=group.filter(row=>row.correct).length;console.log(`  ${category.padEnd(18)} ${ok}/${group.length}  ${percent(ok,group.length)}`)}
if(rows.some(row=>row.error))process.exitCode=1;
