import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {recipeRequirements,recipeFoodAllowed,recipeContext,saveGeneratedRecipe,validateRecipePlan} from '../recipe-reuse.mjs';

process.env.NODE_ENV='test';
process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-reuse-'));
process.env.DASHSCOPE_API_KEY='';
const {createDiyRecipe,executeAgentTool}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
after(()=>db.close());
const input={ingredients:['鸡胸肉','西红柿'],pantry:[],cookTime:'20分钟',cookTools:'炒锅 + 电饭煲',mealType:'午餐',profile:{tastePreference:'不辣'},today:{}};
const valid={name:'番茄鸡胸肉',ingredients:[{name:'去皮清肉平均值',grams:150},{name:'红番茄',grams:150}],steps:['将去皮清肉平均值切成薄片，红番茄洗净切块。','锅中加入少量水，放入去皮清肉平均值和红番茄，加热至鸡肉完全熟透。'],minutes:15,waterMl:30};
async function withModel(plan,run){
  const original=globalThis.fetch,key=process.env.DASHSCOPE_API_KEY;process.env.DASHSCOPE_API_KEY='test-only';let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;const payload=JSON.parse(options.body);assert.equal(payload.model,process.env.QWEN_RECIPE_MODEL||'qwen3.7-flash');assert.equal(payload.enable_thinking,false);return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]})};
  try{return await run(()=>calls)}finally{globalThis.fetch=original;process.env.DASHSCOPE_API_KEY=key}
}
test('预置菜命中不调用模型，按实际可用油品重新计算，不添加未勾选的调料',async()=>{
  await withModel({},async calls=>{
    const r=await createDiyRecipe({...input,ingredients:['番茄','鸡蛋'],pantry:['食用植物油','食盐']});
    assert.equal(r.generatedBy,'library');assert.equal(r.cache.recipeId,'home-001');assert.equal(calls(),0);
    assert.ok(r.recipe.ingredients.some(item=>item.foodId==='tfda:M9900201'&&item.grams===4));
    assert.ok(r.recipe.ingredients.some(item=>item.foodId==='tfda:P0300101'&&item.grams===.5));
    assert.equal(r.recipe.nutrition.kcal,121);
  });
  const noPantry=await createDiyRecipe({...input,ingredients:['番茄','鸡蛋'],pantry:[]});
  assert.notEqual(noPantry.generatedBy,'library');assert.ok(noPantry.recipe.ingredients.every(item=>!item.name.includes('油')));
});
test('未命中调用一次模型，通过校验后入库，别名/顺序变化复用并重算当前目标',async()=>{
  await withModel(valid,async calls=>{
    const first=await createDiyRecipe(input);assert.equal(first.generatedBy,'qwen');assert.equal(first.cache.status,'saved');assert.equal(calls(),1);
    const stored=db.prepare('SELECT * FROM recipes WHERE id=?').get(first.recipe.id);assert.equal(stored.origin,'llm');assert.equal(JSON.parse(stored.provenance).model,process.env.QWEN_RECIPE_MODEL||'qwen3.7-flash');assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_ingredients WHERE recipe_id=?').get(first.recipe.id).n,2);
    const next=await createDiyRecipe({...input,ingredients:['西红柿','生鸡胸肉']});assert.equal(next.generatedBy,'library');assert.equal(next.recipe.id,first.recipe.id);assert.equal(calls(),1);assert.deepEqual(next.recipe.nutrition,first.recipe.nutrition);
    const changed=await createDiyRecipe({...input,profile:{tastePreference:'不辣',allergies:'鸡肉'}});assert.notEqual(changed.recipe.id,first.recipe.id);assert.ok(changed.recipe.ingredients.every(item=>!item.name.includes('清肉')));
  });
});
test('时间、厨具、口味与忌口不同不会误复用，非法克数及未列入配料的油不写入',async()=>{
  const before=db.prepare('SELECT COUNT(*) n FROM recipes').get().n;
  await withModel({...valid,ingredients:[{name:'去皮清肉平均值',grams:-10},{name:'红番茄',grams:150}]},async()=>{
    const r=await createDiyRecipe({...input,cookTime:'10分钟'});assert.equal(r.generatedBy,'rules');assert.equal(r.cache.reason,'model_or_validation_failed');
  });
  await withModel({...valid,steps:['将去皮清肉平均值和红番茄放入锅中翻炒至熟。']},async()=>{
    const r=await createDiyRecipe({...input,cookTools:'只有微波炉'});assert.equal(r.generatedBy,'rules');assert.match(r.recipe.steps.join(' '),/微波炉/);
  });
  await withModel({...valid,steps:['将去皮清肉平均值和红番茄放入锅中，添加大豆油炒熟。']},async()=>{
    const r=await createDiyRecipe({...input,profile:{tastePreference:'微辣'}});assert.equal(r.generatedBy,'rules');
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes').get().n,before);
  await assert.rejects(createDiyRecipe({...input,ingredients:['鸡蛋'],profile:{allergies:'蛋'}}),/忌口冲突/);
  assert.equal(recipeFoodAllowed({name:'酱油',description:'黄豆、小麦'},recipeRequirements({allergies:'大豆'})),false);
  assert.equal(recipeFoodAllowed({name:'草虾仁',category:'鱼贝类'},recipeRequirements({preferences:'不吃海鲜'})),false);
  assert.equal(recipeFoodAllowed({name:'鸡蛋',category:'蛋类'},recipeRequirements({preferences:'纯素'})),false);
});
test('手动营养及不完整的TFDA宏量营养不进入共享缓存，模型失败不保存规则食谱',async()=>{
  const before=db.prepare('SELECT COUNT(*) n FROM recipes').get().n;
  await withModel({name:'自备食材',ingredients:[{name:'自备食材',grams:100}],steps:['把自备食材按份量放入盘中。'],minutes:5},async calls=>{
    const r=await createDiyRecipe({...input,ingredients:['自备食材'],customFoods:[{name:'自备食材',kcal:80,protein:8,fat:2,carbs:5}]});assert.equal(r.cache.status,'not_saved');assert.equal(r.cache.reason,'unverified_ingredients');assert.equal(calls(),1);
  });
  await withModel({name:'冰糖蛋羹',ingredients:[{name:'鸡蛋平均值',grams:50},{name:'冰糖',grams:5}],steps:['将鸡蛋平均值和冰糖放入碗中，加水搅匀后用微波炉加热至全熟。'],minutes:10},async()=>{
    const r=await createDiyRecipe({...input,ingredients:['鸡蛋','冰糖'],cookTools:'只有微波炉'});assert.equal(r.cache.status,'not_saved');assert.equal(r.recipe.nutrition.protein,null);
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes').get().n,before);
});
test('保存批次原子化；相同请求去重，不混入第二份响应的配料',async()=>{
  const foods=[{id:'tfda:I04024',name:'去皮清肉平均值',category:'肉类',kcal:119,protein:23.3,fat:2.1,carbs:0},{id:'tfda:E7400102',name:'红番茄',category:'蔬菜类',kcal:18,protein:.9,fat:0,carbs:4.4}];
  const context=await recipeContext({...input,profile:{preferences:'家常菜'}},foods,foods,{mealType:'午餐',mealKcal:500,mealProtein:30},'test');
  assert.throws(()=>validateRecipePlan({...valid,ingredients:[{name:'红番茄',grams:'150'}]},foods,context),/克数无效/);
  const a=await saveGeneratedRecipe(db,valid,foods,context,{release:'test',model:'test'});
  const b=await saveGeneratedRecipe(db,{...valid,ingredients:[{name:'红番茄',grams:90}]},foods,context,{release:'test',model:'test'});
  assert.equal(a.recipeId,b.recipeId);assert.equal(a.inserted,true);assert.equal(b.inserted,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_ingredients WHERE recipe_id=?').get(a.recipeId).n,2);
  const invalidContext={...context,cacheKey:'rollback-case'};
  db.exec("CREATE TRIGGER reject_test_ingredient BEFORE INSERT ON recipe_ingredients WHEN NEW.grams=123 BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
  await assert.rejects(saveGeneratedRecipe(db,{...valid,ingredients:[{name:'红番茄',grams:123}]},foods,invalidContext,{release:'test',model:'test'}),/test rollback/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes WHERE cache_key=?').get('rollback-case').n,0);
});

test('Agent食谱工具同样优先复用预置配方，不调用模型',async()=>{
  await withModel({},async calls=>{
    const r=await executeAgentTool('compose_diy_recipe',{ingredients:['鸡蛋','番茄'],pantry:['食用植物油','食盐'],cookTime:'20分钟',cookTools:'普通厨具',mealType:'午餐'},{profile:{tastePreference:'不辣'},today:{}});
    assert.equal(r.ok,true);assert.equal(r.result.generatedBy,'library');assert.equal(r.result.recipe.id,'home-001');assert.equal(calls(),0);
  });
});

test('空气炸锅中不误判为炒锅；相同厨具生成后可再次复用',async()=>{
  const airPlan={...valid,steps:['将去皮清肉平均值切片，红番茄切块。','将去皮清肉平均值和红番茄放入空气炸锅中，加热至鸡肉完全熟透。']};
  await withModel(airPlan,async calls=>{
    const first=await createDiyRecipe({...input,cookTools:'空气炸锅'});assert.equal(first.generatedBy,'qwen');assert.equal(first.cache.status,'saved');
    const next=await createDiyRecipe({...input,cookTools:'空气炸锅'});assert.equal(next.generatedBy,'library');assert.equal(calls(),1);
  });
});

test('千问免费额度耗尽时明确告知降级，不写入共享菜谱',async()=>{
  const original=globalThis.fetch,key=process.env.DASHSCOPE_API_KEY,before=db.prepare('SELECT COUNT(*) n FROM recipes').get().n;process.env.DASHSCOPE_API_KEY='test-only';
  globalThis.fetch=async()=>Response.json({error:{message:'Free quota exhausted.',code:'AllocationQuota.FreeTierOnlyQuotaExhausted'}},{status:403});
  try{
    const r=await createDiyRecipe({...input,cookTime:'30分钟',profile:{tastePreference:'中辣'}});
    assert.equal(r.generatedBy,'rules');assert.equal(r.cache.reason,'model_quota_exhausted');assert.match(r.generationNotice,/免费额度已用完/);assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes').get().n,before);
  }finally{globalThis.fetch=original;process.env.DASHSCOPE_API_KEY=key}
});
