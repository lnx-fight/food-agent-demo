import manifest from './data/tfda/manifest.json' with {type:'json'};
import catalog from './data/tfda/search-index.json' with {type:'json'};
import curated from './data/tfda/aliases.json' with {type:'json'};
import {nutritionKey,simplifyChinese} from './nutrition-names.mjs';

const notes=new Map(curated.foods.filter(item=>item.note).map(item=>[item.foodId,item.note]));
const terms=new Map();
for(const item of [...catalog].sort((a,b)=>Number(b.curated)-Number(a.curated)))if(!terms.has(item.term))terms.set(item.term,{id:`tfda:${item.foodId}`,name:item.name,term:item.term});
export const TFDA_TERMS=[...terms.values()];
export const NUTRITION_MANIFEST=manifest;

export function normalizeAuthoritativeFood(row){
  const note=notes.get(row.food_id),bread=row.food_id==='Q1001001';
  return {
    id:`tfda:${row.food_id}`,name:simplifyChinese(row.original_name),originalName:row.original_name,englishName:row.english_name,
    category:row.category,description:simplifyChinese(row.original_description),originalDescription:row.original_description,originalAliases:row.original_aliases,
    basis:'per100g',edibleWastePercent:row.edible_waste_percent,
    per100g:{kcal:row.kcal,protein:row.protein,fat:row.fat,carbs:row.carbs,fiber:row.fiber,sodiumMg:row.sodium_mg,sugar:row.sugar,saturatedFat:row.saturated_fat},
    energyBasis:row.energy_basis,energyBasisLabel:simplifyChinese(row.energy_basis||''),nutrientCount:row.nutrient_count,
    source:{code:'TFDA',type:'台湾食药署食品营养成分资料集',publisher:manifest.publisher,url:manifest.datasetUrl,downloadUrl:manifest.downloadUrl,id:row.food_id,release:manifest.release,retrievedOn:manifest.retrievedOn,license:manifest.license,licenseUrl:manifest.licenseUrl,attribution:manifest.attribution},
    confidence:'high',matchType:'authoritative_database',
    ...((note||bread)?{matchNote:bread?'此记录为汉堡面包，不含肉饼和夹馅，不能代表完整汉堡。':note}:{})
  };
}

export async function authoritativeFood(db,query){
  const text=String(query||'').trim().slice(0,200),id=text.match(/^tfda:([a-r]\d{4,8})$/i);
  const row=id?await db.prepare('SELECT * FROM nutrition_foods WHERE food_id=? AND kcal IS NOT NULL').get(id[1].toUpperCase()):
    await db.prepare(`SELECT f.* FROM nutrition_names n JOIN nutrition_foods f ON f.food_id=n.food_id
      WHERE n.term=? AND f.kcal IS NOT NULL
      ORDER BY CASE n.kind WHEN 'curated' THEN 0 WHEN 'name' THEN 1 WHEN 'alias' THEN 2 ELSE 3 END,length(f.name),f.food_id LIMIT 1`).get(nutritionKey(text));
  return row?normalizeAuthoritativeFood(row):null;
}

export async function searchAuthoritativeFoods(db,query,limit=20,{skipExact=false}={}){
  const text=nutritionKey(String(query||'').slice(0,200)),exact=skipExact?null:await authoritativeFood(db,text);
  if(exact)return [exact];
  if(!text||!/[\p{L}\p{N}]/u.test(text)||/^fdc:/i.test(text))return [];
  // Match the complete query inside a food name, never split a compound dish
  // into its ingredients. All SQL values are bound parameters.
  const rows=await db.prepare(`SELECT DISTINCT f.* FROM nutrition_names n JOIN nutrition_foods f ON f.food_id=n.food_id
    WHERE instr(n.term,?)>0 AND f.kcal IS NOT NULL ORDER BY length(f.name),f.food_id LIMIT ?`).all(text,Math.max(1,Math.min(50,Number(limit)||20)));
  return rows.map(normalizeAuthoritativeFood);
}

export async function authoritativeFoodDetails(db,id){
  const food=await authoritativeFood(db,id);if(!food)return null;
  const row=await db.prepare('SELECT payload FROM nutrition_nutrient_data WHERE food_id=?').get(food.source.id);
  const records=row?JSON.parse(row.payload):[];
  return {food,columns:manifest.detailColumns,records,displayNames:records.map(row=>simplifyChinese(row[1]))};
}

export async function resolveAuthoritativeNutrition(db,query,{limit=50}={}){
  const text=String(query||'').trim().slice(0,200),q=nutritionKey(text),trace=['tfda_downloaded_dataset'];
  const answer=(nutrition,question='')=>({nutrition,candidates:[],needsClarification:false,question,source:nutrition?'authoritative_database':'unmatched',trace});
  if(!text)return answer(null);
  if(/^fdc:/i.test(text))return answer(null,'USDA 数据已移除，请使用食品名称或 tfda:整合编号查询。');
  const exact=await authoritativeFood(db,text);
  if(exact){
    const direct=q===nutritionKey(exact.name)||/^tfda:/i.test(text),english=q===nutritionKey(exact.englishName);
    trace.push(direct?'tfda_exact_match':english?'tfda_english_name':'tfda_chinese_alias');
    return answer({...exact,matchType:direct?'tfda_exact_match':'tfda_name_alias',...(!direct?{confidence:'medium',matchNote:[exact.matchNote,'名称别名匹配；请核对原始样品、生熟状态与配方。'].filter(Boolean).join(' ')}:{})});
  }
  // Only auto-select a sample qualifier (e.g. sampling year) of the complete
  // food name. Extra words such as 冷冻/酱/肉饼 must not change the user's dish.
  const rows=await searchAuthoritativeFoods(db,text,limit,{skipExact:true});
  const safe=rows.filter(food=>{
    const name=nutritionKey(food.name);
    return name.replace(/\([^)]*\)/g,'').trim()===q&&q.length>=2;
  });
  if(safe.length){
    const food=safe[0];trace.push('tfda_sample_reference');
    return answer({...food,confidence:'medium',matchType:'tfda_sample_reference',matchNote:[food.matchNote,'按完整名称匹配的食药署样品参考，请核对品种、样品状态及配方。'].filter(Boolean).join(' ')});
  }
  return answer(null,'台湾食药署当前快照未找到对应的完整食品记录，请补充数据库中的具体名称、tfda:整合编号，或按包装营养标签手动填写。');
}
