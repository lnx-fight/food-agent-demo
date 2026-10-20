import {atomic} from './database.mjs';
import {nutritionKey} from './nutrition-names.mjs';

const key=nutritionKey;
const groups=[
  {terms:['海鲜','水产','鱼虾','seafood'],pattern:/鱼|虾|蟹|贝|蚝|蛤|蛎|鱿|鲍|蚌|龙虾/},
  {terms:['鱼','鱼类','fish'],pattern:/鱼|鲈|鲑|鲔|鳕|鲷/},
  {terms:['虾','蟹','甲壳类','甲壳动物','shellfish'],pattern:/虾|蟹|龙虾/},
  {terms:['蛋','鸡蛋','蛋类','egg'],pattern:/鸡蛋|鸭蛋|鹅蛋|鹌鹑蛋|蛋白|蛋黄|蛋类/},
  {terms:['奶','牛奶','乳制品','乳糖','milk','dairy'],pattern:/奶|乳品|乳酪|乳清/},
  {terms:['豆','大豆','黄豆','豆制品','soy'],pattern:/豆|腐竹/},
  {terms:['花生','peanut'],pattern:/花生/},
  {terms:['芝麻','sesame'],pattern:/芝麻/},
  {terms:['坚果','nuts'],pattern:/坚果|核桃|杏仁|腰果|榛子|花生|开心果|夏威夷豆/},
  {terms:['小麦','麸质','gluten','wheat'],pattern:/小麦|面粉|面包|面条|面筋|麦麸|酱油/},
  {terms:['牛肉'],pattern:/牛肉|牛腱|牛腩|牛修清|牛后腿/},
  {terms:['猪肉'],pattern:/猪|里脊|里肌/},
  {terms:['鸡肉'],pattern:/鸡胸|鸡腿|鸡肉|清肉/}
];
const clean=value=>key(String(value||''));
function termsFrom(value){
  return clean(value).split(/[、,，;；\s及和]+/).map(term=>term.replace(/没有过敏|无过敏|无忌口|严格忌口|不喜欢|不吃|不要|避免|不能吃|过敏|忌口|对/g,'').trim()).filter(term=>term&&!['无','没有','暂无','否','不限','无特殊要求'].includes(term));
}
export function recipeRequirements(profile={}){
  const preferences=clean(profile.preferences),negative=preferences.split(/[、,，;；。]+/).filter(text=>/不吃|不要|避免|过敏|忌口|不喜欢|不能吃/.test(text));
  const blocked=[...new Set([...termsFrom(profile.allergies),...termsFrom(profile.dislikedFoods),...negative.flatMap(termsFrom)])].sort();
  return {blocked,preferences,taste:clean(profile.tastePreference),vegan:/纯素|全素/.test(preferences),vegetarian:/素食|吃素|蛋奶素|纯素|全素/.test(preferences)};
}
function foodText(food){return clean([food.name,food.category,food.description].filter(Boolean).join(' '))}
export function recipeFoodAllowed(food,requirements){
  const text=foodText(food);
  if(requirements.vegan&&/肉类|鱼贝|蛋类|乳品|鸡肉|猪肉|牛肉|虾|鱼|鸡蛋|奶|蜂蜜/.test(text))return false;
  if(requirements.vegetarian&&/肉类|鱼贝|鸡肉|猪肉|牛肉|虾|鱼|牛修清|清肉/.test(text))return false;
  return !requirements.blocked.some(term=>{
    const group=groups.find(group=>group.terms.includes(term));
    return text.includes(term)||(group&&group.pattern.test(text));
  });
}
export function recipeTools(value='普通厨具'){
  const text=String(value||'普通厨具'),tools=[];
  if(/普通|炒锅|炉灶|燃气|电磁|平底锅/.test(text))tools.push('stove');
  if(/普通|电饭/.test(text))tools.push('rice');
  if(/烤箱|高压锅|压力锅|料理机/.test(text))return false;
  if(/空气炸锅/.test(text))tools.push('airfryer');
  if(/微波炉/.test(text))tools.push('microwave');
  if(/蒸锅|蒸箱|蒸屉/.test(text))tools.push('steamer');
  return tools.sort();
}
export function recipeTime(value='20分钟'){
  const minutes=Number.parseInt(value);return Number.isFinite(minutes)&&minutes>0?Math.min(180,minutes):20;
}
function toolsFit(plan,tools){
  const text=plan.steps.join(' ');
  if(/空气炸锅/.test(text)&&!tools.includes('airfryer'))return false;
  if(/微波炉/.test(text)&&!tools.includes('microwave'))return false;
  if(/蒸锅|蒸屉|蒸箱/.test(text)&&!tools.includes('steamer'))return false;
  if(/电饭煲/.test(text)&&!tools.includes('rice'))return false;
  const stoveText=text.replaceAll('空气炸锅','设备').replaceAll('蒸锅','设备');
  if(/翻炒|炒香|炒熟|煎|焯|炖|平底锅|锅中|沸水/.test(stoveText)&&!tools.includes('stove'))return false;
  return true;
}
export function validateRecipePlan(plan,foods,{requirements,minutes,tools,mainIds}){
  if(!plan||typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>80)throw new Error('食谱缺少有效菜名');
  if(!Array.isArray(plan.steps)||!plan.steps.length||plan.steps.length>8||plan.steps.some(step=>typeof step!=='string'||!step.trim()||step.length>1200))throw new Error('食谱步骤无效');
  if(!Number.isInteger(plan.minutes)||plan.minutes<=0||plan.minutes>minutes)throw new Error('食谱用时超过可用时间');
  if(!toolsFit(plan,tools))throw new Error('食谱需要未提供的厨具');
  if(plan.waterMl!=null&&(!Number.isFinite(plan.waterMl)||plan.waterMl<0||plan.waterMl>3000))throw new Error('食谱水量无效');
  const byName=new Map(foods.map(food=>[food.name,food])),seen=new Set(),used=[];
  if(!Array.isArray(plan.ingredients)||!plan.ingredients.length||plan.ingredients.length>16)throw new Error('食谱配料无效');
  for(const item of plan.ingredients){
    const food=byName.get(item.name);
    if(!food||seen.has(food.id)||!Number.isFinite(item.grams)||item.grams<=0||item.grams>600)throw new Error('食谱有未匹配、重复或克数无效的配料');
    if(!recipeFoodAllowed(food,requirements))throw new Error('食谱与忌口冲突');
    seen.add(food.id);used.push(food);
  }
  if(!used.some(food=>mainIds.includes(food.id)))throw new Error('食谱没有使用现有主料');
  // Exclusions also apply to names and instructions, including hidden garnishes.
  const textFood={name:[plan.name,...plan.steps].join(' ')};
  if(!recipeFoodAllowed(textFood,requirements))throw new Error('步骤中出现忌口食材');
  return used;
}
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export async function recipeContext(input,foods,mainFoods,targets,release){
  const requirements=recipeRequirements(input.profile),minutes=recipeTime(input.cookTime),tools=recipeTools(input.cookTools);
  const mainIds=mainFoods.map(food=>food.id).sort();
  const fingerprint={version:1,release,mainIds,availableIds:foods.map(food=>food.id).sort(),requirements,minutes,tools,mealType:targets.mealType,kcal:Math.round(targets.mealKcal/50)*50,protein:Math.round(targets.mealProtein/10)*10};
  return {requirements,minutes,tools,mainIds,cacheKey:await hash(JSON.stringify(fingerprint))};
}
function storedPlan(row,items,foods,{substituteOil=false}={}){
  const byId=new Map(foods.map(food=>[food.id,food])),ingredients=[],changes=[];
  let steps=JSON.parse(row.steps);
  for(const item of items){
    let food=byId.get('tfda:'+item.food_id);
    // A generic cooking-oil checkbox permits using the selected reference oil;
    // quantities stay fixed and nutrition is recomputed for the actual ID.
    if(!food&&substituteOil&&item.role==='seasoning'&&item.food_id.startsWith('M'))food=foods.find(food=>food.id==='tfda:M9900201');
    if(!food)return null;
    ingredients.push({name:food.name,grams:item.grams});
    if(item.name!==food.name)changes.push([item.name,food.name]);
  }
  for(const [before,after] of changes.sort((a,b)=>b[0].length-a[0].length))steps=steps.map(step=>step.replaceAll(before,after));
  return {name:row.name,ingredients,steps,minutes:row.minutes,waterMl:row.water_ml,portionType:row.portion_type,reason:'根据现有食材选择家常食谱，可结合本餐预算搭配其他食物。',uncertainties:[]};
}
function complete(foods){return foods.every(food=>food.id.startsWith('tfda:')&&['kcal','protein','fat','carbs'].every(metric=>Number.isFinite(food[metric])))}
export async function findReusableRecipe(db,foods,context,{genericOil=false,allowSeeds=true}={}){
  const exact=await db.prepare('SELECT * FROM recipes WHERE cache_key=?').get(context.cacheKey);
  const candidates=exact?[exact]:allowSeeds?await db.prepare("SELECT * FROM recipes WHERE origin='seed' AND minutes<=? ORDER BY id").all(context.minutes):[];
  if(!candidates.length)return null;
  const ids=candidates.map(row=>row.id),items=await db.prepare(`SELECT * FROM recipe_ingredients WHERE recipe_id IN (${ids.map(()=>'?').join(',')}) ORDER BY recipe_id,position`).all(...ids);
  // Generic seed dishes cannot express arbitrary cuisine/taste requirements.
  const seedPreferences=context.requirements.preferences.replace(/偏好|喜欢|中餐|家常菜?|清淡|少油|少盐|不辣|素食|吃素|蛋奶素|纯素|全素|[、,，;；\s]/g,'');
  const requireSpice=/微辣|中辣|重辣|特辣/.test(context.requirements.taste);
  const ranked=[];
  for(const row of candidates){
    if(row.origin==='seed'&&(seedPreferences||requireSpice))continue;
    const own=items.filter(item=>item.recipe_id===row.id);
    if(!own.length)continue;
    const plan=storedPlan(row,own,foods,{substituteOil:genericOil&&row.origin==='seed'});if(!plan)continue;
    try{
      const used=validateRecipePlan(plan,foods,context);if(!complete(used))continue;
      if(/少油/.test(context.requirements.preferences)&&plan.ingredients.some(item=>/油/.test(item.name)&&item.grams>5))continue;
      if(/少盐/.test(context.requirements.preferences)&&plan.ingredients.some(item=>/盐/.test(item.name)&&item.grams>.5))continue;
      ranked.push({plan,id:row.id,kind:row.origin==='seed'?'seed':'hit',score:own.filter(item=>item.role==='main').length});
    }catch{continue}
  }
  return ranked.sort((a,b)=>b.score-a.score)[0]||null;
}
export async function saveGeneratedRecipe(db,plan,foods,context,{release,model}){
  const used=validateRecipePlan(plan,foods,context);
  if(!complete(used))return {status:'not_saved',reason:'incomplete_nutrition'};
  const id='gen-'+crypto.randomUUID(),byName=new Map(foods.map(food=>[food.name,food]));
  const sum=metric=>+plan.ingredients.reduce((n,item)=>n+byName.get(item.name)[metric]*item.grams/100,0).toFixed(2);
  const nutrition=Object.fromEntries(['kcal','protein','fat','carbs'].map(metric=>[metric,sum(metric)]));
  const allergens=groups.filter(group=>used.some(food=>group.pattern.test(foodText(food)))).map(group=>group.terms[0]);
  const statements=[['INSERT INTO recipes(id,name,search_text,servings,portion_type,minutes,water_ml,steps,allergens,nutrition,provenance,seed_version,created_at,origin,cache_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',[id,plan.name,key([plan.name,...plan.ingredients.map(item=>item.name)].join(' ')),1,'dish',plan.minutes,plan.waterMl||0,JSON.stringify(plan.steps),JSON.stringify(allergens),JSON.stringify(nutrition),JSON.stringify({type:'llm',model,nutritionSource:'TFDA',nutritionRelease:release,validationVersion:1,quantitiesOrigin:'llm'}),'generated-v1',new Date().toISOString(),'llm',context.cacheKey]]];
  plan.ingredients.forEach((item,index)=>{
    const food=byName.get(item.name);
    // Concurrent requests have distinct IDs: only the winning recipe's rows
    // are inserted, so two model responses cannot mix their ingredients.
    statements.push(['INSERT INTO recipe_ingredients(recipe_id,position,name,food_id,grams,role,quantity_origin,food_state) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM recipes WHERE id=? AND cache_key=?)',[id,index,food.name,food.id.slice(5),item.grams,context.mainIds.includes(food.id)?'main':'seasoning','editorial','database_sample',id,context.cacheKey]]);
  });
  await atomic(db,statements);
  const winner=await db.prepare('SELECT id FROM recipes WHERE cache_key=?').get(context.cacheKey);
  return {status:'saved',recipeId:winner.id,inserted:winner.id===id};
}
