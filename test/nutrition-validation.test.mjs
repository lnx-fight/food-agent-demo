import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// 使用独立数据库，不写入开发者的用户档案或复盘记忆。
process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-nutrition-validation-'));
process.env.DASHSCOPE_API_KEY='';
const {candidateNutrition,runAgentReview}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
after(()=>db.close());

const candidate={name:'测试品牌食品 200克/份',basis:'perServing',servingGrams:200,kcal:400,protein:20,fat:10,carbs:50,sourceUrl:'https://example.com/nutrition',confidence:'medium'};

test('品牌食品每份数据按明确克数换算，不把一份热量当作每100克',()=>{
  const result=candidateNutrition(candidate,'测试食品');
  assert.deepEqual(result.per100g,{kcal:200,protein:10,fat:5,carbs:25});
  assert.equal(result.confidence,'medium');
  assert.equal(result.source.url,candidate.sourceUrl);
  assert.equal(result.per100g.kcal*200/100,400);
});

test('缺少每份克数、仅有毫升、未知单位时不得进入按克计算',()=>{
  for(const servingGrams of [null,undefined,'',0,-1,'200ml',Infinity]){
    assert.equal(candidateNutrition({...candidate,servingGrams},'测试食品'),null);
  }
  for(const basis of ['per100ml','perBottle','',undefined]){
    assert.equal(candidateNutrition({...candidate,basis},'测试食品'),null);
  }
});

test('每100克原值不再次换算；缺失宏量素保持未知，零值保留',()=>{
  const result=candidateNutrition({...candidate,basis:'per100g',protein:null,fat:0,carbs:undefined},'测试食品');
  assert.deepEqual(result.per100g,{kcal:400,protein:null,fat:0,carbs:null});
});

test('无来源、缺失或非法热量不会形成可计算候选',()=>{
  for(const kcal of [null,undefined,'','NaN',Infinity,-1])assert.equal(candidateNutrition({...candidate,kcal},'测试食品'),null);
  for(const sourceUrl of ['',null,'file:///tmp/table','not a url'])assert.equal(candidateNutrition({...candidate,sourceUrl},'测试食品'),null);
});

function incompleteUser(clientId){
  const profile={age:30,sex:'female',height:165,weight:65,targetWeight:60,targetDate:'2027-10-14',budgetAdjustmentKcal:50};
  const now=new Date().toISOString();
  const row=db.prepare('INSERT INTO users(client_id,profile,budget_adjustment_kcal,created_at,updated_at) VALUES(?,?,?,?,?)').run(clientId,JSON.stringify(profile),50,now,now);
  const userId=Number(row.lastInsertRowid);
  const anchor=new Date(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())+'T00:00:00Z');
  for(let i=13;i>=0;i--){
    const date=new Date(anchor.getTime()-i*86400000).toISOString().slice(0,10);
    db.prepare('INSERT INTO weight_logs(user_id,date,weight,source,recorded_at) VALUES(?,?,?,?,?)').run(userId,date,65-i*.05,'test',now);
  }
  return userId;
}

test('记录不足时，模型降低预算和生成补偿任务的输出被服务端拦截',async()=>{
  const clientId='nutrition-validation-incomplete-llm',userId=incompleteUser(clientId);
  const originalFetch=globalThis.fetch,savedKey=process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY='test-only-key';
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({adjustment:-100,strategy:'少吃一顿',taskText:'跳过晚餐'})}}]})});
  try{
    const result=await runAgentReview(clientId);
    assert.equal(result.complete,false);
    assert.equal(result.adjustment,50);
    assert.match(result.strategy,/记录不足/);
    assert.match(result.message,/本轮未调整/);
    assert.equal(db.prepare('SELECT budget_adjustment_kcal value FROM users WHERE id=?').get(userId).value,50);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM agent_tasks WHERE user_id=?').get(userId).count,0);
  }finally{globalThis.fetch=originalFetch;process.env.DASHSCOPE_API_KEY=savedKey}
});

test('规则降级不因体重上升和漏记而继续降低预算',async()=>{
  const clientId='nutrition-validation-incomplete-rules';
  incompleteUser(clientId);
  const result=await runAgentReview(clientId);
  assert.equal(result.decidedBy,'rules');
  assert.ok(result.trend.deltaWeek>0);
  assert.equal(result.complete,false);
  assert.equal(result.adjustment,50);
  assert.match(result.message,/本轮未调整/);
});
