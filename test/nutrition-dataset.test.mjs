import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {authoritativeFood,searchAuthoritativeFoods} from '../nutrition-dataset.mjs';

const db=new DatabaseSync(':memory:');
for(const file of ['0003_authoritative_foods.sql','0004_usda_snapshot.sql','0005_usda_search.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
after(()=>db.close());

test('USDA 快照行数、热量缺失和校验值与来源清单一致',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../data/usda/manifest.json',import.meta.url),'utf8'));
  const count=db.prepare('SELECT COUNT(*) total,COUNT(kcal) with_energy FROM authoritative_foods').get();
  assert.equal(count.total,manifest.totalRows);assert.equal(count.with_energy,manifest.rowsWithEnergy);
  const sql=readFileSync(new URL('../migrations/0004_usda_snapshot.sql',import.meta.url));
  assert.equal(createHash('sha256').update(sql).digest('hex'),manifest.sqlSha256);
  assert.equal(db.prepare('SELECT kcal FROM authoritative_foods WHERE fdc_id=2705383').get().kcal,null);
  assert.equal(db.prepare('SELECT kcal FROM authoritative_foods WHERE fdc_id=170679').get().kcal,0);
});

test('精确匹配可直接读取已下载的权威数据，保留每100g口径和原始来源',async()=>{
  const result=await authoritativeFood(db,'fdc:168878');
  assert.equal(result.per100g.kcal,130);assert.equal(result.per100g.protein,2.69);
  assert.equal(result.basis,'per100g');assert.equal(result.source.id,'168878');assert.equal(result.source.license,'CC0-1.0');
  assert.equal((await authoritativeFood(db,result.name)).id,result.id);
  assert.equal(await authoritativeFood(db,'fdc:2705383'),null);
});

test('全文检索返回供选择的原始菜名，SQL和FTS符号不能注入查询',async()=>{
  const results=await searchAuthoritativeFoods(db,'rice cooked',5);
  assert.equal(results.length,5);
  for(const result of results){assert.match(result.name,/rice/i);assert.match(result.name,/cooked/i);assert.notEqual(result.per100g.kcal,null)}
  assert.deepEqual(await searchAuthoritativeFoods(db,'"*'),[]);
  assert.deepEqual(await searchAuthoritativeFoods(db,"'; DROP TABLE authoritative_foods; --"),[]);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM authoritative_foods').get().count,13588);
});

const {resolveAuthoritativeNutrition}=await import('../nutrition-dataset.mjs');
const catalog=JSON.parse(readFileSync(new URL('../data/usda/chinese-foods.json',import.meta.url),'utf8'));
test('中文映射不储存营养值，每个 FDC 指向有热量的 USDA 原始记录',async()=>{
  const aliases=new Set();
  for(const item of catalog.foods){
    assert.ok(Object.keys(item).every(key=>['aliases','category','fdcId','name','matchNote','referenceAliases'].includes(key)));
    assert.ok(!('kcal' in item)&&!('per100g' in item));
    const source=await authoritativeFood(db,`fdc:${item.fdcId}`);assert.ok(source,item.name);
    for(const alias of [item.name,...item.aliases]){assert.ok(!aliases.has(alias)||alias===item.name,alias);aliases.add(alias)}
  }
  const result=await resolveAuthoritativeNutrition(db,'白米饭');
  assert.equal(result.nutrition.id,'fdc:168878');assert.equal(result.nutrition.per100g.kcal,130);
  assert.match(result.nutrition.originalName,/Rice/);assert.equal(result.source,'authoritative_database');
});

test('汉堡、牛肉、芝士、鸡腿和炸鸡汉堡自动命中不同 USDA 记录，不要求三选一',async()=>{
  const cases={'汉堡':2706920,'汉堡包':2706920,'牛肉汉堡':170693,'芝士汉堡':2706888,'鸡腿汉堡':2707000,'鸡腿堡':2707000,'鸡肉汉堡':2707000,'炸鸡汉堡':2707008,'麦当劳汉堡':170717};
  for(const [name,id] of Object.entries(cases)){
    const result=await resolveAuthoritativeNutrition(db,name);
    assert.equal(result.nutrition.id,`fdc:${id}`,name);assert.equal(result.needsClarification,false);assert.deepEqual(result.candidates,[]);
    assert.deepEqual(result.nutrition.per100g,(await authoritativeFood(db,`fdc:${id}`)).per100g);
  }
  const leg=await resolveAuthoritativeNutrition(db,'鸡腿汉堡');assert.match(leg.nutrition.matchNote,/未区分鸡腿和鸡胸/);assert.equal(leg.nutrition.confidence,'medium');
});

test('复合中文菜不会被单一食材覆盖；英文全文检索自动选择相关 USDA 参考并标明性质',async()=>{
  const complex=await resolveAuthoritativeNutrition(db,'芝士培根牛肉汉堡');assert.equal(complex.nutrition,null);assert.equal(complex.candidates.length,0);
  const cooked=await resolveAuthoritativeNutrition(db,'烤鸡胸肉');const raw=await resolveAuthoritativeNutrition(db,'生鸡胸肉');
  assert.equal(cooked.nutrition.per100g.kcal,165);assert.equal(raw.nutrition.per100g.kcal,120);
  const english=await resolveAuthoritativeNutrition(db,'chicken breast');assert.ok(english.nutrition);assert.equal(english.needsClarification,false);assert.equal(english.nutrition.matchType,'usda_search_reference');
});

test('模型仅翻译检索词，即使返回虚构热量或FDC编号也不能进入营养结果',async()=>{
  const result=await resolveAuthoritativeNutrition(db,'测试中文食品',{translate:async()=>({queries:['hamburger'],kcal:1,fdcId:999999})});
  assert.ok(result.nutrition);assert.equal(result.nutrition.confidence,'medium');
  for(const candidate of [result.nutrition]){assert.notEqual(candidate.per100g.kcal,1);assert.notEqual(candidate.id,'fdc:999999');assert.match(candidate.source.type,/USDA/)}
  for(const translation of [{queries:['汉堡']},{queries:['DROP TABLE; --']},{queries:['fdc:123']},{queries:[]}]){
    assert.equal((await resolveAuthoritativeNutrition(db,'测试中文食品',{translate:async()=>translation})).nutrition,null);
  }
});

test('常见中文整餐名称离线定位 USDA，不依赖模型额度；不把水果匹配成果奶或豌豆匹配成花生',async()=>{
  const {offlineChineseFoodQuery}=await import('../nutrition-dataset.mjs');
  for(const [query,pattern] of [['牛油果',/Avocado, raw/i],['草莓',/Strawberries, raw/i],['豌豆',/peas.*raw/i],['火腿',/^Ham$/],['烤土豆',/Potato, roasted/i]]){
    let translated=false;
    const result=await resolveAuthoritativeNutrition(db,query,{translate:async()=>{translated=true;throw new Error('quota exhausted')}});
    assert.equal(translated,false,query);assert.ok(result.nutrition,query);assert.match(result.nutrition.originalName,pattern);
    assert.ok(result.trace.includes('offline_chinese_search'));assert.equal(result.nutrition.name,query);
    assert.deepEqual(result.nutrition.per100g,(await authoritativeFood(db,result.nutrition.id)).per100g);
  }
  assert.equal(offlineChineseFoodQuery('烤鸡胸肉沙拉'),'roast chicken breast salad');
  assert.equal(offlineChineseFoodQuery('鱼香肉丝'),null);
  assert.equal(offlineChineseFoodQuery('未知配方牛肉'),null);
  assert.equal(offlineChineseFoodQuery('原味'),null);
  assert.equal(offlineChineseFoodQuery('梨'),'pear raw');
});
