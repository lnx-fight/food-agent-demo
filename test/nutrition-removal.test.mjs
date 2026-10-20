import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-remove-reference-'));
process.env.DASHSCOPE_API_KEY='';process.env.USDA_API_KEY='';
const legacy=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
legacy.exec("CREATE TABLE foods(id INTEGER PRIMARY KEY,name TEXT,kcal REAL); INSERT INTO foods VALUES(1,'旧估算食品',250); CREATE TABLE aliases(food_id INTEGER,alias TEXT); CREATE TABLE candidates(name TEXT); CREATE TABLE reference_foods(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO reference_foods VALUES('old-reference','{}')");
legacy.close();
const {resolveNutrition,upsertUser}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
after(()=>db.close());

test('启动迁移删除旧食品、别名及候选表，只保留USDA并保留历史饮食',async()=>{
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reference_foods'").get(),undefined);
  for(const table of ['foods','aliases','candidates'])assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM authoritative_foods').get().n,13588);
  const result=await resolveNutrition('熟白米饭');
  assert.equal(result.source,'authoritative_database');assert.equal(result.nutrition.per100g.kcal,130);
  const meal={id:'saved-meal',date:'2026-10-15',type:'早餐',name:'历史餐食',calories:200,protein:10,amount:1,unit:'serving',referenceId:'old-reference',source:'已确认估算'};
  const saved=(await upsertUser('remove-reference-user',{profile:{},mealLogs:[meal],weightLogs:[]}));
  assert.equal(saved.mealLogs[0].id,meal.id);assert.equal(saved.mealLogs[0].calories,200);assert.equal(saved.mealLogs[0].referenceId,'old-reference');
});

test('文字记餐和菜单估算只读取 USDA；不再拿部分食材代替复杂菜品',async()=>{
  const {estimateTextMealRecord,estimateMenuDish}=await import('../server.mjs');
  const meal=await estimateTextMealRecord('吃了100克米饭');assert.equal(meal.ok,true);assert.equal(meal.calories,130);assert.match(meal.source,/USDA/);
  assert.equal((await estimateTextMealRecord('吃了100克芝士培根牛肉汉堡')).ok,false);
  assert.equal(await estimateMenuDish('芝士培根牛肉汉堡'),null);
  assert.equal((await estimateMenuDish('牛肉汉堡')).source.id,'170693');
});


test('配置千问密钥时，中文营养检索命中和未命中均不发出外部请求',async()=>{
  const originalFetch=globalThis.fetch,savedKey=process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY='test-only-key';let requests=0;
  globalThis.fetch=async()=>{requests++;throw new Error('Nutrition search must not use external services')};
  try{
    assert.equal((await resolveNutrition('牛肉汉堡')).nutrition.id,'fdc:170693');
    assert.match((await resolveNutrition('牛油果')).nutrition.originalName,/avocado/i);
    const missing=await resolveNutrition('完全未收录的测试餐食');assert.equal(missing.nutrition,null);assert.match(missing.question,/中文检索词库/);
    assert.equal(requests,0);
  }finally{globalThis.fetch=originalFetch;process.env.DASHSCOPE_API_KEY=savedKey}
});
