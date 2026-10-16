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
