import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import manifest from '../data/tfda/manifest.json' with {type:'json'};
import seed from '../data/recipes/home-recipes.json' with {type:'json'};
import {browseRecipes,recipeDetails} from '../recipe-library.mjs';

const db=new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for(const file of ['0007_tfda_schema.sql',...manifest.snapshotMigrations,'0009_tfda_activate.sql','0010_recipe_schema.sql','0011_home_recipes.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));

test('20道预置菜谱：主料来自指南、用量与食材状态保留，调料与步骤单独追溯',()=>{
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes').get().n,20);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nutrition_foods').get().n,2213);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  for(const recipe of seed.recipes){
    const stored=db.prepare('SELECT * FROM recipes WHERE id=?').get(recipe.id),provenance=JSON.parse(stored.provenance);
    assert.equal(provenance.excerpt,recipe.provenance.excerpt);
    assert.equal(provenance.sourceSha256,seed.sourceSha256);
    assert.equal(provenance.stepsOrigin,'editorial');
    assert.equal(stored.portion_type,'dish');
    assert.equal(stored.servings,1);
    const ingredients=db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id=? ORDER BY position').all(recipe.id);
    for(const [i,item] of ingredients.entries()){
      assert.equal(item.food_id,recipe.ingredients[i].foodId);
      assert.equal(item.grams,recipe.ingredients[i].grams);
      assert.equal(item.quantity_origin,item.role==='main'?'source':'editorial');
    }
  }
});
test('营养全部由TFDA按实际克数计算；盐、油、干湿形态不遗漏，不将未知营养补零',()=>{
  for(const row of db.prepare('SELECT * FROM recipes').all()){
    const ingredients=db.prepare('SELECT i.grams,f.* FROM recipe_ingredients i JOIN nutrition_foods f ON f.food_id=i.food_id WHERE i.recipe_id=?').all(row.id),nutrition=JSON.parse(row.nutrition);
    for(const [key,column] of Object.entries({kcal:'kcal',protein:'protein',fat:'fat',carbs:'carbs',fiber:'fiber',sodiumMg:'sodium_mg',sugar:'sugar',saturatedFat:'saturated_fat'})){
      const expected=ingredients.some(item=>item[column]==null)?null:+ingredients.reduce((sum,item)=>sum+item[column]*item.grams/100,0).toFixed(2);
      assert.equal(nutrition[key],expected,`${row.name}: ${key}`);
    }
  }
  const tomato=JSON.parse(db.prepare("SELECT nutrition FROM recipes WHERE id='home-001'").get().nutrition);
  assert.equal(tomato.kcal,120.87); // 50g eggs + 100g tomato + 4g oil + 0.5g salt.
  assert.equal(db.prepare("SELECT food_id FROM recipe_ingredients WHERE recipe_id='home-018' AND role='main'").get().food_id,'J2200101');
  assert.throws(()=>db.prepare("UPDATE recipe_ingredients SET food_id='missing' WHERE recipe_id='home-001' AND position=0").run(),/FOREIGN KEY/);
});
test('直接读取已保存菜谱，不调用LLM；简繁体和常用别名查询，配方详情有克数和步骤',async()=>{
  assert.equal((await browseRecipes(db)).total,20);
  assert.equal((await browseRecipes(db,{q:'番茄炒鸡蛋'})).recipes[0].id,'home-001');
  assert.equal((await browseRecipes(db,{q:'蒜蓉西蘭花'})).recipes[0].id,'home-002');
  assert.equal((await browseRecipes(db,{q:"' OR 1=1 --"})).total,0);
  assert.equal((await recipeDetails(db,'home-001')).ingredients.length,4);
  assert.equal((await recipeDetails(db,'home-001')).nutritionBasis,'perRecipe');
  assert.equal(await recipeDetails(db,'home-999'),null);
  assert.equal(await recipeDetails(db,"home-001' OR 1=1"),null);
  const response=JSON.stringify(await recipeDetails(db,'home-001'));
  assert.doesNotMatch(response,/参考官方指南整理|按配方估算/);
});
