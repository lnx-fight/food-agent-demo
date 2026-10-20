import {nutritionKey} from './nutrition-names.mjs';
import {normalizeAuthoritativeFood,authoritativeFoodDetails,NUTRITION_MANIFEST} from './nutrition-dataset.mjs';
import aliases from './data/tfda/aliases.json' with {type:'json'};

const commonIds=[...aliases.foods.map(food=>food.foodId),'R0400101','R0200201'];
const friendly=new Map(aliases.foods.map(food=>[food.foodId,food.aliases[0]]));
// Official source groups, presented as familiar browse categories. Corrupted
// pre-generated category strings fall back to the original integration-ID group.
export const FOOD_CATEGORIES=Object.freeze([
  {id:'staple',name:'主食',icon:'🍚',sources:['谷物类','淀粉类'],prefixes:['A','B']},
  {id:'vegetable',name:'蔬菜菌藻',icon:'🥬',sources:['蔬菜类','菇类','藻类'],prefixes:['E','G','F']},
  {id:'fruit',name:'水果',icon:'🍎',sources:['水果类'],prefixes:['D']},
  {id:'protein',name:'肉蛋奶',icon:'🥚',sources:['肉类','蛋类','乳品类'],prefixes:['I','K','L']},
  {id:'seafood',name:'鱼虾水产',icon:'🐟',sources:['鱼贝类'],prefixes:['J']},
  {id:'bean',name:'豆类坚果',icon:'🫘',sources:['豆类','坚果及种子类'],prefixes:['H','C']},
  {id:'prepared',name:'加工食品',icon:'🍱',sources:['加工调理食品及其他类'],prefixes:['R']},
  {id:'snack',name:'糕点零食',icon:'🍞',sources:['糕饼点心类','糖类'],prefixes:['Q','N']},
  {id:'drink',name:'饮品',icon:'🥛',sources:['饮料类'],prefixes:['O']},
  {id:'seasoning',name:'油脂调味',icon:'🧂',sources:['油脂类','调味料及香辛料类'],prefixes:['M','P']}
]);
const placeholders=values=>values.map(()=>'?').join(',');
function categoryFor(row){return FOOD_CATEGORIES.find(group=>group.sources.includes(row.category))||FOOD_CATEGORIES.find(group=>group.prefixes.includes(row.food_id[0]))}
export function catalogFood(row){
  const food=normalizeAuthoritativeFood(row),group=categoryFor(row);
  // Public results intentionally include food metadata only, never device state.
  return {id:food.id,name:food.name,displayName:friendly.get(row.food_id)||food.name,category:group.id,categoryLabel:group.name,icon:group.icon,description:food.description,per100g:food.per100g,energyBasisLabel:food.energyBasisLabel,nutrientCount:food.nutrientCount,matchNote:food.matchNote||'',source:food.source};
}
export async function catalogCategories(db){
  const rows=await db.prepare('SELECT category,substr(food_id,1,1) prefix,COUNT(*) count FROM nutrition_foods WHERE kcal IS NOT NULL GROUP BY category,prefix').all();
  const groups=FOOD_CATEGORIES.map(group=>({...group,count:0}));
  let total=0;
  for(const row of rows){const group=groups.find(group=>group.sources.includes(row.category))||groups.find(group=>group.prefixes.includes(row.prefix));if(group)group.count+=row.count;total+=row.count}
  return {total,categories:[{id:'common',name:'常见',icon:'☆',count:commonIds.length},{id:'all',name:'全部食品',icon:'≡',count:total},...groups.map(({id,name,icon,count})=>({id,name,icon,count}))],source:{name:'台湾食药署食品营养成分资料集',url:NUTRITION_MANIFEST.datasetUrl,attribution:NUTRITION_MANIFEST.attribution,licenseUrl:NUTRITION_MANIFEST.licenseUrl}};
}
export async function browseFoods(db,{q='',category='common',page=1,limit=24}={}){
  const text=nutritionKey(String(q).slice(0,100));
  const group=FOOD_CATEGORIES.find(group=>group.id===category);
  if(!['common','all'].includes(category)&&!group)throw Object.assign(new Error('食品分类不存在'),{status:400});
  limit=Math.max(1,Math.min(48,Math.trunc(Number(limit))||24));page=Math.max(1,Math.min(10000,Math.trunc(Number(page))||1));
  const clauses=['f.kcal IS NOT NULL'],params=[];
  if(text&&!/[\p{L}\p{N}]/u.test(text))clauses.push('0');
  if(category==='common'){clauses.push(`f.food_id IN (${placeholders(commonIds)})`);params.push(...commonIds)}
  if(group){clauses.push(`(f.category IN (${placeholders(group.sources)}) OR (instr(f.category,'�')>0 AND substr(f.food_id,1,1) IN (${placeholders(group.prefixes)})))`);params.push(...group.sources,...group.prefixes)}
  const id=text.match(/^tfda:([a-r]\d{4,8})$/i);
  if(id){clauses.push('f.food_id=?');params.push(id[1].toUpperCase())}
  else if(text){clauses.push('f.food_id IN (SELECT n.food_id FROM nutrition_names n WHERE instr(n.term,?)>0)');params.push(text)}
  const where=clauses.join(' AND '),count=await db.prepare(`SELECT COUNT(*) total FROM nutrition_foods f WHERE ${where}`).get(...params);
  const pages=Math.max(1,Math.ceil(count.total/limit));page=Math.min(page,pages);
  const order=category==='common'?`CASE f.food_id ${commonIds.map((id,index)=>`WHEN '${id}' THEN ${index}`).join(' ')} ELSE 100 END`:'length(f.name),f.name,f.food_id';
  // Exact aliases come first, then complete-query substring matches. This is a
  // browse list; selecting a row is explicit and never substitutes an ingredient.
  const rows=await db.prepare(`SELECT f.* FROM nutrition_foods f WHERE ${where} ORDER BY CASE WHEN EXISTS(SELECT 1 FROM nutrition_names n WHERE n.food_id=f.food_id AND n.term=?) THEN 0 ELSE 1 END,${order} LIMIT ? OFFSET ?`).all(...params,text,limit,(page-1)*limit);
  return {foods:rows.map(catalogFood),total:count.total,page,pages,limit,category,query:text,basis:'per100g'};
}
export async function catalogDetails(db,id){
  if(!/^tfda:[a-r]\d{4,8}$/i.test(String(id||'')))return null;
  const result=await authoritativeFoodDetails(db,id);if(!result)return null;
  const row=await db.prepare('SELECT * FROM nutrition_foods WHERE food_id=?').get(result.food.source.id);
  return {food:catalogFood(row),nutrients:result.records.map((record,i)=>({name:result.displayNames[i],unit:record[2],value:record[3]===''?null:record[3]}))};
}
export function isPublicFoodRoute(req,url){return req.method==='GET'&&['/api/food-catalog','/api/food-catalog/categories','/api/food-catalog/details'].includes(url.pathname)}
