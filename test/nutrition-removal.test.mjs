import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-remove-reference-'));
process.env.DASHSCOPE_API_KEY='';process.env.USDA_API_KEY='';
const legacy=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
legacy.exec("CREATE TABLE reference_foods(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO reference_foods VALUES('old-reference','{}')");
legacy.close();
const {resolveNutrition,upsertUser}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
after(()=>db.close());

test('启动迁移清除旧社区参考库，基础食品查询和历史饮食同步仍可用',async()=>{
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reference_foods'").get(),undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM foods').get().n,300);
  const result=await resolveNutrition('熟白米饭',{allowWeb:false});
  assert.equal(result.source,'local_database');assert.equal(result.nutrition.per100g.kcal,116);
  const meal={id:'saved-meal',date:'2026-10-15',type:'早餐',name:'历史餐食',calories:200,protein:10,amount:1,unit:'serving',referenceId:'old-reference',source:'已确认估算'};
  const saved=(await upsertUser('remove-reference-user',{profile:{},mealLogs:[meal],weightLogs:[]}));
  assert.equal(saved.mealLogs[0].id,meal.id);assert.equal(saved.mealLogs[0].calories,200);assert.equal(saved.mealLogs[0].referenceId,'old-reference');
});
