import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {browseFoods,catalogCategories,catalogDetails} from '../food-catalog.mjs';
import {NUTRITION_MANIFEST} from '../nutrition-dataset.mjs';

const db=new DatabaseSync(':memory:');
for(const file of ['0007_tfda_schema.sql',...NUTRITION_MANIFEST.snapshotMigrations,'0009_tfda_activate.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
after(()=>db.close());
test('公开热量表完整覆盖2213个食品，分类无遗漏且显示为简体',async()=>{
 const result=await catalogCategories(db);assert.equal(result.total,2213);
 assert.equal(result.categories.filter(group=>!['all','common'].includes(group.id)).reduce((sum,item)=>sum+item.count,0),2213);
 const ids=new Set();
 for(const category of result.categories.filter(group=>!['all','common'].includes(group.id))){
  const first=await browseFoods(db,{category:category.id,limit:48});assert.equal(first.total,category.count);
  for(let page=1;page<=first.pages;page++)for(const food of (await browseFoods(db,{category:category.id,page,limit:48})).foods){assert.equal(ids.has(food.id),false);ids.add(food.id);assert.doesNotMatch(food.categoryLabel,/�/);assert.ok(Number.isFinite(food.per100g.kcal));assert.equal(food.originalName,undefined)}
 }
 assert.equal(ids.size,2213);
 const common=await browseFoods(db);assert.equal(common.total,14);assert.equal(common.foods[0].displayName,'米饭');assert.equal(common.foods[0].per100g.kcal,182);
});
test('列表搜索返回完整查询的多个样品，支持简繁体、别名和编号，不将整菜替换为食材',async()=>{
 for(const [q,id] of [['米饭','tfda:A0550601'],['土豆','tfda:B0700201'],['冷凍蝦仁炒飯','tfda:R0200201'],['tfda:A0550601','tfda:A0550601']]){
  const result=await browseFoods(db,{q,category:'all'});assert.ok(result.foods.some(food=>food.id===id),q);
 }
 const hamburger=await browseFoods(db,{q:'汉堡',category:'all'});assert.ok(hamburger.total>1);assert.ok(hamburger.foods.some(food=>/汉堡/.test(food.name)));
 const patties=await browseFoods(db,{q:'牛肉汉堡',category:'all'});assert.equal(patties.foods[0].name,'冷冻牛肉汉堡肉');assert.equal(patties.foods[0].displayName,'冷冻牛肉汉堡肉');assert.match(patties.foods[0].matchNote,/肉饼.*不能代表完整汉堡/);
 for(const q of ['回锅肉','炸鸡汉堡','fdc:168878','%','_','\';DROP TABLE nutrition_foods;--'])assert.equal((await browseFoods(db,{q,category:'all'})).total,0,q);
 assert.equal((await browseFoods(db,{q:'米饭',category:'fruit'})).total,0);
 await assert.rejects(()=>browseFoods(db,{category:'invalid'}),{status:400});
 const bounded=await browseFoods(db,{category:'all',limit:999999,page:-20});assert.equal(bounded.foods.length,48);assert.equal(bounded.page,1);
 const last=await browseFoods(db,{category:'all',page:999999});assert.equal(last.page,last.pages);assert.ok(last.foods.length>0);
});
test('公开营养详情保留未知、零和全部104项，换算依据始终是100克，不提供假定份量',async()=>{
 const detail=await catalogDetails(db,'tfda:A0550601');assert.equal(detail.food.per100g.kcal,182);assert.equal(detail.food.energyBasisLabel,'修正热量');assert.equal(detail.nutrients.length,104);
 assert.equal(detail.nutrients.find(item=>item.name==='热量').value,'183');assert.equal(detail.nutrients.find(item=>item.name==='修正热量').value,'182');
 const missing=await catalogDetails(db,'tfda:R5500201');assert.equal(missing.food.per100g.fiber,null);assert.equal(missing.nutrients.find(item=>item.name==='膳食纤维').value,null);assert.ok(missing.nutrients.some(item=>item.value!==null&&Number(item.value)===0));
 assert.equal(await catalogDetails(db,'fdc:168878'),null);assert.equal(await catalogDetails(db,'tfda:A99999999'),null);
});
test('未开始使用也能查询热量表，公开读取不创建会话或暴露个人接口',async()=>{
 process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-public-food-'));process.env.DASHSCOPE_API_KEY='';
 const {server}=await import('../server.mjs');server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 const read=async path=>{const response=await fetch(base+path);return {response,data:await response.json()}};
 try{
  const categories=await read('/api/food-catalog/categories');assert.equal(categories.response.status,200);assert.equal(categories.data.total,2213);assert.equal(categories.response.headers.get('set-cookie'),null);
  const rice=await read('/api/food-catalog?q='+encodeURIComponent('米饭')+'&category=all');assert.equal(rice.response.status,200);assert.equal(rice.data.foods[0].id,'tfda:A0550601');
  const detail=await read('/api/food-catalog/details?id=tfda:A0550601');assert.equal(detail.response.status,200);assert.equal(detail.data.result.nutrients.length,104);
  assert.equal((await read('/api/device/session')).data.device,null);
  for(const path of ['/api/user/state','/api/agent/memory','/api/food-catalog/private','/api/nutrition/search?q=米饭'])assert.equal((await read(path)).response.status,401,path);
  const rejected=await fetch(base+'/api/food-catalog',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan'},body:'{}'});assert.equal(rejected.status,401);
  const unknown=await read('/api/food-catalog?category=invalid');assert.equal(unknown.response.status,400);
  const local=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));try{assert.equal(local.prepare('SELECT COUNT(*) n FROM accounts').get().n,0)}finally{local.close()}
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
