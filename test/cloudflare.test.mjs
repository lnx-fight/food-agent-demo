import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import '../scripts/build-pages.mjs';
import {sqlStatements} from '../scripts/sql-statements.mjs';

test('Pages 使用真实 workerd + D1：身份、原子同步、重启持久化和资源隔离',async t=>{
  const persist=await mkdtemp(join(tmpdir(),'xiaofan-d1-'));
  let recipeModelCalls=0;
  const options={modules:true,scriptPath:new URL('../dist/_worker.js',import.meta.url).pathname,compatibilityDate:'2026-10-16',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'test-db'},resourcePersistencePath:persist,bindings:{DASHSCOPE_API_KEY:'test-key'},outboundService:async request=>{const payload=await request.json();if(JSON.stringify(payload.messages||[]).includes('根据以下真实可用食材')){recipeModelCalls++;return Response.json({choices:[{message:{content:JSON.stringify({name:'番茄鸡胸肉',ingredients:[{name:'去皮清肉平均值',grams:recipeModelCalls===1?150:180},{name:'红番茄',grams:150}],steps:['将去皮清肉平均值切片，红番茄切块。','锅中加入水，放入去皮清肉平均值和红番茄加热至鸡肉全熟。'],minutes:15,waterMl:30})}}]})}return Response.json({data:[{embedding:[1,0,0]}],choices:[{message:{content:JSON.stringify({answer:'营养查询已完成',intent:'nutrition',action:{type:'none'}})}}]})},serviceBindings:{ASSETS:()=>new Response('public asset')}};
  let mf=new Miniflare(convertV4MiniflareOptions(options));
  async function call(path,{method,body,cookie,version,headers={}}={}){
    const response=await mf.dispatchFetch('https://xiaofan.test'+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan',...(cookie?{Cookie:cookie}:{}),...(version===undefined?{}:{'X-State-Version':String(version)}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
    return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  try{
    const db=await mf.getD1Database('DB');
    for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()){
      const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');
      // Migration files contain complete SQL statements; preserve newlines in literals.
      const statements=sqlStatements(sql);
      for(let i=0;i<statements.length;i+=40)await db.batch(statements.slice(i,i+40).map(sql=>db.prepare(sql)));
    }
    const health=await call('/api/health');assert.equal(health.data.foodCount,0);assert.equal(health.data.authoritativeFoodCount,2213);assert.equal(health.data.recipeCount,20);
    assert.equal((await call('/api/user/state')).status,401);
    assert.equal((await call('/api/recipes')).status,401);
    const publicFoods=await call('/api/food-catalog?q='+encodeURIComponent('米饭')+'&category=all');assert.equal(publicFoods.status,200);assert.equal(publicFoods.data.foods[0].id,'tfda:A0550601');assert.equal(publicFoods.headers.get('set-cookie'),null);
    const publicCategories=await call('/api/food-catalog/categories');assert.equal(publicCategories.data.total,2213);
    const publicDetail=await call('/api/food-catalog/details?id=tfda:A0550601');assert.equal(publicDetail.status,200);assert.equal(publicDetail.data.result.nutrients.length,104);
    assert.equal((await call('/api/device/session')).data.device,null);
    const alice=await call('/api/device/session',{body:{}});
    assert.equal(alice.status,201,JSON.stringify(alice.data));
    assert.match(alice.headers.get('set-cookie'),/Secure/);
    const cookie=alice.cookie;
    const recipes=await call('/api/recipes',{cookie});assert.equal(recipes.status,200);assert.equal(recipes.data.total,20);
    const recipe=await call('/api/recipes/details?id=home-001',{cookie});assert.equal(recipe.status,200);assert.equal(recipe.data.recipe.name,'西红柿炒蛋');assert.equal(recipe.data.recipe.ingredients.length,4);assert.equal(recipe.data.recipe.nutrition.kcal,120.87);
    assert.equal((await call('/api/recipes/details?id=home-999',{cookie})).status,404);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM recipe_ingredients i LEFT JOIN nutrition_foods f ON f.food_id=i.food_id WHERE f.food_id IS NULL').first()).n,0);
    const diyInput={ingredients:['鸡胸肉','番茄'],pantry:[],cookTime:'20分钟',cookTools:'炒锅 + 电饭煲',mealType:'午餐',profile:{tastePreference:'不辣'},today:{}};
    const seedHit=await call('/api/recipes/diy',{cookie,body:{...diyInput,ingredients:['鸡蛋','番茄'],pantry:['食用植物油','食盐']}});assert.equal(seedHit.status,200);assert.equal(seedHit.data.result.generatedBy,'library');assert.equal(seedHit.data.result.recipe.id,'home-001');
    const concurrent=await Promise.all([call('/api/recipes/diy',{cookie,body:diyInput}),call('/api/recipes/diy',{cookie,body:diyInput})]);
    for(const response of concurrent){assert.equal(response.status,200,JSON.stringify(response.data));assert.ok(['qwen','library'].includes(response.data.result.generatedBy));}
    const reused=await call('/api/recipes/diy',{cookie,body:diyInput});assert.equal(reused.status,200);assert.equal(reused.data.result.generatedBy,'library');
    const generatedRecipeId=reused.data.result.recipe.id;
    for(const response of concurrent)assert.deepEqual(response.data.result.recipe.ingredients.map(item=>[item.foodId,item.grams]),reused.data.result.recipe.ingredients.map(item=>[item.foodId,item.grams]));
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM recipes WHERE origin='llm'").first()).n,1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM recipe_ingredients WHERE recipe_id=?').bind(generatedRecipeId).first()).n,2);
    assert.equal((await call('/api/recipes/details?id='+generatedRecipeId,{cookie})).data.recipe.name,'番茄鸡胸肉');
    assert.equal((await call('/api/health')).data.seedRecipeCount,20);
    const bob=await call('/api/device/session',{body:{}});
    assert.equal(bob.status,201,JSON.stringify(bob.data));
    const again=await call('/api/device/session',{body:{},cookie});assert.equal(again.status,200);assert.equal(again.data.device.id,alice.data.device.id);
    assert.equal((await call('/api/auth/login',{body:{username:'alice',password:'disabled'}})).status,410);
    assert.equal(health.data.nutritionSource,'TFDA');assert.equal(health.data.nutrientRecordCount,230152);
    const dataset=await call('/api/nutrition/dataset-search?q='+encodeURIComponent('肉粽'),{cookie});assert.equal(dataset.status,200);assert.ok(dataset.data.results.length>0);
    const zongzi=await call('/api/nutrition/search?q='+encodeURIComponent('肉粽'),{cookie});assert.equal(zongzi.status,200);assert.equal(zongzi.data.result.id,'tfda:R0400101');assert.equal(zongzi.data.needsClarification,false);assert.deepEqual(zongzi.data.candidates,[]);
    const frozen=await call('/api/nutrition/search?q='+encodeURIComponent('冷凍蝦仁炒飯'),{cookie});assert.equal(frozen.status,200);assert.equal(frozen.data.result.name,'冷冻虾仁炒饭');
    for(const name of ['回锅肉','牛肉汉堡','虾仁炒饭'])assert.equal((await call('/api/nutrition/search?q='+encodeURIComponent(name),{cookie})).status,404,name);
    const rice=await call('/api/nutrition/search?q='+encodeURIComponent('米饭'),{cookie});assert.equal(rice.status,200);assert.equal(rice.data.result.id,'tfda:A0550601');assert.equal(rice.data.result.per100g.kcal,182);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('foods','aliases','candidates','authoritative_foods','authoritative_foods_fts')").first()).n,0);
    const detail=await call('/api/nutrition/details?q=tfda:A0550601',{cookie});assert.equal(detail.status,200);assert.equal(detail.data.result.records.length,104);
    assert.equal((await call('/api/nutrition/search?q=fdc:168878',{cookie})).status,404);
    const state={profile:{age:30,weight:70,height:170,targetWeight:65,targetDate:'2027-01-01'},mealLogs:[{id:'lunch',date:'2026-10-16',type:'午餐',name:'鸡蛋',calories:150,protein:12}],weightLogs:[{date:'2026-10-16',weight:70}]};
    const saved=await call('/api/user/state',{method:'PUT',body:state,cookie,version:0});
    assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.stateVersion,1);
    assert.equal(saved.data.state.mealLogs[0].name,'鸡蛋');
    const writes=await Promise.all([71,72].map(weight=>call('/api/user/state',{method:'PUT',body:{...state,profile:{...state.profile,weight}},cookie,version:1})));
    assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);
    assert.equal((await call('/api/user/state',{cookie:bob.cookie})).data.state,null);
    const exported=await call('/api/device/export',{cookie});
    assert.equal(exported.status,200);assert.equal(exported.data.state.mealLogs[0].name,'鸡蛋');assert.equal(exported.data.account.password_hash,undefined);
    assert.equal((await call('/api/nutrition/search?q='+encodeURIComponent('鸡蛋'),{cookie})).status,200);
    const agent=await call('/api/agent/chat',{cookie,body:{message:'鸡胸肉每100克有多少热量和蛋白质？',profile:state.profile}});assert.equal(agent.status,200,JSON.stringify(agent.data));assert.equal(agent.data.result.goal.state,'completed');assert.ok(agent.data.result.toolLog.some(entry=>entry.tool==='search_nutrition'&&entry.ok));
    assert.equal((await call('/api/user/state',{method:'PUT',body:state,cookie,version:2,headers:{Origin:'https://evil.test'}})).status,403);
    assert.equal((await call('/server.mjs')).status,404);assert.equal((await call('/.env')).status,404);assert.equal((await call('/')).status,200);
    await mf.dispose();mf=new Miniflare(convertV4MiniflareOptions(options));
    assert.equal((await call('/api/recipes',{cookie})).data.total,21);
    assert.equal((await call('/api/recipes/diy',{cookie,body:diyInput})).data.result.recipe.id,generatedRecipeId);
    const restored=await call('/api/user/state',{cookie});
    assert.equal(restored.status,200);assert.equal(restored.data.stateVersion,2);assert.equal(restored.data.state.mealLogs.length,1);
    const cleared=await call('/api/device/clear',{cookie,body:{confirmation:'清空数据'}});
    assert.equal(cleared.status,200,JSON.stringify(cleared.data));
    assert.equal((await call('/api/user/state',{cookie})).status,401);
    assert.equal((await call('/api/user/state',{cookie:cleared.cookie})).data.state,null);
  }finally{await mf.dispose();await rm(persist,{recursive:true,force:true})}
});
