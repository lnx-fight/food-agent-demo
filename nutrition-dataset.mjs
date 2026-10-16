export function normalizeAuthoritativeFood(row){
  return {
    id:`fdc:${row.fdc_id}`,name:row.name,category:row.category,basis:'per100g',
    per100g:{kcal:row.kcal,protein:row.protein,fat:row.fat,carbs:row.carbs,fiber:row.fiber,sodiumMg:row.sodium_mg},
    source:{type:`USDA FoodData Central / ${row.data_type}`,url:row.source_url,id:String(row.fdc_id),release:row.release,publicationDate:row.publication_date,license:'CC0-1.0'},
    confidence:'high',matchType:'authoritative_database',energyNutrientId:row.energy_nutrient_id
  };
}

export async function authoritativeFood(db,query){
  const text=String(query||'').trim().slice(0,200),id=text.match(/^fdc:(\d+)$/i);
  const row=id?await db.prepare('SELECT * FROM authoritative_foods WHERE fdc_id=? AND kcal IS NOT NULL').get(Number(id[1])):
    await db.prepare('SELECT * FROM authoritative_foods WHERE name=? COLLATE NOCASE AND kcal IS NOT NULL ORDER BY fdc_id DESC LIMIT 1').get(text);
  return row?normalizeAuthoritativeFood(row):null;
}

export async function searchAuthoritativeFoods(db,query,limit=20){
  const text=String(query||'').trim().slice(0,200),exact=await authoritativeFood(db,text);
  if(exact)return [exact];
  const words=(text.match(/[\p{L}\p{N}]+/gu)||[]).slice(0,12);
  if(!words.length)return [];
  const expression=words.map(word=>`"${word}"*`).join(' AND ');
  const rows=await db.prepare(`SELECT f.* FROM authoritative_foods_fts JOIN authoritative_foods f ON f.fdc_id=authoritative_foods_fts.rowid
    WHERE authoritative_foods_fts MATCH ? AND f.kcal IS NOT NULL ORDER BY rank LIMIT ?`).all(expression,Math.max(1,Math.min(50,Number(limit)||20)));
  return rows.map(normalizeAuthoritativeFood);
}
