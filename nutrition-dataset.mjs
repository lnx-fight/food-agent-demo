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

export async function searchAuthoritativeFoods(db,query,limit=20,{skipExact=false}={}){
  const text=String(query||'').trim().slice(0,200),exact=skipExact?null:await authoritativeFood(db,text);
  if(exact)return [exact];
  const words=(text.match(/[\p{L}\p{N}]+/gu)||[]).slice(0,12);
  if(!words.length)return [];
  const expression=words.map(word=>`"${word.replace(/y$/i,'')}"*`).join(' AND ');
  const rows=await db.prepare(`SELECT f.* FROM authoritative_foods_fts JOIN authoritative_foods f ON f.fdc_id=authoritative_foods_fts.rowid
    WHERE authoritative_foods_fts MATCH ? AND f.kcal IS NOT NULL ORDER BY rank LIMIT ?`).all(expression,Math.max(1,Math.min(50,Number(limit)||20)));
  return rows.map(normalizeAuthoritativeFood);
}

// Labels and FDC IDs only. All nutrition values are read from the USDA table.
import catalog from './data/usda/chinese-foods.json' with {type:'json'};
import vocabulary from './data/usda/chinese-search-terms.json' with {type:'json'};
const searchTerms=vocabulary.terms;
const key=value=>String(value||'').normalize('NFKC').trim().toLowerCase();
export const USDA_TERMS=catalog.foods.flatMap(food=>[food.name,...food.aliases,...(food.referenceAliases||[])].map(term=>({id:`fdc:${food.fdcId}`,name:food.name,term})));
const labels=new Map(catalog.foods.map(food=>[food.fdcId,food]));
const aliases=new Map(catalog.foods.flatMap(food=>[food.name,...food.aliases,...(food.referenceAliases||[])].map(term=>[key(term),food])));
export function localizeAuthoritativeFood(food){
  const label=labels.get(Number(food.source.id));
  return label?{...food,originalName:food.name,name:label.name,category:label.category,...(label.matchNote?{matchNote:label.matchNote}:{})}: {...food,originalName:food.name};
}

// Rank entire-food matches; generic survey entries outrank an unspecified brand.
// FTS requires every search token, so a compound dish cannot degrade to one ingredient.
function foodWord(word){
  if(/^(?:roast|roasted|roasting)$/.test(word))return 'roast';
  if(/^(?:cook|cooked|cooking)$/.test(word))return 'cook';
  if(/^(?:fry|fried|frying)$/.test(word))return 'fry';
  if(word.endsWith('ies'))return word.slice(0,-3)+'y';
  if(word.endsWith('oes'))return word.slice(0,-2);
  return word.endsWith('s')&&!word.endsWith('ss')?word.slice(0,-1):word;
}
function relevance(food,query){
  const name=key(food.originalName||food.name),q=key(query),words=(q.match(/[a-z0-9]+/g)||[]).map(foodWord),tokens=(name.match(/[a-z0-9]+/g)||[]).map(foodWord);
  // Do not confuse prefix matches such as pea/peanut, egg/eggplant or ham/hamburger.
  if(!words.every(word=>tokens.includes(word)))return -Infinity;
  const branded=/mcdonald|burger king|wendy|chick-fil|kfc|taco bell|subway/.test(name),brandRequested=/mcdonald|burger king|wendy|chick-fil|kfc|taco bell|subway/.test(q);
  const extraPreparation=['juice','sauce','soup','salad','sandwich','bread','butter','milk','yogurt','dried','fry','roast','cook'].filter(word=>tokens.includes(word)&&!words.includes(word)).length;
  return 100+(name===q?100:0)+(name.startsWith(q)?12:0)+(/\bnfs\b/.test(name)?4:0)+(tokens.includes('raw')&&!words.some(word=>['cook','roast','fry','boiled','baked','steamed'].includes(word))?15:0)-extraPreparation*25-(branded&&!brandRequested?25:0)-name.length/1000;
}
const orderedSearchTerms=Object.keys(searchTerms).sort((a,b)=>b.length-a.length),foodModifiers=new Set(vocabulary.modifiers);
export function offlineChineseFoodQuery(value){
  const text=key(value).replace(/^\d+(?:\.\d+)?\s*(?:克|g)\s*/,'');
  const translated=[];let offset=0,recognizedFood=false;
  while(offset<text.length){
    if(/[\s,，、()（）]/u.test(text[offset])){offset++;continue}
    const english=text.slice(offset).match(/^[a-z]+(?:[-'][a-z]+)*/);
    if(english){translated.push(english[0]);recognizedFood=true;offset+=english[0].length;continue}
    const token=orderedSearchTerms.find(term=>text.startsWith(term,offset));
    // Reject the whole expression when any part is unknown; no ingredient-only fallback.
    if(!token)return null;
    const replacement=searchTerms[token];if(replacement){translated.push(replacement);if(!foodModifiers.has(token))recognizedFood=true}
    offset+=token.length;
  }
  if(!recognizedFood||!translated.length)return null;
  if(vocabulary.defaultRaw.includes(text))translated.push('raw');
  return [...new Set(translated.join(' ').split(/\s+/))].join(' ');
}

export async function resolveAuthoritativeNutrition(db,query,{limit=50}={}){
  const text=String(query||'').trim().slice(0,200),trace=['usda_downloaded_dataset'];
  const answer=(nutrition,question='',extra={})=>({nutrition,candidates:[],needsClarification:false,question,source:nutrition?'authoritative_database':'unmatched',trace,...extra});
  if(!text)return answer(null);
  const alias=aliases.get(key(text));
  if(alias){
    trace.push('chinese_alias');
    const raw=await authoritativeFood(db,`fdc:${alias.fdcId}`);
    if(!raw)return answer(null,'对应 USDA 记录暂无可计算热量。');
    const food=localizeAuthoritativeFood(raw),reference=(alias.referenceAliases||[]).some(term=>key(term)===key(text));
    return answer({...food,...(reference?{name:text,referenceName:food.name,confidence:'medium'}:{}),matchType:reference?'usda_generic_reference':'usda_chinese_alias'});
  }
  if(!/[\p{Script=Han}]/u.test(text)){
    const exact=await authoritativeFood(db,text);if(exact)return answer(localizeAuthoritativeFood(exact));
  }
  let queries=[text];
  if(/[\p{Script=Han}]/u.test(text)){
    const offline=offlineChineseFoodQuery(text);
    if(offline){queries=[offline];trace.push('offline_chinese_search')}
    else return answer(null,'中文检索词库暂未覆盖这个名称，请补充更具体的餐食名、英文原名或 FDC 编号。');
  }

  const ranked=[];
  for(const q of queries){
    for(const raw of await searchAuthoritativeFoods(db,q,limit,{skipExact:true})){
      const food=localizeAuthoritativeFood(raw),score=relevance(food,q);if(!Number.isFinite(score))continue;
      const existing=ranked.find(item=>item.food.id===food.id);
      if(existing)existing.score=Math.max(existing.score,score);else ranked.push({food,score});
    }
  }
  ranked.sort((a,b)=>b.score-a.score||a.food.id.localeCompare(b.food.id));
  if(!ranked.length)return answer(null,'USDA 当前快照中没有合适记录，请补充更具体的名称或手动填写包装营养信息。',{searchQueries:queries});
  trace.push('usda_relevance_match');
  return answer({...ranked[0].food,...(/[\p{Script=Han}]/u.test(text)?{name:text}:{}),confidence:'medium',matchType:'usda_search_reference',matchNote:'自动匹配的 USDA 参考食品；具体生熟状态、品牌和配方以原文为准。'},'',{searchQueries:queries});
}
