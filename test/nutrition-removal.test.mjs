import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-tfda-migration-'));
process.env.DASHSCOPE_API_KEY='';
const legacy=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
legacy.exec(readFileSync(new URL('../migrations/0001_schema.sql',import.meta.url),'utf8'));
legacy.exec(readFileSync(new URL('../migrations/0003_authoritative_foods.sql',import.meta.url),'utf8'));
legacy.exec("INSERT INTO authoritative_foods(fdc_id,name,kcal,data_type,release,source_url) VALUES(168878,'Legacy USDA rice',130,'old','old','https://fdc.nal.usda.gov/');CREATE TABLE reference_foods(id TEXT PRIMARY KEY,payload TEXT);INSERT INTO reference_foods VALUES('old-reference','{}');INSERT INTO accounts VALUES('existing-account','existing_user','existing-hash','existing-client',7,'2026-10-19');INSERT INTO users(id,client_id,profile,chat_history,created_at,updated_at) VALUES(1,'existing-client','{}','[]','2026-10-19','2026-10-19');INSERT INTO meal_logs(user_id,date,type,name,calories,protein,source,details) VALUES(1,'2026-10-19','午餐','历史米饭',130,2.69,'USDA','{\"nutritionSource\":\"USDA\",\"referenceId\":\"fdc:168878\"}');");
legacy.close();
const {resolveNutrition,upsertUser,estimateTextMealRecord,estimateMenuDish}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
after(()=>db.close());

test('切换为食药署并删除USDA表，原账号与已确认摄入保持原值和来源',async()=>{
  for(const table of ['foods','aliases','candidates','reference_foods','authoritative_foods','authoritative_foods_fts'])assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),undefined,table);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nutrition_foods').get().n,2213);
  assert.equal(db.prepare('SELECT password_hash FROM accounts WHERE id=?').get('existing-account').password_hash,'existing-hash');
  const previous=db.prepare('SELECT * FROM meal_logs WHERE user_id=1').get();assert.equal(previous.calories,130);assert.equal(previous.protein,2.69);assert.equal(previous.source,'USDA');assert.equal(JSON.parse(previous.details).referenceId,'fdc:168878');
  const result=await resolveNutrition('熟白米饭');assert.equal(result.nutrition.per100g.kcal,182);assert.equal(result.nutrition.source.code,'TFDA');
  const meal={id:'saved-meal',date:'2026-10-15',type:'早餐',name:'历史餐食',calories:200,protein:10,amount:1,unit:'serving',referenceId:'old-reference',source:'已确认估算'};
  const saved=await upsertUser('remove-reference-user',{profile:{},mealLogs:[meal],weightLogs:[]});assert.equal(saved.mealLogs[0].calories,200);assert.equal(saved.mealLogs[0].referenceId,'old-reference');
});

test('文字和菜单营养统一读取食药署，不用部分食材或USDA补全菜品',async()=>{
  const meal=await estimateTextMealRecord('吃了100克米饭');assert.equal(meal.ok,true);assert.equal(meal.calories,182);assert.match(meal.source,/食药署/);
  assert.equal((await estimateTextMealRecord('吃了100克回锅肉')).ok,false);assert.equal(await estimateMenuDish('牛肉汉堡'),null);
  assert.equal((await estimateMenuDish('肉粽')).source.id,'R0400101');
});

test('配置千问密钥时营养查询命中和未命中均不发出外部请求',async()=>{
  const originalFetch=globalThis.fetch,savedKey=process.env.DASHSCOPE_API_KEY;process.env.DASHSCOPE_API_KEY='test-only-key';let requests=0;
  globalThis.fetch=async()=>{requests++;throw new Error('Nutrition search must not use external services')};
  try{assert.equal((await resolveNutrition('肉粽')).nutrition.id,'tfda:R0400101');assert.ok((await resolveNutrition('牛油果')).nutrition);assert.equal((await resolveNutrition('回锅肉')).nutrition,null);assert.equal(requests,0)}finally{globalThis.fetch=originalFetch;process.env.DASHSCOPE_API_KEY=savedKey}
});

test('食药署分类适配主食、蛋白质和蔬菜，规则食谱保留实际用油和来源',async()=>{
  const {executeAgentTool}=await import('../server.mjs');
  const result=await executeAgentTool('compose_diy_recipe',{ingredients:['鸡胸肉','西红柿','米饭'],pantry:['食用植物油'],cookTime:'20分钟',mealType:'午餐'},{profile:{},today:{}});
  assert.equal(result.ok,true,JSON.stringify(result));
  const recipe=result.result.recipe;
  assert.ok(recipe.ingredients.some(item=>item.name==='白饭'));
  assert.ok(recipe.ingredients.some(item=>item.name==='去皮清肉平均值'));
  assert.ok(recipe.ingredients.some(item=>item.name==='红番茄'));
  assert.ok(recipe.ingredients.some(item=>item.name==='调合植物油'&&item.grams===5));
  assert.ok(recipe.steps.some(step=>step.includes('蛋白质类食材充分加热')));
  assert.ok(recipe.nutrition.kcal>0);
  const incomplete=await executeAgentTool('compose_diy_recipe',{ingredients:['鸡蛋','冰糖'],pantry:[],mealType:'早餐'},{profile:{},today:{}});
  assert.equal(incomplete.ok,true);assert.equal(incomplete.result.recipe.nutrition.protein,null);assert.equal(incomplete.result.recipe.nutrition.fat,null);
});
