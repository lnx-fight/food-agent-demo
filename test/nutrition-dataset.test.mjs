import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {normalizeAuthoritativeFood,authoritativeFood,searchAuthoritativeFoods,authoritativeFoodDetails,resolveAuthoritativeNutrition,NUTRITION_MANIFEST as manifest} from '../nutrition-dataset.mjs';
import {simplifyChinese} from '../nutrition-names.mjs';

const db=new DatabaseSync(':memory:');
for(const file of ['0007_tfda_schema.sql',...manifest.snapshotMigrations,'0009_tfda_activate.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
after(()=>db.close());

test('食药署食品和完整营养明细数量、ZIP及迁移校验和与官方快照一致',()=>{
  const count=db.prepare('SELECT COUNT(*) total,COUNT(kcal) with_energy,SUM(nutrient_count) nutrients FROM nutrition_foods').get();
  assert.equal(count.total,2213);assert.equal(count.total,manifest.totalRows);assert.equal(count.with_energy,manifest.rowsWithEnergy);assert.equal(count.nutrients,230152);
  assert.equal(createHash('sha256').update(readFileSync(new URL('../data/tfda/source.zip',import.meta.url))).digest('hex'),manifest.sha256);
  for(const [file,checksum] of Object.entries(manifest.migrationSha256))assert.equal(createHash('sha256').update(readFileSync(new URL('../migrations/'+file,import.meta.url))).digest('hex'),checksum,file);
  assert.equal(db.prepare('SELECT SUM(json_array_length(payload)) n FROM nutrition_nutrient_data').get().n,manifest.nutrientRows);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='authoritative_foods'").get(),undefined);
});

test('精确编号读取只返回食药署数据，保留原名、授权及能量口径',async()=>{
  const result=await authoritativeFood(db,'tfda:A0550601');
  assert.equal(result.per100g.kcal,182);assert.equal(result.per100g.protein,3.1);assert.equal(result.energyBasis,'修正熱量');
  assert.equal(result.basis,'per100g');assert.equal(result.source.id,'A0550601');assert.equal(result.source.code,'TFDA');assert.equal(result.source.licenseUrl,'https://data.gov.tw/license');assert.match(result.source.attribution,/食品药物管理署/);
  assert.equal(result.originalName,'白飯');assert.equal((await authoritativeFood(db,result.name)).id,result.id);
  assert.equal(result.energyBasisLabel,'修正热量');
  assert.equal(await authoritativeFood(db,'fdc:168878'),null);
});

test('简繁体和地区别名共用原始食品，转换不修改营养值',async()=>{
  for(const [simp,trad,id] of [['冷冻虾仁炒饭','冷凍蝦仁炒飯','R0200201'],['米饭','白飯','A0550601'],['西红柿','番茄','E7400102'],['土豆','馬鈴薯','B0700201'],['鸡胸肉','雞胸肉','I04024'],['牛油果','酪梨','D0900101']]){
    const a=await resolveAuthoritativeNutrition(db,simp),b=await resolveAuthoritativeNutrition(db,trad);
    assert.equal(a.nutrition.id,`tfda:${id}`,simp);assert.equal(b.nutrition.id,a.nutrition.id,trad);assert.deepEqual(a.nutrition.per100g,b.nutrition.per100g);
    assert.equal(a.needsClarification,false);assert.deepEqual(a.candidates,[]);
  }
  for(const row of db.prepare('SELECT name,original_name FROM nutrition_foods').all())assert.equal(row.name,simplifyChinese(row.original_name));
});

test('整菜不得误匹配单个食材、调味酱、冷冻肉饼或汉堡面包',async()=>{
  for(const name of ['回锅肉','麻婆豆腐','牛肉汉堡','芝士汉堡','鸡腿汉堡','炸鸡汉堡','虾仁炒饭','番茄炒鸡蛋','烤鸡胸肉','芝士培根牛肉汉堡']){
    const result=await resolveAuthoritativeNutrition(db,name);assert.equal(result.nutrition,null,name);assert.equal(result.needsClarification,false);assert.deepEqual(result.candidates,[]);
  }
  const bread=await resolveAuthoritativeNutrition(db,'汉堡包');assert.equal(bread.nutrition.id,'tfda:Q1001001');assert.match(bread.nutrition.matchNote,/汉堡面包/);
  const frozen=await resolveAuthoritativeNutrition(db,'冷冻虾仁炒饭');assert.equal(frozen.nutrition.name,'冷冻虾仁炒饭');assert.match(frozen.nutrition.description,/冷冻包装/);
  const removed=await resolveAuthoritativeNutrition(db,'fdc:168878');assert.equal(removed.nutrition,null);assert.match(removed.question,/USDA 数据已移除/);
});

test('全部食品的名称、样品说明和能量显示口径为简体，原始口径保留',()=>{
  for(const row of db.prepare('SELECT * FROM nutrition_foods').all()){
    const food=normalizeAuthoritativeFood(row);
    assert.equal(food.name,simplifyChinese(row.original_name),food.id);
    assert.equal(food.description,simplifyChinese(row.original_description),food.id);
    assert.equal(food.energyBasisLabel,simplifyChinese(row.energy_basis||''),food.id);
    assert.equal(food.energyBasis,row.energy_basis);
    assert.equal(food.per100g.kcal,row.kcal);
  }
});

test('完整营养指标保留原始数值、单位、零和缺失，查询默认摘要不加载明细',async()=>{
  const result=await authoritativeFoodDetails(db,'tfda:R5500201');
  assert.equal(result.records.length,result.food.nutrientCount);assert.equal(result.records.length,104);
  assert.equal(result.records.find(row=>row[1]==='膳食纖維')[3],'');assert.equal(result.food.per100g.fiber,null);
  assert.ok(result.records.some(row=>row[3]!==''&&Number(row[3])===0));
  assert.ok(result.displayNames.includes('膳食纤维'));assert.ok(result.records.some(row=>row[1]==='鈉'&&row[2]==='mg'));
  assert.deepEqual(result.displayNames,result.records.map(row=>simplifyChinese(row[1])));
  const rice=await authoritativeFoodDetails(db,'tfda:A0550601');assert.equal(Number(rice.records.find(row=>row[1]==='熱量')[3]),183);assert.equal(Number(rice.records.find(row=>row[1]==='修正熱量')[3]),182);
  assert.equal('records' in (await authoritativeFood(db,'肉粽')),false);
});

test('名称检索支持明确英文原名，查询符号不能注入SQL或当作通配符',async()=>{
  assert.equal((await authoritativeFood(db,'Cooked rice')).id,'tfda:A0550601');
  const results=await searchAuthoritativeFoods(db,'冷凍',5);assert.equal(results.length,5);for(const item of results)assert.ok(item.name.includes('冷冻'));
  for(const value of ['"*','%','_','\'; DROP TABLE nutrition_foods; --'])assert.deepEqual(await searchAuthoritativeFoods(db,value),[]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nutrition_foods').get().n,manifest.totalRows);
});

test('中文命中和未收录名称都不调用模型转换或外部服务',async()=>{
  let called=false;
  const options={translate:async()=>{called=true;throw new Error('No remote translation')}};
  assert.ok((await resolveAuthoritativeNutrition(db,'肉粽',options)).nutrition);
  const missing=await resolveAuthoritativeNutrition(db,'完全未收录的测试餐食',options);assert.equal(missing.nutrition,null);assert.match(missing.question,/当前快照未找到/);assert.equal(called,false);
});

test('部分导入未达到校验数量时拒绝激活，保留旧食品库',()=>{
  const partial=new DatabaseSync(':memory:');
  try{
    partial.exec("CREATE TABLE authoritative_foods(fdc_id INTEGER PRIMARY KEY,name TEXT);INSERT INTO authoritative_foods VALUES(1,'old food');");
    partial.exec(readFileSync(new URL('../migrations/0007_tfda_schema.sql',import.meta.url),'utf8'));
    partial.exec('BEGIN');
    assert.throws(()=>partial.exec(readFileSync(new URL('../migrations/0009_tfda_activate.sql',import.meta.url),'utf8')),/CHECK constraint/);
    partial.exec('ROLLBACK');
    assert.equal(partial.prepare('SELECT COUNT(*) n FROM authoritative_foods').get().n,1);
    assert.equal(partial.prepare('SELECT COUNT(*) n FROM nutrition_dataset').get().n,0);
  }finally{partial.close()}
});
