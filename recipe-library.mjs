import {nutritionKey} from './nutrition-names.mjs';

function summary(row){
  return {id:row.id,name:row.name,servings:row.servings,portionType:row.portion_type,minutes:row.minutes,nutrition:JSON.parse(row.nutrition),nutritionBasis:'perRecipe',allergens:JSON.parse(row.allergens)};
}
// Catalog access only reads persisted recipes; generation writes are separate.
export async function browseRecipes(db,{q=''}={}){
  const query=nutritionKey(String(q).slice(0,100));
  const rows=await db.prepare('SELECT * FROM recipes WHERE instr(search_text,?)>0 ORDER BY id LIMIT 50').all(query);
  const count=await db.prepare('SELECT COUNT(*) total FROM recipes WHERE instr(search_text,?)>0').get(query);
  return {recipes:rows.map(summary),total:count.total,query};
}
export async function recipeDetails(db,id){
  if(!/^(?:home-\d{3}|gen-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(String(id||'')))return null;
  const row=await db.prepare('SELECT * FROM recipes WHERE id=?').get(id);if(!row)return null;
  const items=await db.prepare('SELECT name,food_id,grams,role,food_state FROM recipe_ingredients WHERE recipe_id=? ORDER BY position').all(id);
  return {...summary(row),waterMl:row.water_ml,steps:JSON.parse(row.steps),ingredients:items.map(item=>({name:item.name,foodId:`tfda:${item.food_id}`,grams:item.grams,role:item.role,state:item.food_state}))};
}
