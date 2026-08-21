import http from 'node:http';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync
} from 'node:fs';

import {
  extname,
  join,
  normalize,
  resolve,
  relative,
  sep
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT=fileURLToPath(new URL('.',import.meta.url));
const CN_TZ='Asia/Shanghai'; // 北京时间（中国标准时间 UTC+8；IANA 时区库中全中国统一使用 Asia/Shanghai）
loadDotEnv(join(ROOT,'.env'));
const PORT=Number(process.env.PORT||8080);
// 食物种子数据始终来自源码；云端部署可通过 DATA_DIR 仅重定向 SQLite，避免用户数据随重启丢失。
const SOURCE_DATA_DIR=join(ROOT,'data');
const DATA_DIR=resolve(process.env.DATA_DIR||SOURCE_DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
const db=new DatabaseSync(join(DATA_DIR,'nutrition.sqlite'));
initDatabase();

function loadDotEnv(path){
  if(!existsSync(path))return;
  for(const line of readFileSync(path,'utf8').split(/\r?\n/)){
    const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#'))continue;
    const i=trimmed.indexOf('=');if(i<1)continue;
    const key=trimmed.slice(0,i).trim(),value=trimmed.slice(i+1).trim().replace(/^['"]|['"]$/g,'');
    if(!(key in process.env))process.env[key]=value;
  }
}
function initDatabase(){
  db.exec(`CREATE TABLE IF NOT EXISTS foods(id INTEGER PRIMARY KEY,name TEXT UNIQUE,category TEXT,kcal REAL,protein REAL,fat REAL,carbs REAL,source TEXT,source_url TEXT,source_id TEXT,confidence TEXT,status TEXT DEFAULT 'verified',updated_at TEXT);CREATE TABLE IF NOT EXISTS aliases(id INTEGER PRIMARY KEY,food_id INTEGER,alias TEXT UNIQUE,FOREIGN KEY(food_id) REFERENCES foods(id));CREATE TABLE IF NOT EXISTS candidates(id INTEGER PRIMARY KEY,name TEXT,payload TEXT,source_url TEXT,status TEXT DEFAULT 'pending_review',created_at TEXT);CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,client_id TEXT UNIQUE,profile TEXT,chat_history TEXT,pending_meal TEXT,budget_adjustment_kcal INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT);CREATE TABLE IF NOT EXISTS meal_logs(id INTEGER PRIMARY KEY,user_id INTEGER,date TEXT,type TEXT,name TEXT,calories REAL,protein REAL,source TEXT,recorded_at TEXT);CREATE TABLE IF NOT EXISTS weight_logs(id INTEGER PRIMARY KEY,user_id INTEGER,date TEXT,weight REAL,source TEXT,recorded_at TEXT,UNIQUE(user_id,date));CREATE TABLE IF NOT EXISTS agent_memory(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,date TEXT,payload TEXT,created_at TEXT);CREATE TABLE IF NOT EXISTS agent_tasks(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,due_date TEXT,status TEXT DEFAULT 'pending',payload TEXT,created_at TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,start_value REAL,current_value REAL,target_value REAL,deadline TEXT,status TEXT DEFAULT 'active',created_at TEXT,updated_at TEXT);CREATE TABLE IF NOT EXISTS memory_embeddings(id INTEGER PRIMARY KEY,memory_id INTEGER,embedding TEXT);CREATE TABLE IF NOT EXISTS agent_logs(id INTEGER PRIMARY KEY,client_id TEXT,kind TEXT,detail TEXT,created_at TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_goals(id INTEGER PRIMARY KEY,user_id INTEGER,client_id TEXT,objective TEXT,success_criteria TEXT,state TEXT DEFAULT 'running',current_step INTEGER DEFAULT 0,max_steps INTEGER DEFAULT 6,last_observation TEXT DEFAULT '',created_at TEXT,updated_at TEXT,completed_at TEXT);CREATE TABLE IF NOT EXISTS agent_goal_steps(id INTEGER PRIMARY KEY,goal_id INTEGER,step_no INTEGER,tool TEXT,args TEXT,result TEXT,state TEXT DEFAULT 'planned',expected_observation TEXT,created_at TEXT,finished_at TEXT,UNIQUE(goal_id,step_no),FOREIGN KEY(goal_id) REFERENCES agent_goals(id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS skills(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,description TEXT,schema TEXT,preconditions TEXT,fallback TEXT,steps TEXT,version INTEGER DEFAULT 1,scope TEXT DEFAULT 'user',source TEXT DEFAULT 'agent',active INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT,UNIQUE(user_id,name));CREATE TABLE IF NOT EXISTS skill_embeddings(id INTEGER PRIMARY KEY,skill_id INTEGER,embedding TEXT);`);
  const taskCols=db.prepare('PRAGMA table_info(agent_tasks)').all().map(c=>c.name);
  if(!taskCols.includes('priority'))db.exec('ALTER TABLE agent_tasks ADD COLUMN priority INTEGER DEFAULT 0');
  if(!taskCols.includes('state'))db.exec("ALTER TABLE agent_tasks ADD COLUMN state TEXT DEFAULT 'pending'");
  if(!taskCols.includes('due_at'))db.exec('ALTER TABLE agent_tasks ADD COLUMN due_at TEXT');
  if(!taskCols.includes('goal_id'))db.exec('ALTER TABLE agent_tasks ADD COLUMN goal_id INTEGER');
  if(!taskCols.includes('dependencies'))db.exec('ALTER TABLE agent_tasks ADD COLUMN dependencies TEXT');
  const foodCols=db.prepare('PRAGMA table_info(foods)').all().map(c=>c.name);
  const aliasFk=db.prepare('PRAGMA foreign_key_list(aliases)').all();
  const aliasBroken=!aliasFk.length||aliasFk[0].table!=='foods';
  if(foodCols.includes('kcal_min')||aliasBroken){
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('DROP TABLE aliases');
    if(foodCols.includes('kcal_min')){
      db.exec('ALTER TABLE foods RENAME TO foods_legacy');
      db.exec('CREATE TABLE foods(id INTEGER PRIMARY KEY,name TEXT UNIQUE,category TEXT,kcal REAL,protein REAL,fat REAL,carbs REAL,source TEXT,source_url TEXT,source_id TEXT,confidence TEXT,status TEXT DEFAULT \'verified\',updated_at TEXT)');
      db.exec('INSERT INTO foods(id,name,category,kcal,protein,fat,carbs,source,source_url,source_id,confidence,status,updated_at) SELECT id,name,category,kcal,protein,fat,carbs,source,source_url,source_id,confidence,status,updated_at FROM foods_legacy');
      db.exec('DROP TABLE foods_legacy');
    }
    db.exec('CREATE TABLE aliases(id INTEGER PRIMARY KEY,food_id INTEGER,alias TEXT UNIQUE,FOREIGN KEY(food_id) REFERENCES foods(id))');
    db.exec('PRAGMA foreign_keys=ON');
  }
  const foods=JSON.parse(readFileSync(join(SOURCE_DATA_DIR,'foods.json'),'utf8'));
  const insert=db.prepare(`INSERT INTO foods(name,category,kcal,protein,fat,carbs,source,confidence,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET category=excluded.category,kcal=excluded.kcal,protein=excluded.protein,fat=excluded.fat,carbs=excluded.carbs,source=excluded.source,confidence=excluded.confidence,updated_at=excluded.updated_at`);
  const alias=db.prepare('INSERT OR IGNORE INTO aliases(food_id,alias) VALUES(?,?)');
  const findId=db.prepare('SELECT id FROM foods WHERE name=?');
  db.exec('BEGIN');
  try{for(const f of foods){insert.run(f.name,f.category,f.kcal,f.protein,f.fat,f.carbs,f.source,f.confidence,new Date().toISOString());const id=findId.get(f.name).id;for(const a of f.aliases||[])alias.run(id,a)}db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
async function body(req,max=12_000_000){return new Promise((resolve,reject)=>{let size=0,s='';req.on('data',c=>{size+=c.length;if(size>max){reject(new Error('请求内容过大'));req.destroy();return}s+=c});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error('JSON格式错误'))}});req.on('error',reject)})}
function localFoodSearch(q){
  const exact=db.prepare(`SELECT f.*,'local_exact' match_type FROM foods f LEFT JOIN aliases a ON a.food_id=f.id WHERE lower(f.name)=lower(?) OR lower(a.alias)=lower(?) LIMIT 1`).get(q,q);if(exact)return exact;
  return db.prepare(`SELECT f.*,'local_fuzzy' match_type FROM foods f LEFT JOIN aliases a ON a.food_id=f.id WHERE f.name LIKE ? OR a.alias LIKE ? OR (? LIKE '%'||f.name||'%') OR (length(a.alias)>=2 AND ? LIKE '%'||a.alias||'%') ORDER BY CASE WHEN ? LIKE '%'||a.alias||'%' THEN length(a.alias) ELSE length(f.name) END DESC LIMIT 1`).get(`%${q}%`,`%${q}%`,q,q,q);
}
function normalizeFood(row){return {id:row.id,name:row.name,category:row.category,per100g:{kcal:row.kcal,protein:row.protein,fat:row.fat,carbs:row.carbs},source:{type:row.source,url:row.source_url||null,id:row.source_id||null},confidence:row.confidence,matchType:row.match_type||'external'} }
async function searchUsda(q){
  const key=process.env.USDA_API_KEY;if(!key)return null;
  const r=await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q,pageSize:5,dataType:['Foundation','SR Legacy','Survey (FNDDS)']})});if(!r.ok)throw new Error(`USDA ${r.status}`);
  const data=await r.json(),food=data.foods?.[0];if(!food)return null;
  const nutrientList=food.foodNutrients||[],nutrients=Object.fromEntries(nutrientList.map(n=>[String(n.nutrientName).toLowerCase(),n.value]));
  const pick=(...names)=>{for(const n of names)if(nutrients[n]!=null)return nutrients[n];return 0};
  const kcal=nutrientList.find(n=>String(n.nutrientName).toLowerCase()==='energy'&&String(n.unitName).toUpperCase()==='KCAL')?.value??pick('energy');
  return {name:food.description,category:'external',per100g:{kcal,protein:pick('protein'),fat:pick('total lipid (fat)'),carbs:pick('carbohydrate, by difference')},source:{type:'USDA FoodData Central',url:`https://fdc.nal.usda.gov/fdc-app.html#/food-details/${food.fdcId}/nutrients`,id:String(food.fdcId)},confidence:'high',matchType:'external_api'};
}
function candidateNutrition(candidate,name){if(!candidate||candidate.kcal==null)return null;const kcal=Number(candidate.kcal),protein=Number(candidate.protein)||0,fat=Number(candidate.fat)||0,carbs=Number(candidate.carbs)||0;return {name:String(candidate.name||name),category:'external',per100g:{kcal,protein,fat,carbs},source:{type:String(candidate.sourceTitle||candidate.sourceUrl?'official_web_candidate':'official_web_candidate'),url:candidate.sourceUrl||null,id:null},confidence:['high','medium'].includes(candidate.confidence)?candidate.confidence:'low',matchType:'official_web_candidate'} }
async function resolveNutrition(name,{allowWeb=true}={}){
  const query=String(name||'').trim();if(!query)return {nutrition:null,source:'empty',trace:[]};const local=localFoodSearch(query);if(local)return {nutrition:normalizeFood(local),source:'local_database',trace:['local_database']};try{const usda=await searchUsda(query);if(usda)return {nutrition:usda,source:'usda_api',trace:['local_miss','usda_api']}}catch(error){console.warn(`USDA nutrition lookup failed for ${query}: ${error.message}`)}if(allowWeb&&process.env.DASHSCOPE_API_KEY){try{const candidate=await searchOfficialWeb(query),nutrition=candidateNutrition(candidate,query);if(nutrition)return {nutrition,source:'official_web_candidate',trace:['local_miss','usda_miss','official_web_search'],candidate}}catch(error){console.warn(`Official nutrition lookup failed for ${query}: ${error.message}`)}}return {nutrition:null,source:'unmatched',trace:['local_miss','usda_miss',allowWeb?'official_web_miss':'web_disabled']}
}
async function lookupBarcode(code){
  const r=await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`,{headers:{'User-Agent':'XiaoFan-Demo/0.2 (portfolio project)'}});if(!r.ok)throw new Error(`Open Food Facts ${r.status}`);const d=await r.json(),p=d.product;if(!p)return null;const n=p.nutriments||{};
  const number=(...values)=>{for(const value of values){const parsed=Number(value);if(Number.isFinite(parsed))return parsed}return null};
  const basis=String(p.nutrition_data_per||p.nutrition_data_prepared_per||'100g').toLowerCase().includes('ml')?'100ml':'100g',suffix=basis;
  const kj=number(n[`energy-kj_${suffix}`],n[`energy_${suffix}`]),kcal=number(n[`energy-kcal_${suffix}`],n['energy-kcal_100g'])??(kj==null?null:kj/4.184),name=p.product_name_zh||p.product_name||`商品 ${code}`;
  let nutrition={kcal:kcal==null?null:+kcal.toFixed(2),protein:number(n[`proteins_${suffix}`],n.proteins_100g),fat:number(n[`fat_${suffix}`],n.fat_100g),carbs:number(n[`carbohydrates_${suffix}`],n.carbohydrates_100g)},nutritionSource='open_food_facts',matchedReference=null;
  if(nutrition.kcal==null){const local=localFoodSearch(name);if(local){nutrition={kcal:local.kcal,protein:local.protein,fat:local.fat,carbs:local.carbs};nutritionSource='local_reference_fallback';matchedReference=local.name}}
  return {name,brand:p.brands||'',barcode:code,basis,servingSize:p.serving_size||null,per100g:nutrition,nutritionSource,matchedReference,source:{type:'Open Food Facts',url:`https://world.openfoodfacts.org/product/${code}`},confidence:nutritionSource==='local_reference_fallback'?'low':p.completeness>.7?'medium':'low'};
}
function responseText(data){return data.choices?.[0]?.message?.content||data.output_text||''}
function parseJsonText(text){const m=text.match(/```(?:json)?\s*([\s\S]*?)```/i);return JSON.parse(m?m[1]:text)}
async function qwenChat(payload){
  const key=process.env.DASHSCOPE_API_KEY;if(!key)throw new Error('DASHSCOPE_API_KEY 未配置');
  const base=(process.env.QWEN_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/,'');
  const r=await fetch(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({...payload,enable_thinking:false})});const d=await r.json();if(!r.ok)throw new Error(d.error?.message||`千问API ${r.status}`);return d;
}
async function analyzeImage(imageDataUrl,context=''){
  const today=shanghaiClock().date,d=await qwenChat({model:process.env.QWEN_VISION_MODEL||'qwen3-vl-plus',messages:[{role:'user',content:[{type:'text',text:`识别这张餐食图片，并结合用户说明判断具体菜名、食材、烹饪方式和可见份量。只返回JSON，不要markdown。结构：{"dishName":"","suggestedMealType":"早餐|午餐|晚餐|其他摄入|","recordDate":"YYYY-MM-DD","foods":[{"name":"","portionGramsMin":0,"portionGramsMax":0,"foodConfidence":"high|medium|low","portionConfidence":"high|medium|low","portionBasis":"视觉比例|用户说明|常见份量","cookingMethod":""}],"uncertainties":[],"followUpQuestion":""}。dishName直接给出最合适的通用菜名，不要加入“疑似”“可能”“大概”等不确定修饰词，不确定性只写入uncertainties。无法确定具体菜名时使用通用类别（如“中式汤面”“家常炒菜”），不要硬编一个具体菜名；foods 数组最多 8 项。今天日期是${today}。只有用户说明明确表达餐次时才填写suggestedMealType，否则返回空字符串；根据“今天、昨天”等明确表达填写recordDate，没有明确日期则使用今天。重量优先根据用户说明、餐具比例、食物数量和常见一人份给出合理区间，不能假装精确；完全无法判断时仍填写常见一人份范围。不要编造不可见配料，可把用油、酱汁写入uncertainties。上下文：${context||'用户未提供补充说明'}`},{type:'image_url',image_url:{url:imageDataUrl}}]}],response_format:{type:'json_object'}});
  return parseJsonText(responseText(d));
}
function imagePortionEstimate(item={},local=null){
  const positive=value=>{const n=Number(value);return Number.isFinite(n)&&n>0?n:null},modelMin=positive(item.portionGramsMin),modelMax=positive(item.portionGramsMax),single=positive(item.portionGrams);if(modelMin||modelMax||single){const center=single||modelMin||modelMax,min=Math.round(modelMin||center*.85),max=Math.round(modelMax||center*1.15);return {portionGramsMin:Math.max(1,Math.min(min,max)),portionGramsMax:Math.max(min,max),portionBasis:String(item.portionBasis||'视觉份量估算'),portionConfidence:String(item.portionConfidence||item.confidence||'medium')}}
  const name=String(item.name||''),category=String(local?.category||''),range=/油|酱/.test(name)?[5,15]:/饮品|饮料/.test(category)||/饮料|奶茶|咖啡|豆浆|牛奶/.test(name)?[250,500]:/蛋奶/.test(category)||/鸡蛋|鸭蛋/.test(name)?[50,100]:/肉类|水产|豆制品/.test(category)?[80,180]:/主食/.test(category)||/饭|面|粉|粥|薯|土豆/.test(name)?[100,220]:/蔬菜/.test(category)?[100,250]:/水果/.test(category)?[100,250]:[80,200];return {portionGramsMin:range[0],portionGramsMax:range[1],portionBasis:'按食物类别采用常见一人份',portionConfidence:'low'}
}
function fallbackRecipePlan(foods,cookTime){
  const portionFor=food=>/油/.test(food.name)?8:/主食/.test(food.category)?150:/肉类|水产/.test(food.category)?150:/蔬菜/.test(food.category)?200:/蛋奶/.test(food.category)?100:/豆制品/.test(food.category)?150:100;
  const regular=foods.filter(food=>!/调味料/.test(food.category)),pick=pattern=>regular.find(food=>pattern.test(food.category)),selected=[pick(/肉类|水产|蛋奶|豆制品/),pick(/蔬菜/),pick(/主食/)].filter(Boolean);if(!selected.length&&regular.length)selected.push(regular[0]);const extra=regular.find(food=>!selected.includes(food));if(selected.length<3&&extra)selected.push(extra);const oil=foods.find(food=>food.name==='食用植物油'),ingredients=selected.map(food=>({name:food.name,grams:portionFor(food)}));if(oil&&selected.some(food=>/肉类|水产|蛋奶|豆制品|蔬菜/.test(food.category)))ingredients.push({name:oil.name,grams:5});
  const steps=[`将${ingredients.map(x=>x.name).join('、')}按标注份量备好。`];if(selected.some(food=>/肉类|水产|蛋奶|豆制品/.test(food.category)))steps.push('将蛋白质类食材充分加热至熟。');if(selected.some(food=>/蔬菜/.test(food.category)))steps.push(`将${selected.filter(food=>/蔬菜/.test(food.category)).map(x=>x.name).join('、')}炒熟或蒸熟。`);if(selected.some(food=>/主食/.test(food.category)))steps.push(`将${selected.filter(food=>/主食/.test(food.category)).map(x=>x.name).join('、')}按份量装盘。`);steps.push('完成后按一人份装盘。');
  return {name:`${selected.map(x=>x.name.replace(/[（(].*?[）)]/g,'')).slice(0,3).join('')}家常餐`,ingredients,steps,minutes:Number.parseInt(cookTime)||20,reason:'根据已匹配的现有食材组合，营养值由本地数据库重新计算。',uncertainties:['实际用油、食材生熟状态和最终食用比例会影响总热量']};
}
function unsupportedFoodMentions(plan,allowedFoods){
  const text=[plan?.name,...(Array.isArray(plan?.steps)?plan.steps:[])].join(' '),allowedIds=new Set(allowedFoods.map(food=>String(food.id))),allowedNames=allowedFoods.map(food=>food.name),terms=db.prepare(`SELECT f.id,f.name term FROM foods f UNION ALL SELECT f.id,a.alias term FROM aliases a JOIN foods f ON f.id=a.food_id`).all(),unsupported=new Set();for(const row of terms){const term=String(row.term||'').trim(),knownCombination=/番茄炒(?:鸡)?蛋|西红柿炒(?:鸡)?蛋/.test(term)&&allowedNames.some(x=>/番茄|西红柿/.test(x))&&allowedNames.some(x=>/鸡蛋/.test(x));if(term.length>=2&&text.includes(term)&&!allowedIds.has(String(row.id))&&!knownCombination)unsupported.add(term)}return [...unsupported];
}
function calculateRecipeNutrition(plan,foods){
  const byName=new Map(foods.map(food=>[food.name,food])),items=[];
  for(const item of Array.isArray(plan.ingredients)?plan.ingredients:[]){const food=byName.get(String(item.name||'').trim());if(!food)continue;const grams=Math.min(600,Math.max(1,Number(item.grams)||0));if(!grams)continue;items.push({name:food.name,grams,category:food.category,source:food.source,kcal:+((food.kcal||0)*grams/100).toFixed(1),protein:+((food.protein||0)*grams/100).toFixed(1),fat:+((food.fat||0)*grams/100).toFixed(1),carbs:+((food.carbs||0)*grams/100).toFixed(1)});}
  if(!items.length)throw new Error('食谱没有使用已匹配的食材');
  const sum=key=>+items.reduce((total,item)=>total+(item[key]||0),0).toFixed(1);
  return {...plan,ingredients:items,nutrition:{kcal:Math.round(sum('kcal')),protein:sum('protein'),fat:sum('fat'),carbs:sum('carbs')}};
}
async function createDiyRecipe(input){
  const requested=[...new Set((Array.isArray(input.ingredients)?input.ingredients:[]).map(x=>String(x).trim()).filter(Boolean))].slice(0,12);if(!requested.length)throw new Error('请至少输入一种现有食材');
  const customFoods=new Map((Array.isArray(input.customFoods)?input.customFoods:[]).map((food,index)=>{const name=String(food.name||'').trim(),number=(value,min,max)=>{const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=min&&parsed<=max?parsed:null},kcal=number(food.kcal,0,1000),protein=number(food.protein,0,100),fat=number(food.fat,0,100),carbs=number(food.carbs,0,100);return [name,{id:`custom-${index}`,name,category:'用户输入',kcal,protein,fat,carbs,source:'user_input',source_url:null,source_id:null,confidence:'low',match_type:'user_provided'}]}).filter(([name,food])=>name&&food.kcal!=null&&food.protein!=null&&food.fat!=null&&food.carbs!=null));
  const matched=[],unmatched=[];for(const name of requested){const row=localFoodSearch(name)||customFoods.get(name);if(row&&!matched.some(x=>x.id===row.id))matched.push(row);else if(!row)unmatched.push(name)}if(!matched.length)throw Object.assign(new Error('没有找到可靠营养数据，请手动填写包装或权威来源中的每100g营养值'),{status:422,unmatched});
  const pantryNames=Array.isArray(input.pantry)?input.pantry:['食用植物油','酱油','食盐'],allowedPantry=new Set(['食用植物油','酱油','食盐','醋','白砂糖','辣椒酱','黑胡椒酱']),pantryFoods=pantryNames.filter(name=>allowedPantry.has(name)).map(localFoodSearch).filter(Boolean),availableFoods=[...matched];for(const food of pantryFoods)if(!availableFoods.some(x=>x.id===food.id))availableFoods.push(food);
  let plan=null,generatedBy='rules';const targets=mealTargets(input.profile||{},input.today||{},input.mealType||inferMealType());
  if(process.env.DASHSCOPE_API_KEY){try{const foodData=availableFoods.map(x=>({name:x.name,category:x.category,kcalPer100g:x.kcal,proteinPer100g:x.protein,fatPer100g:x.fat,carbsPer100g:x.carbs})),profile=input.profile||{},preferenceText=`饮食方式：${profile.mealMode||'未设置'}；当前想改善的习惯：${profile.habit||'无'}；辣度：${profile.tastePreference||'未设置'}；其他偏好：${profile.preferences||'无'}；不喜欢：${profile.dislikedFoods||'无'}；过敏或严格忌口：${profile.allergies||'无'}`,d=await qwenChat({model:process.env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'user',content:`根据以下真实可用食材生成一人份${targets.mealType}。本餐动态热量预算约${targets.mealKcal} kcal、蛋白质约${targets.mealProtein}g；今日总目标${targets.dailyTarget} kcal，已摄入${targets.consumedKcal} kcal，剩余${targets.remainingKcal} kcal，并须为后续餐次预留${targets.reservedKcal} kcal。尽量让食谱热量接近本餐预算，不能把全天剩余额度全部用完。不需要使用全部食材，应只选择适合组成这顿饭的部分食材。只能使用列表中的主食材、用户勾选的常备调料以及水，不得添加其他有热量的食材。用户可用调料：${pantryNames.join('、')||'无'}。勾选调料只代表允许使用，不要求全部加入；只选择这道菜真正需要的调料，未使用的调料不要写入ingredients或步骤。有热量的调料如使用必须写出实际克数，食用油建议0–10g。时间不超过${String(input.cookTime||'20分钟')}，厨具为${String(input.cookTools||'普通厨具')}。用户设置：${preferenceText}。过敏和严格忌口是硬约束，绝不能使用；口味是软偏好，只有已勾选调料能真实实现时才采用，不能用焦香等概念冒充辣味。食材数据库：${JSON.stringify(foodData)}。只返回JSON：{"name":"","ingredients":[{"name":"必须与数据库name完全一致","grams":0}],"steps":[""],"minutes":20,"reason":"","uncertainties":[""]}。克数必须可执行，步骤必须与厨具匹配。不要自行计算或声称精确营养值，营养由服务器计算。`} ]});plan=parseJsonText(responseText(d));generatedBy='qwen'}catch(e){console.warn(`DIY recipe model fallback: ${e.message}`)}}
  if(plan){const seen=new Set();plan.ingredients=(Array.isArray(plan.ingredients)?plan.ingredients:[]).filter(i=>{const n=String(i.name||'').trim();if(!n||seen.has(n))return false;seen.add(n);return true});plan.steps=(Array.isArray(plan.steps)?plan.steps:[]).slice(0,6);const unsupported=unsupportedFoodMentions(plan,availableFoods);if(unsupported.length){console.warn(`DIY recipe rejected unsupported foods: ${unsupported.join('、')}`);plan=null;generatedBy='rules'}}
  if(!plan)plan=fallbackRecipePlan(availableFoods,input.cookTime);
  let recipe;try{recipe=calculateRecipeNutrition(plan,availableFoods)}catch{generatedBy='rules';recipe=calculateRecipeNutrition(fallbackRecipePlan(availableFoods,input.cookTime),availableFoods)}
  return {recipe,matched:matched.map(normalizeFood),unmatched,generatedBy,targets};
}
async function searchOfficialWeb(q){
  const query=String(q||'').trim().slice(0,80);
  const d=await qwenChat({model:process.env.QWEN_WEB_MODEL||'qwen-plus',messages:[{role:'user',content:`只检索政府营养数据库、食品包装/品牌官方网站，查询“${query}”的每100克或每份热量、蛋白质、脂肪和碳水。返回严格JSON：{"name":"","basis":"per100g|perServing","servingGrams":null,"kcal":null,"protein":null,"fat":null,"carbs":null,"sourceUrl":"","sourceTitle":"","confidence":"high|medium|low","notes":[]}。找不到可靠官方来源则confidence设为low且数值为null；网页内容与查询不一致时也返回low且数值为null，不要强行对应；notes最多3条。`}],enable_search:true,response_format:{type:'json_object'}});
  const result=parseJsonText(responseText(d));
  if(result&&!validPublicUrl(result.sourceUrl))result.sourceUrl='';
  if(result&&!['high','medium','low'].includes(result.confidence))result.confidence='low';
  db.prepare('INSERT INTO candidates(name,payload,source_url,created_at) VALUES(?,?,?,?)').run(q,JSON.stringify(result),result.sourceUrl||'',new Date().toISOString());return result;
}
function restaurantTypeFallback(type=''){
  const rules=[
    [/奶茶|茶饮|饮品|冷饮|咖啡|咖啡厅|甜品|糕点|蛋糕/,['小杯无糖或低糖饮品','不加奶盖和额外小料'],'这里只适合记录为其他摄入，不能代替包含蛋白质、蔬菜和主食的正餐'],
    [/火锅|涮/,['清汤或番茄锅','瘦牛肉、鱼虾或豆腐','两份叶菜或菌菇','一份主食'],'优先清汤、明确蛋白质和蔬菜，蘸料少油'],
    [/面|粉|米线|拉面/,['小份清汤面或米线','加一份瘦肉或鸡蛋','加一份青菜'],'少喝汤，不叠加炸物和含糖饮料'],
    [/烧烤|烤串/,['鸡肉、牛肉或鱼虾串','烤蔬菜','一份主食'],'少选五花肉、肥肠和重油酱料'],
    [/汉堡|炸鸡|快餐/,['单层烤肉汉堡或鸡肉卷','玉米或沙拉','无糖饮料'],'不同时叠加炸鸡、薯条和甜品'],
    [/日式|寿司|日本料理/,['烤鱼、刺身或鸡肉定食','一份蔬菜','正常份量米饭'],'少选天妇罗、炸猪排和高糖酱汁'],
    [/粤菜|广东菜/,['清蒸鱼或白切鸡','一份时蔬','正常份量米饭'],'优先蒸煮菜，酱汁适量'],
    [/川菜|湘菜/,['瘦肉或鱼类主菜','一份清淡蔬菜','正常份量米饭'],'点餐时备注少油，避免多道重油菜叠加'],
    [/粥|早餐|包子|小吃/,['粥或一份主食','鸡蛋、豆浆或瘦肉','一份蔬菜'],'避免同时叠加多种油炸点心'],
    [/西餐|牛排/,['牛排、烤鸡或烤鱼','蔬菜','土豆或米饭'],'酱汁另放，少选奶油意面和油炸配菜']
  ];
  const found=rules.find(([pattern])=>pattern.test(type));
  return found?{dishes:found[1],reason:found[2]}:{dishes:['鸡、鱼、虾、瘦牛肉或豆腐主菜','一份蔬菜','正常份量主食'],reason:'优先明确蛋白质和蔬菜，少选油炸、浓汁及含糖饮料'};
}
function validPublicUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null}catch{return null}}
function buildAmapTagRecommendation(restaurant){
  const rawTags=restaurant.business?.tag;
  const tagDishes=(Array.isArray(rawTags)?rawTags:String(rawTags||'').split(/[,，、;；|]/)).map(x=>String(x).trim()).filter(Boolean);
  if(!tagDishes.length)return null;
  const lowerPriority=/炸|肥|酥|糖|奶油|甜|五花|肥肠/;
  const unique=[...new Set(tagDishes)],specific=unique.filter(x=>!/^(单人餐|双人餐|多人餐|套餐|招牌|特色)$/.test(x)),dishes=(specific.length?specific:unique).sort((a,b)=>Number(lowerPriority.test(a))-Number(lowerPriority.test(b))).slice(0,3);
  const beverageStore=/喜茶|奈雪|蜜雪冰城|茶百道|霸王茶姬|沪上阿姨|一点点|古茗|瑞幸|库迪|星巴克|奶茶|茶饮|饮品|冷饮|咖啡|甜品/i.test(`${restaurant.name||''} ${restaurant.type||''}`);
  const chineseRestaurant=/中餐|东北菜|川菜|湘菜|粤菜|家常菜|地方菜|餐馆|饭店/i.test(`${restaurant.name||''} ${restaurant.type||''}`);
  const foodItem=/三明治|贝果|卷|饭|面|粉|粥|饺|包|鸡|鱼|虾|牛|猪|肉|蛋|沙拉|披萨|意面|吐司|汉堡|热狗|汤|菜/,drinkItem=/茶|咖啡|拿铁|美式|摩卡|奶昔|果汁|气泡|冰沙|饮|瓶/;
  const hasFood=dishes.some(x=>foodItem.test(x)),hasDrink=dishes.some(x=>drinkItem.test(x));
  let reason='菜名直接来自高德POI特色内容，以上是候选菜品，任选一项而不是全部一起点';
  if(hasFood&&!hasDrink)reason=beverageStore?'这家店也提供轻食，以上是食物候选而不是饮品；可按当前餐次需求选择':'以上是食物候选，任选一项；请结合实际份量选择';
  else if(hasDrink&&!hasFood)reason='以上是可选饮品，任选一杯；如有低卡需求可选择低糖或不额外加料';
  else if(hasFood&&hasDrink)reason='候选中同时有食物和饮品：食物可作为轻食，饮品请选择低糖且不额外加料';
  const mealStructure=chineseRestaurant&&hasFood?`候选主菜任选1道：${dishes.join(' / ')}；建议搭配1份米饭和1份清淡蔬菜${dishes.some(x=>/地三鲜|青菜|蔬菜|土豆|茄子|豆角/.test(x))?'，如果主菜蛋白质较少，再加鸡蛋、豆腐或瘦肉类菜品':''}`:null;
  if(mealStructure)reason='高德返回的是特色主菜，不是完整套餐；米饭可以正常搭配，不需要因为减脂完全不吃主食，具体份量按饥饿程度调整';
  return {mode:'amap_tag',label:'高德特色菜',dishes,mealStructure,reason,sources:[],confidence:'medium',notes:'特色菜不等于完整实时菜单，供应情况以门店为准'};
}
async function findVerifiedRestaurantMenu(restaurant){
  if(!process.env.DASHSCOPE_API_KEY)return null;
  try{
    const d=await qwenChat({model:process.env.QWEN_WEB_MODEL||'qwen-plus',enable_search:true,response_format:{type:'json_object'},messages:[{role:'user',content:`检索餐厅“${restaurant.name}”（地址：${restaurant.address||'未知'}，类型：${restaurant.type||'未知'}）的公开菜单。只使用无需登录即可访问、允许公开检索的网页，不绕过验证码或反爬措施。严格核对分店名称和地址；不要根据店型编造该店菜名。饮品/甜品/咖啡店只返回饮品候选，不要编造主食。只返回JSON：{"restaurantMatched":false,"dishes":[{"name":"","reason":""}],"sources":[{"title":"","url":"","kind":"merchant_official|public_page"}],"confidence":"high|medium|low","notes":""}。只有商家官方来源，或至少两个相互印证的公开来源，才能把restaurantMatched设为true；无法可靠确认则返回false和空dishes。sources 的 url 必须真实可访问。最多返回3道相对均衡的真实菜名。`} ]});
    const result=parseJsonText(responseText(d)),sources=(Array.isArray(result.sources)?result.sources:[]).map(s=>({title:String(s.title||'公开菜单'),url:validPublicUrl(s.url),kind:s.kind==='merchant_official'?'merchant_official':'public_page'})).filter(s=>s.url),official=sources.some(s=>s.kind==='merchant_official'),corroborated=sources.length>=2;
    const dishes=(Array.isArray(result.dishes)?result.dishes:[]).map(x=>({name:String(x.name||'').trim(),reason:String(x.reason||'').trim()})).filter(x=>x.name).slice(0,3);
    if(result.restaurantMatched===true&&dishes.length&&(official||corroborated)&&['high','medium'].includes(result.confidence))return {mode:'verified_menu',label:'真实菜单推荐',dishes:dishes.map(x=>x.name),reason:dishes.map(x=>x.reason).filter(Boolean).join('；')||'结合当前档案优先选择蛋白质和蔬菜更明确的菜品',sources,confidence:result.confidence,notes:String(result.notes||'')};
  }catch(e){console.warn(`Menu lookup failed for ${restaurant.name}: ${e.message}`)}
  return null;
}
async function findRestaurantMenu(restaurant){
  const fallback=restaurantTypeFallback(`${restaurant.name||''} ${restaurant.type||''}`);
  const verified=await findVerifiedRestaurantMenu(restaurant);
  if(verified)return verified;
  const amap=buildAmapTagRecommendation(restaurant);
  if(amap)return amap;
  return {...fallback,mode:'type_fallback',label:'按店型推荐',reason:`${fallback.reason}；暂未找到可验证的公开菜单`,sources:[]};
}
function normalizeMealType(value=''){const text=String(value);if(/早/.test(text))return '早餐';if(/午|中午/.test(text))return '午餐';if(/晚餐|晚饭|晚上|今晚|明晚/.test(text))return '晚餐';if(/其他摄入|加餐|零食|夜宵|饮料/.test(text))return '其他摄入';return ''}
function inferMealType(message='',explicit=''){const named=normalizeMealType(explicit)||normalizeMealType(message);if(named)return named;const hour=new Date().getHours();return hour<10?'早餐':hour<16?'午餐':'晚餐'}
function shanghaiClock(){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:CN_TZ,hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,minutes:Number(parts.hour)*60+Number(parts.minute)}}
function mealTargets(profile={},today={},requestedMeal=''){
  const weight=Number(profile.weight)||60,height=Number(profile.height)||165,age=Number(profile.age)||30,targetWeight=Number(profile.targetWeight)||weight,targetDate=profile.targetDate?new Date(`${profile.targetDate}T12:00:00`):new Date(Date.now()+30*86400000),days=Math.max(1,Math.ceil((targetDate-new Date())/86400000)),base=10*weight+6.25*height-5*age+(profile.sex==='male'?5:-161),factor={sedentary:1.2,light:1.375,moderate:1.55,active:1.725}[profile.activity]||1.2,tdee=Math.round(base*factor),requiredDeficit=Math.max(0,Math.round((weight-targetWeight)*7700/days)),dailyTarget=Math.max(0,tdee-requiredDeficit+(Number(profile.budgetAdjustmentKcal)||0)),dailyProtein=Math.round(weight*1.3),consumedKcal=Math.max(0,Number(today.calories)||0),consumedProtein=Math.max(0,Number(today.protein)||0),remainingKcal=Math.max(0,dailyTarget-consumedKcal),remainingProtein=Math.max(0,dailyProtein-consumedProtein),mealType=normalizeMealType(requestedMeal)||inferMealType(),weights={早餐:.25,午餐:.4,晚餐:.35},order=['早餐','午餐','晚餐'],logged=new Set((Array.isArray(today.meals)?today.meals:[]).map(x=>normalizeMealType(x.type)).filter(Boolean)),isOther=mealType==='其他摄入',baseMeal=isOther?inferMealType():mealType,currentIndex=Math.max(0,order.indexOf(baseMeal)),futureMeals=order.slice(currentIndex+(isOther?0:1)).filter(x=>!logged.has(x)),allocationMeals=isOther?futureMeals:[mealType,...futureMeals],weightTotal=allocationMeals.reduce((sum,x)=>sum+(weights[x]||0),0)||1,mealShare=isOther?0:(weights[mealType]||.4)/weightTotal,mealKcal=isOther?0:Math.round(remainingKcal*mealShare),mealProtein=isOther?0:Math.round(remainingProtein*mealShare),reservedKcal=Math.max(0,remainingKcal-mealKcal);
  const weeklyLoss=requiredDeficit*7/7700,bmi=weight/Math.pow(height/100,2),targetBmi=targetWeight/Math.pow(height/100,2),riskReasons=[];
  if(weeklyLoss>1)riskReasons.push(`每周需减约 ${weeklyLoss.toFixed(1)} kg，超过常见安全上限（1 kg/周）`);
  if(dailyTarget<=0)riskReasons.push('按当前目标日期，即使完全不摄入热量也无法按时达成，计划不可行');
  if(bmi<18.5&&targetWeight<weight)riskReasons.push(`当前 BMI ${bmi.toFixed(1)} 已低于 18.5，继续减重风险较高`);
  if(targetBmi<18.5)riskReasons.push(`目标 BMI ${targetBmi.toFixed(1)} 低于 18.5，建议重新评估目标体重`);
  const safety=riskReasons.length?{extreme:true,warning:riskReasons.join('；')}:null;
  const budgetStatus=remainingKcal<=0?'exhausted':mealKcal<300?'low':'normal';
  return {dailyTarget,dailyProtein,consumedKcal,consumedProtein,remainingKcal,remainingProtein,mealType,mealKcal,mealProtein,reservedKcal,futureMeals,budgetStatus,safety};
}
async function createDailyMealPlan(input={}){
  const profile=input.profile||{},today=input.today||{},records=Array.isArray(today.meals)?today.meals:[],base=mealTargets(profile,today,'早餐'),order=['早餐','午餐','晚餐'],weights={早餐:.25,午餐:.4,晚餐:.35},logged=new Set(records.map(x=>normalizeMealType(x.type)).filter(type=>order.includes(type))),pending=order.filter(type=>!logged.has(type)),weightTotal=pending.reduce((sum,type)=>sum+weights[type],0)||1,budgets={};for(const type of order){const typeRecords=records.filter(x=>normalizeMealType(x.type)===type),skipped=typeRecords.length>0&&typeRecords.every(x=>x.status==='skipped'),recordedKcal=Math.round(typeRecords.reduce((sum,x)=>sum+(Number(x.calories)||0),0)),recordedProtein=+typeRecords.reduce((sum,x)=>sum+(Number(x.protein)||0),0).toFixed(1);budgets[type]={type,status:skipped?'skipped':typeRecords.length?'recorded':'planned',mealKcal:typeRecords.length?recordedKcal:Math.round(base.remainingKcal*weights[type]/weightTotal),mealProtein:typeRecords.length?recordedProtein:Math.round(base.remainingProtein*weights[type]/weightTotal),records:typeRecords.map(x=>({name:x.name,calories:x.calories,protein:x.protein,status:x.status}))}}
  const fallback={早餐:{name:'鸡蛋豆浆全麦早餐',description:'鸡蛋、无糖豆浆和全麦主食',diy:{name:'鸡蛋豆浆全麦早餐',ingredients:['鸡蛋1个','无糖豆浆250ml','全麦面包2片'],steps:['鸡蛋煮熟或少油煎熟','全麦面包加热后搭配无糖豆浆']}},午餐:{name:'鸡肉时蔬饭',description:'鸡肉、时令蔬菜和米饭',diy:{name:'鸡肉时蔬饭',ingredients:['鸡肉120g','时令蔬菜250g','熟米饭150g'],steps:['鸡肉切块并少油煎熟','加入蔬菜炒熟调味','与熟米饭搭配']}},晚餐:{name:'豆腐蔬菜饭',description:'豆腐、蔬菜和适量主食',diy:{name:'豆腐蔬菜饭',ingredients:['豆腐150g','时令蔬菜250g','熟米饭100g'],steps:['豆腐切块煎至定型','加入蔬菜炒熟并调味','搭配熟米饭食用']}}},generated={};if(pending.length&&process.env.DASHSCOPE_API_KEY){try{const preference=`饮食方式：${profile.mealMode||'未设置'}；口味：${profile.tastePreference||'未设置'}；偏好：${profile.preferences||'无'}；不喜欢：${profile.dislikedFoods||'无'}；过敏或严格忌口：${profile.allergies||'无'}`,request=pending.map(type=>({type,kcal:budgets[type].mealKcal,protein:budgets[type].mealProtein})),response=await qwenChat({model:process.env.QWEN_CHAT_MODEL||process.env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'user',content:`为用户生成今天尚未记录餐次的可执行DIY食谱。必须遵守过敏和严格忌口，不使用零食饮料代替正餐；食材克数和步骤要能实际操作，食谱贴近餐次预算，但不要声称未经数据库验证的精确营养值。每份食谱最多6个步骤，每个数组元素只能写一个完整步骤，不要把多个编号步骤塞进同一个字符串。所有数字最多保留两位小数。用户设置：${preference}。餐次预算：${JSON.stringify(request)}。只返回JSON：{"meals":[{"type":"早餐|午餐|晚餐","name":"简短菜名","description":"一句话组成说明","diy":{"name":"菜谱名","ingredients":["食材及份量"],"steps":["步骤"]}}]}`}]}),parsed=parseJsonText(responseText(response));for(const item of Array.isArray(parsed.meals)?parsed.meals:[]){const type=normalizeMealType(item.type),diy=item.diy||{};if(pending.includes(type))generated[type]={name:String(item.name||'').slice(0,60),description:String(item.description||'').slice(0,120),diy:{name:String(diy.name||item.name||'').slice(0,60),ingredients:(Array.isArray(diy.ingredients)?diy.ingredients:[]).map(x=>String(x).slice(0,80)).slice(0,8),steps:(Array.isArray(diy.steps)?diy.steps:[]).map(x=>String(x).slice(0,400)).slice(0,6)}}}}catch(e){console.warn(`Daily meal plan fallback: ${e.message}`)}}
  const meals=order.map(type=>{const target=budgets[type],names=target.records.map(x=>x.name).filter(Boolean);return {...target,...(target.status==='skipped'?{name:'本餐未吃',description:'已确认跳过本餐，不属于漏记'}:target.status==='recorded'?{name:names.join('、')||`${type}已记录`,description:`已记录约 ${target.mealKcal} kcal`}:generated[type]?.name?generated[type]:fallback[type])}});return {date:shanghaiClock().date,dailyTarget:base.dailyTarget,consumedKcal:base.consumedKcal,remainingKcal:base.remainingKcal,otherConsumedKcal:Math.round(records.filter(x=>normalizeMealType(x.type)==='其他摄入').reduce((sum,x)=>sum+(Number(x.calories)||0),0)),meals,generatedBy:Object.keys(generated).length?'qwen':'rules'}
}
function estimateMenuDish(name){
  const food=localFoodSearch(name);if(!food)return null;const category=String(food.category||''),drink=/饮品|零食饮料/.test(category)||/茶|咖啡|果汁|饮料/.test(name),staple=/主食|外卖快餐/.test(category)||/饭|面|粉|粥|饺|包|汉堡|披萨|三明治/.test(name),portionGrams=drink?400:staple?325:/家常菜/.test(category)?250:200,kcal=Math.round((food.kcal||0)*portionGrams/100),protein=+((food.protein||0)*portionGrams/100).toFixed(1);
  return {dish:name,matchedFood:food.name,category,portionGrams,kcal,protein,confidence:food.match_type==='local_exact'&&food.confidence==='high'?'high':food.match_type==='local_exact'?'medium':'low',matchType:food.match_type||'local_fuzzy',source:food.source};
}
function preferenceTerms(value){return String(value||'').split(/[、,，;；\s]+/).map(x=>x.replace(/不吃|过敏|不喜欢|忌口|不要/g,'').trim()).filter(x=>x.length>=2)}
function knownDishAllergens(name){const hints=[];if(/宫保|花生|坚果/.test(name))hints.push('花生','坚果');if(/麻酱|芝麻/.test(name))hints.push('芝麻');if(/奶油|芝士|拿铁|牛奶/.test(name))hints.push('乳制品','牛奶');if(/面包|面条|饺子|包子|披萨|三明治/.test(name))hints.push('麸质','小麦');if(/虾|蟹|贝|海鲜/.test(name))hints.push('海鲜','甲壳类');return hints}
function timeToMinutes(value){const m=String(value).match(/(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null}
function timeRanges(value=''){return [...String(value).matchAll(/(\d{1,2}:\d{2})\s*[-至~—]\s*(\d{1,2}:\d{2})/g)].map(m=>[timeToMinutes(m[1]),timeToMinutes(m[2])])}
function rangeContains(ranges,minute){return ranges.some(([start,end])=>end<start?minute>=start||minute<=end:minute>=start&&minute<=end)}
function weeklyHoursFor(date,text=''){const names=['周日','周一','周二','周三','周四','周五','周六'],name=names[date.getDay()],parts=String(text).split(/[；;\n]+/).map(x=>x.trim()).filter(Boolean),dayNumber=date.getDay()||7;for(const part of parts){const prefix=part.split(/[:：]/)[0];if(/每天|每日|周一至周日|周一到周日/.test(prefix)||prefix.includes(name))return part;const range=prefix.match(/周([一二三四五六日])\s*[至到-]\s*周?([一二三四五六日])/),map={一:1,二:2,三:3,四:4,五:5,六:6,日:7};if(range&&dayNumber>=map[range[1]]&&dayNumber<=map[range[2]])return part}return ''}
function restaurantHours(restaurant,mealType='午餐',dayOffset=0){const business=restaurant.business||{},date=new Date(Date.now()+(Number(dayOffset)===1?86400000:0)),mealMinute={早餐:8*60+30,午餐:12*60,晚餐:18*60+30,'其他摄入':15*60+30}[normalizeMealType(mealType)]??12*60,todayText=String(business.opentime_today||'').trim(),weekText=String(business.opentime_week||'').trim(),source=Number(dayOffset)===1?weeklyHoursFor(date,weekText):todayText||weeklyHoursFor(date,weekText);if(/24小时|全天/.test(source))return {status:'open',label:'该餐次营业',source};const ranges=timeRanges(source);if(!source||!ranges.length)return {status:'unknown',label:'营业时间待确认',source:weekText||todayText};return rangeContains(ranges,mealMinute)?{status:'open',label:`预计${normalizeMealType(mealType)}时段营业`,source}:{status:'closed',label:`预计${normalizeMealType(mealType)}时段不营业`,source}}
function personalizeRestaurant(restaurant,recommendation,context={}){
  const targets=mealTargets(context.profile,context.today,context.mealType),hours=restaurantHours(restaurant,targets.mealType,context.dayOffset),profile=context.profile||{},blocked=[...preferenceTerms(profile.allergies),...preferenceTerms(profile.dislikedFoods)],preferred=preferenceTerms(profile.preferences),text=`${restaurant.name||''} ${restaurant.type||''}`,isBeverage=/奶茶|茶饮|饮品|冷饮|咖啡|甜品|喜茶|奈雪|星巴克|瑞幸/i.test(text),isChinese=/中餐|东北菜|川菜|湘菜|粤菜|家常菜|地方菜|餐馆|饭店/i.test(text),conflicts=(dish,matched='')=>blocked.some(term=>dish.includes(term)||matched.includes(term)||knownDishAllergens(dish).includes(term)||knownDishAllergens(matched).includes(term)),allowedDishes=(recommendation.dishes||[]).filter(dish=>!conflicts(dish)),removedForPreference=allowedDishes.length!==(recommendation.dishes||[]).length,estimates=(recommendation.mode==='type_fallback'?[]:allowedDishes).map(estimateMenuDish).filter(Boolean).filter(item=>!conflicts(item.dish,item.matchedFood));
  for(const item of estimates){const addsSides=isChinese&&!/饭|面|粉|粥|饺|包|馒头/.test(item.dish),kcal=item.kcal+(addsSides?240:0),preferenceBonus=(preferred.some(term=>item.dish.includes(term))?8:0)+(Array.isArray(context.recentConfirmed)&&context.recentConfirmed.some(name=>name&&(item.dish.includes(name)||name.includes(item.dish)))?6:0);item.score=targets.budgetStatus==='normal'?Math.round(Math.max(0,100-Math.abs(kcal-targets.mealKcal)/Math.max(1,targets.mealKcal)*55-(item.confidence==='low'?15:0)+preferenceBonus)):Math.round(Math.max(0,100-kcal/8-(item.confidence==='low'?15:0)+preferenceBonus))}
  estimates.sort((a,b)=>b.score-a.score);const selected=estimates[0]||null;let mealDisplay=recommendation.mealStructure||null,kcal=null,protein=null,reason=recommendation.reason,confidence='low';
  if(selected){const chineseMain=targets.budgetStatus==='normal'&&isChinese&&!/饭|面|粉|粥|饺|包|馒头/.test(selected.dish),riceGrams=chineseMain?Math.round(Math.min(150,Math.max(40,targets.mealKcal*.22/1.16))):0,sideMin=chineseMain?Math.round(riceGrams*1.16+30):0,sideMax=chineseMain?Math.round(riceGrams*1.3+60):0,sideKcal=chineseMain?Math.round((sideMin+sideMax)/2):0,scale=targets.budgetStatus==='exhausted'?.4:Math.min(1.5,Math.max(.25,(chineseMain?Math.max(50,targets.mealKcal-sideKcal/2):targets.mealKcal)/Math.max(1,selected.kcal)));selected.portionGrams=Math.max(30,Math.round(selected.portionGrams*scale/10)*10);let kcal=Math.round(selected.kcal*scale+sideKcal),protein=+((selected.protein*scale+(chineseMain?3.5:0)).toFixed(1));mealDisplay=`${selected.dish}（约${selected.portionGrams}g）`;confidence=selected.confidence;if(chineseMain)mealDisplay+=` ＋ 熟米饭约${riceGrams}g ＋ 清淡蔬菜1小份`;reason=targets.budgetStatus==='exhausted'?`今日理论热量余额已用完；在没有其他要求时，已优先选择当前可核验候选中热量较低的餐食，食用后会超过今日理论目标`:targets.budgetStatus==='low'?`当前${targets.mealType}可用热量较少（约${targets.mealKcal} kcal）；在没有其他要求时，已优先选择热量较低的餐食`:`按今日剩余热量动态匹配${targets.mealType}约${targets.mealKcal} kcal，并为${targets.futureMeals.join('、')||'后续餐次'}预留${targets.reservedKcal} kcal；营养值按本地同名/近似菜和常见外食份量估算`}
  else if(removedForPreference&&!allowedDishes.length){mealDisplay='已排除与过敏、忌口或不喜欢食材冲突的候选菜';reason='当前已知菜单中没有安全候选，请查看店内其他菜品并再次确认配料'}
  else if(allowedDishes.some(dish=>/三明治|贝果|卷|饭|面|粉|粥|饺|包|沙拉|披萨|吐司|汉堡|热狗|鸡|鱼|虾|牛|肉|蛋/.test(dish))){reason=`可根据当前真实菜单或门店类型优先选择这类餐食；暂不强行估算热量，用餐后可拍照识别或手动记录实际摄入`}
  else if(isBeverage)reason=targets.budgetStatus==='normal'?'当前可核验候选是饮品或甜品，可按你的需求选择；用餐后再确认实际热量':'当前热量余额较少，饮品或甜品仍可作为候选；优先选择小份、低糖或不额外加料的选项';
  const cuisine=String(context.cuisine||''),cuisineMatch=!cuisine||text.includes(cuisine)||(cuisine==='中餐'&&isChinese),distanceScore=Math.max(0,20-(Number(restaurant.distance)||0)/200),recommendationScore=selected?selected.score:recommendation.mode==='verified_menu'?75:recommendation.mode==='amap_tag'?65:40,sourceScore=recommendation.mode==='verified_menu'?12:recommendation.mode==='amap_tag'?8:2,cuisineScore=cuisineMatch&&cuisine?15:0,hoursScore=hours.status==='open'?15:hours.status==='closed'?-100:0,score=Math.round(recommendationScore+distanceScore+sourceScore+cuisineScore+hoursScore);if(cuisine&&cuisineMatch)reason=`符合本餐“${cuisine}”偏好；${reason}`;
  return {...recommendation,dishes:allowedDishes,mealStructure:removedForPreference?null:recommendation.mealStructure,personalization:{targets,hours,mealDisplay,kcal,protein,confidence,reason,matchedCount:estimates.length,score,blockedTerms:blocked,nutritionPending:kcal==null}};
}
async function api(req,res,url){
  if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,services:{qwen:!!process.env.DASHSCOPE_API_KEY,usda:!!process.env.USDA_API_KEY,amap:!!process.env.AMAP_WEB_SERVICE_KEY,openFoodFacts:true},foodCount:db.prepare('SELECT COUNT(*) count FROM foods').get().count});
  if(req.method==='GET'&&url.pathname==='/api/nutrition/search'){
    const q=(url.searchParams.get('q')||'').trim();if(!q)return json(res,400,{error:'缺少q'});
    const local=localFoodSearch(q);if(local)return json(res,200,{ok:true,result:normalizeFood(local),trace:['local_database']});
    try{const ext=await searchUsda(q);if(ext)return json(res,200,{ok:true,result:ext,trace:['local_miss','usda_api']})}catch(e){return json(res,502,{error:e.message,trace:['local_miss','usda_error']})}
    return json(res,404,{error:'本地库与已配置外部API均未找到',canUseWeb:!!process.env.DASHSCOPE_API_KEY,trace:['local_miss',process.env.USDA_API_KEY?'usda_miss':'usda_not_configured']});
  }
  if(req.method==='GET'&&url.pathname==='/api/nutrition/resolve'){
    const q=(url.searchParams.get('q')||'').trim();if(!q)return json(res,400,{error:'缺少q'});try{const resolved=await resolveNutrition(q,{allowWeb:true});return resolved.nutrition?json(res,200,{ok:true,result:resolved.nutrition,source:resolved.source,trace:resolved.trace}):json(res,404,{error:'本地库、USDA和官方网页候选均未找到可靠营养数据',canUseWeb:!!process.env.DASHSCOPE_API_KEY,trace:resolved.trace})}catch(error){return json(res,502,{error:error.message})}
  }
  if(req.method==='GET'&&url.pathname.startsWith('/api/nutrition/barcode/')){try{const result=await lookupBarcode(url.pathname.split('/').pop());return result?json(res,200,{ok:true,result,trace:['open_food_facts']}):json(res,404,{error:'未找到商品'})}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='POST'&&url.pathname==='/api/nutrition/web-search'){try{const b=await body(req);return json(res,200,{ok:true,result:await searchOfficialWeb(b.query),trace:['official_web_search','candidate_saved']})}catch(e){return json(res,502,{error:e.message})}}
  if(req.method==='POST'&&url.pathname==='/api/meals/analyze'){
    try{const b=await body(req);if(!b.imageDataUrl)return json(res,400,{error:'缺少图片'});const vision=await analyzeImage(b.imageDataUrl,String(b.context||'').slice(0,500)),foods=[],resolvedTraces=new Set(['qwen_vision']),unmatched=[];let commonPortionCount=0;for(const f of (vision.foods||[]).slice(0,8)){const local=localFoodSearch(f.name),portion=imagePortionEstimate(f,local);if(portion.portionBasis==='按食物类别采用常见一人份')commonPortionCount++;const resolved=await resolveNutrition(f.name,{allowWeb:true});resolved.trace.forEach(item=>resolvedTraces.add(item));if(!resolved.nutrition)unmatched.push(f.name);foods.push({...f,confidence:f.foodConfidence||f.confidence||'medium',...portion,nutrition:resolved.nutrition})}const uncertainties=[...(Array.isArray(vision.uncertainties)?vision.uncertainties:[])];if(commonPortionCount)uncertainties.push(`${commonPortionCount}项无法可靠判断重量，已采用常见一人份范围`);if(unmatched.length)uncertainties.push(`未找到可靠营养数据：${unmatched.join('、')}；请补充每100g营养值后再计算`);return json(res,200,{ok:true,result:{...vision,foods,uncertainties,commonPortionCount,unmatchedFoods:unmatched},trace:[...resolvedTraces]})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/plans/daily-meals'){
    try{return json(res,200,{ok:true,result:await createDailyMealPlan(await body(req,400_000)),trace:['calculate_daily_target','allocate_three_meals','read_today_records','generate_daily_meal_overview']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/recipes/diy'){
    try{const result=await createDiyRecipe(await body(req,200_000));return json(res,200,{ok:true,result,trace:['local_nutrition_match',result.generatedBy==='qwen'?'qwen_recipe_plan':'rule_recipe_plan','server_nutrition_calculation']})}catch(e){return json(res,e.status||400,{error:e.message,unmatched:e.unmatched||[]})}
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/chat'){
    try{const b=await body(req,300_000);if(!rateAllowed(b.clientId))return json(res,429,{error:'Agent 请求太频繁，请稍后再试'});return json(res,200,{ok:true,result:await agentChat(b)})}catch(e){return json(res,e.status||502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/location/geocode'){
    const key=process.env.AMAP_WEB_SERVICE_KEY,address=String(url.searchParams.get('address')||'').trim();if(!key)return json(res,503,{error:'AMAP_WEB_SERVICE_KEY 未配置'});if(!address)return json(res,400,{error:'缺少地区或地址'});try{const r=await fetch(`https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address)}`),d=await r.json(),item=d.geocodes?.[0];if(d.status!=='1'||!item?.location)return json(res,404,{error:'无法解析该地区，请提供更完整的城市、区域或商圈'});const [lng,lat]=item.location.split(',').map(Number);return json(res,200,{ok:true,result:{lat,lng,formattedAddress:item.formatted_address||address},trace:['amap_geocode']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/restaurants/nearby'){
    const key=process.env.AMAP_WEB_SERVICE_KEY;if(!key)return json(res,503,{error:'AMAP_WEB_SERVICE_KEY 未配置'});const lat=Number(url.searchParams.get('lat')),lng=Number(url.searchParams.get('lng')),radius=Math.min(5000,Number(url.searchParams.get('radius')||3000)),requestedCuisine=String(url.searchParams.get('cuisine')||''),allowedCuisines=new Set(['中餐','东北菜','川菜','湘菜','粤菜','火锅','烧烤','日料','日本料理','韩餐','西餐','面食','轻食']),cuisine=allowedCuisines.has(requestedCuisine)?requestedCuisine:'';if(!lat||!lng)return json(res,400,{error:'缺少有效经纬度'});
    try{let location=`${lng},${lat}`;const convert=await fetch(`https://restapi.amap.com/v3/assistant/coordinate/convert?key=${encodeURIComponent(key)}&locations=${location}&coordsys=gps`),converted=await convert.json();if(converted.status==='1'&&converted.locations)location=converted.locations;const apiUrl=`https://restapi.amap.com/v5/place/around?key=${encodeURIComponent(key)}&location=${location}&types=050000${cuisine?`&keywords=${encodeURIComponent(cuisine)}`:''}&radius=${radius}&page_size=20&show_fields=business,photos`;const r=await fetch(apiUrl),d=await r.json();if(d.status!=='1')throw new Error(d.info||'高德查询失败');const results=(d.pois||[]).map(p=>({id:p.id,name:p.name,address:p.address,distance:Number(p.distance),type:p.type,typecode:p.typecode,business:p.business||{},photos:Array.isArray(p.photos)?p.photos.slice(0,6):[],location:p.location,source:'高德POI'}));return json(res,200,{ok:true,results,cuisine,trace:['browser_geolocation','amap_coordinate_convert',cuisine?'amap_cuisine_search':'amap_place_around','amap_business_photos']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/restaurants/recommendations'){
    try{const b=await body(req,400_000),requestedCount=Math.min(20,Math.max(1,Number(b.requestedCount)||5)),restaurants=Array.isArray(b.restaurants)?b.restaurants.slice(0,20):[];if(!restaurants.length)return json(res,400,{error:'缺少候选餐馆'});const dayOffset=Number(b.dayOffset)===1?1:0,mealType=String(b.mealType||''),today=dayOffset?{calories:0,protein:0,meals:[]}:b.today||{},hoursChecked=restaurants.map(restaurant=>({restaurant,hours:restaurantHours(restaurant,mealType,dayOffset)})),closedCount=hoursChecked.filter(x=>x.hours.status==='closed').length,eligible=hoursChecked.filter(x=>x.hours.status!=='closed').slice(0,requestedCount).map(x=>x.restaurant),personalized=await Promise.all(eligible.map(async restaurant=>{const menu=await findRestaurantMenu(restaurant);return {...restaurant,recommendation:personalizeRestaurant(restaurant,menu,{profile:b.profile||{},today,mealType,dayOffset,cuisine:String(b.cuisine||'')})}})),results=personalized.sort((a,b)=>b.recommendation.personalization.score-a.recommendation.personalization.score);return json(res,200,{ok:true,results,targets:results[0]?.recommendation.personalization.targets,cuisine:String(b.cuisine||''),dayOffset,requestedCount,returnedCount:results.length,closedCount,trace:['amap_candidates','business_hours_check','closed_restaurants_filtered','requested_count_applied','public_menu_search','menu_verification','local_nutrition_match',dayOffset?'new_day_meal_budget':'dynamic_meal_budget','cuisine_preference','personalized_ranking']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/user/state'){
    const clientId=url.searchParams.get('clientId')||'',state=buildUserState(userRow(clientId));
    return state?json(res,200,{ok:true,state}):json(res,404,{error:'该用户尚未同步到服务器'});
  }
  if(req.method==='PUT'&&url.pathname==='/api/user/state'){
    try{const b=await body(req,2_000_000);return json(res,200,{ok:true,state:upsertUser(b.clientId,b)})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/tasks'){
    schedulerTick();const clientId=url.searchParams.get('clientId')||'';return json(res,200,{ok:true,tasks:pendingTasks(clientId,shanghaiClock().date)});
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/tasks/complete'){
    try{const b=await body(req);return json(res,200,{ok:true,result:completeAgentTask(b.id)})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/memory'){
    try{const b=await body(req);return json(res,200,{ok:true,result:addMemoryEvent(b.clientId,b.kind,b.date,b.payload)})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/memory'){
    const clientId=url.searchParams.get('clientId')||'';return json(res,200,{ok:true,events:recentMemory(clientId),summary:memorySummaries(clientId)});
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/review'){
    try{const b=await body(req);return json(res,200,{ok:true,result:await runAgentReview(b.clientId)})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/events'){
    const clientId=url.searchParams.get('clientId')||'';sseConnect(req,res,clientId);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/tasks/accept'){
    try{const b=await body(req);const t=db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(Number(b.id)||0);if(t){db.prepare("UPDATE agent_tasks SET status='done',state='done' WHERE id=?").run(t.id);addMemoryEvent(b.clientId||'','task_accepted',shanghaiClock().date,{kind:t.kind,id:t.id});sseSend(b.clientId||'',{type:'task_update',id:t.id,status:'done'})}return json(res,200,{ok:true})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/tasks/dismiss'){
    try{const b=await body(req);const t=db.prepare('SELECT * FROM agent_tasks WHERE id=?').get(Number(b.id)||0);if(t){db.prepare("UPDATE agent_tasks SET status='cancelled',state='cancelled' WHERE id=?").run(t.id);addMemoryEvent(b.clientId||'','task_dismissed',shanghaiClock().date,{kind:t.kind,id:t.id});sseSend(b.clientId||'',{type:'task_update',id:t.id,status:'cancelled'})}return json(res,200,{ok:true})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/goals'){
    const clientId=url.searchParams.get('clientId')||'';return json(res,200,{ok:true,goal:goalState(clientId)});
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/executions'){
    const clientId=url.searchParams.get('clientId')||'',limit=Number(url.searchParams.get('limit'))||20;
    return json(res,200,{ok:true,goals:executionGoals(clientId,limit)});
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/logs'){
    const clientId=url.searchParams.get('clientId')||'',limit=Number(url.searchParams.get('limit'))||200,kind=String(url.searchParams.get('kind')||'');
    return json(res,200,{ok:true,logs:readAgentLogs(clientId,limit,kind)});
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/check'){
    const clientId=url.searchParams.get('clientId')||'',row=userRow(clientId);
    if(!row)return json(res,200,{ok:true,tasks:[],summary:[],adjustment:0});
    schedulerTick();
    return json(res,200,{ok:true,tasks:pendingTasks(clientId,shanghaiClock().date),summary:memorySummaries(clientId),adjustment:Number(row.budget_adjustment_kcal)||0});
  }
  return false;
}
function staticFile(req,res,url){
  const rel=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));const path=normalize(join(ROOT,rel));if(!path.startsWith(ROOT)||!existsSync(path))return json(res,404,{error:'Not found'});
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(readFileSync(path));
}
// ==================== 真正的 Agent：状态落库 / 工具循环 / 规划 / 记忆 / 调度 / 复盘 ====================
function userRow(clientId){if(!clientId)return null;return db.prepare('SELECT * FROM users WHERE client_id=?').get(String(clientId))}
function buildUserState(row){
  if(!row)return null;
  const meals=db.prepare('SELECT date,type,name,calories,protein,source,recorded_at FROM meal_logs WHERE user_id=? ORDER BY date,id').all(row.id);
  const weights=db.prepare('SELECT date,weight,source,recorded_at FROM weight_logs WHERE user_id=? ORDER BY date').all(row.id);
  let profile={};try{profile=JSON.parse(row.profile||'{}')}catch{}
  let chatHistory=[];try{chatHistory=JSON.parse(row.chat_history||'[]')}catch{}
  let pendingMealEstimate=null;try{pendingMealEstimate=JSON.parse(row.pending_meal||'null')}catch{}
  if(profile.budgetAdjustmentKcal===undefined)profile.budgetAdjustmentKcal=Number(row.budget_adjustment_kcal)||0;
  return {clientId:row.client_id,profile,mealLogs:meals,weightLogs:weights,chatHistory,pendingMealEstimate,createdAt:row.created_at,updatedAt:row.updated_at};
}
function upsertUser(clientId,state={}){
  const id=String(clientId||'');if(!id)throw new Error('缺少 clientId');
  const existing=userRow(id);
  const adjustment=Math.max(-300,Math.min(300,Number(state.profile?.budgetAdjustmentKcal)||existing?.budget_adjustment_kcal||0));
  const now=new Date().toISOString();
  const profile={...(state.profile||{}),budgetAdjustmentKcal:adjustment};
  db.prepare(`INSERT INTO users(client_id,profile,chat_history,pending_meal,budget_adjustment_kcal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET profile=excluded.profile,chat_history=excluded.chat_history,pending_meal=excluded.pending_meal,budget_adjustment_kcal=excluded.budget_adjustment_kcal,updated_at=excluded.updated_at`)
    .run(id,JSON.stringify(profile),JSON.stringify(Array.isArray(state.chatHistory)?state.chatHistory.slice(-100):[]),JSON.stringify(state.pendingMealEstimate||null),adjustment,now,now);
  const row=userRow(id);
  db.prepare('DELETE FROM meal_logs WHERE user_id=?').run(row.id);
  db.prepare('DELETE FROM weight_logs WHERE user_id=?').run(row.id);
  for(const meal of Array.isArray(state.mealLogs)?state.mealLogs:[]){
    if(!meal||!meal.date||!meal.type)continue;
    db.prepare('INSERT INTO meal_logs(user_id,date,type,name,calories,protein,source,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.id,String(meal.date).slice(0,10),String(meal.type).slice(0,20),String(meal.name||'').slice(0,120),Number(meal.calories)||0,Number(meal.protein)||0,String(meal.source||'manual').slice(0,60),String(meal.recordedAt||meal.createdAt||now));
  }
  for(const w of Array.isArray(state.weightLogs)?state.weightLogs:[]){
    if(!w||!w.date)continue;
    db.prepare(`INSERT INTO weight_logs(user_id,date,weight,source,recorded_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,date) DO UPDATE SET weight=excluded.weight,source=excluded.source,recorded_at=excluded.recorded_at`)
      .run(row.id,String(w.date).slice(0,10),Number(w.weight)||0,String(w.source||'manual').slice(0,60),String(w.recordedAt||w.createdAt||now));
  }
  syncGoal(row.id,profile);
  const date=shanghaiClock().date;
  const loggedTypes=new Set(db.prepare('SELECT type FROM meal_logs WHERE user_id=? AND date=?').all(row.id,date).map(x=>normalizeMealType(x.type)));
  if(loggedTypes.has('午餐'))db.prepare("UPDATE agent_tasks SET status='done' WHERE user_id=? AND kind='plan_lunch' AND due_date=? AND status='pending'").run(row.id,date);
  if(loggedTypes.has('晚餐'))db.prepare("UPDATE agent_tasks SET status='done' WHERE user_id=? AND kind='plan_dinner' AND due_date=? AND status='pending'").run(row.id,date);
  return buildUserState(row);
}
function addMemoryEvent(clientId,kind,date,payload={}){
  const row=userRow(clientId);if(!row)return null;
  const now=new Date().toISOString();
  const info=db.prepare('INSERT INTO agent_memory(user_id,kind,date,payload,created_at) VALUES(?,?,?,?,?)').run(row.id,String(kind||'event').slice(0,40),String(date||'').slice(0,10),JSON.stringify(payload||{}),now);
  return {id:Number(info.lastInsertRowid)};
}
function recentMemory(clientId,limit=200){
  const row=userRow(clientId);if(!row)return [];
  return db.prepare('SELECT kind,date,payload,created_at FROM agent_memory WHERE user_id=? ORDER BY id DESC LIMIT ?').all(row.id,Math.min(500,Math.max(1,Number(limit)||200))).map(x=>({kind:x.kind,date:x.date,payload:JSON.parse(x.payload||'{}'),createdAt:x.created_at})).reverse();
}
function recentConfirmedNames(clientId,limit=10){
  return recentMemory(clientId,50).filter(e=>e.kind==='meal_confirmed').slice(-limit).map(e=>String(e.payload?.name||'')).filter(Boolean);
}
function memorySummaries(clientId,days=7){
  const events=recentMemory(clientId,500),summaries=[];
  const dayList=[...new Set(events.map(e=>e.date).filter(Boolean))].slice(-days);
  for(const day of dayList){
    const dayEvents=events.filter(e=>e.date===day);
    const confirmed=dayEvents.filter(e=>e.kind==='meal_confirmed');
    summaries.push({date:day,meals:confirmed.length,mealNames:confirmed.slice(-3).map(e=>String(e.payload?.name||'').slice(0,30))});
  }
  return summaries;
}
function pendingTasks(clientId,date){
  const row=userRow(clientId);if(!row)return [];
  return db.prepare("SELECT id,kind,due_date,status,payload,created_at FROM agent_tasks WHERE user_id=? AND due_date=? AND status='pending' ORDER BY id").all(row.id,String(date||'')).map(x=>({id:Number(x.id),kind:x.kind,dueDate:x.due_date,status:x.status,payload:JSON.parse(x.payload||'{}'),createdAt:x.created_at}));
}
function completeAgentTask(id){
  const info=db.prepare("UPDATE agent_tasks SET status='done' WHERE id=? AND status='pending'").run(Number(id)||0);
  return {ok:info.changes>0};
}
function weightTrend(weightLogs=[]){
  const logs=weightLogs.map(x=>({date:String(x.date||''),weight:Number(x.weight)||0})).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)).slice(-14);
  if(logs.length<7)return {enough:false,slopePerWeek:null,avg7:null,prevAvg7:null,deltaWeek:null};
  const n=logs.length,points=logs.map((p,i)=>({x:i,y:p.weight})),sumX=points.reduce((s,p)=>s+p.x,0),sumY=points.reduce((s,p)=>s+p.y,0),sumXY=points.reduce((s,p)=>s+p.x*p.y,0),sumXX=points.reduce((s,p)=>s+p.x*p.x,0);
  const slope=(n*sumXY-sumX*sumY)/(n*sumXX-sumX*sumX||1);
  const avg=arr=>arr.length?arr.reduce((s,x)=>s+x.weight,0)/arr.length:null;
  const last7=logs.slice(-7),prev7=logs.slice(-14,-7);
  return {enough:true,slopePerWeek:slope*7,avg7:avg(last7),prevAvg7:avg(prev7),deltaWeek:avg(last7)-avg(prev7)};
}
const AGENT_TOOLS=[
  {type:'function',function:{name:'read_user_state',description:'读取用户长期档案、今日已摄入、动态预算与待确认餐食。',parameters:{type:'object',properties:{},required:[]}}},
  {type:'function',function:{name:'get_meal_budget',description:'按餐次计算本餐动态热量/蛋白质预算（含为后续餐次预留）。',parameters:{type:'object',properties:{mealType:{type:'string',enum:['早餐','午餐','晚餐','其他摄入']},dayOffset:{type:'number'}},required:['mealType']}}},
  {type:'function',function:{name:'compose_diy_recipe',description:'用现有食材生成带克数与步骤的食谱，返回服务器按数据库实算的营养。',parameters:{type:'object',properties:{ingredients:{type:'array',items:{type:'string'}},pantry:{type:'array',items:{type:'string'}},cookTime:{type:'string'},cookTools:{type:'string'},mealType:{type:'string'}},required:['ingredients']}}},
  {type:'function',function:{name:'search_nearby_restaurants',description:'按坐标或区域搜索附近餐馆；提供 area 时先转成坐标，否则需要 latitude/longitude。',parameters:{type:'object',properties:{latitude:{type:'number'},longitude:{type:'number'},radius:{type:'number'},cuisine:{type:'string'},area:{type:'string'}},required:[]}}},
  {type:'function',function:{name:'get_restaurant_menu',description:'检索某家餐馆的公开菜单或高德特色菜。',parameters:{type:'object',properties:{restaurant:{type:'object'}},required:['restaurant']}}},
  {type:'function',function:{name:'personalize_restaurant',description:'按预算、忌口硬过滤、偏好与近期确认记录，对候选菜做个性化匹配和份量调整。',parameters:{type:'object',properties:{restaurant:{type:'object'},menu:{type:'object'},mealType:{type:'string'}},required:['restaurant','menu']}}},
  {type:'function',function:{name:'search_nutrition',description:'查询食材/菜品每100g营养（本地库→USDA→官方网页）。',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']}}},
  {type:'function',function:{name:'get_daily_plan',description:'生成今天尚未记录餐次的三餐概览与DIY食谱。',parameters:{type:'object',properties:{},required:[]}}},
  {type:'function',function:{name:'get_memory',description:'读取最近7天经历记忆摘要（已确认餐食、复盘结论）。',parameters:{type:'object',properties:{},required:[]}}},
  {type:'function',function:{name:'propose_meal_record',description:'生成“确认入账”提案：只返回待确认的餐食条目，绝不写入记录。',parameters:{type:'object',properties:{name:{type:'string'},calories:{type:'number'},protein:{type:'number'},mealType:{type:'string'},recordDate:{type:'string'},source:{type:'string'}},required:['name','calories','mealType']}}},
  {type:'function',function:{name:'revise_pending_meal',description:'用户补充影响估算的信息（食材、份量、用油等）时，修正待确认的图片估算并返回修正结果，不写入饮食记录。',parameters:{type:'object',properties:{revisedName:{type:'string'},revisedCalories:{type:'number'},revisedProtein:{type:'number'},revisionNote:{type:'string'}},required:['revisedCalories']}}}
];
async function executeAgentTool(tool,args,ctx){
  const name=tool||'';
  const trace={tool:name,ok:true};
  try{
    if(name==='read_user_state')return {...trace,result:{profile:ctx.profile,consumed:ctx.consumed,targets:ctx.targets,pendingMeal:ctx.pendingMeal?{name:ctx.pendingMeal.name,calories:ctx.pendingMeal.calories,protein:ctx.pendingMeal.protein}:null}};
    if(name==='get_meal_budget')return {...trace,result:mealTargets(ctx.profile,ctx.today,String(args.mealType||ctx.mealType))};
    if(name==='get_daily_plan')return {...trace,result:await createDailyMealPlan({profile:ctx.profile,today:ctx.today,mealType:String(args.mealType||ctx.mealType)})};
    if(name==='compose_diy_recipe')return {...trace,result:await createDiyRecipe({ingredients:Array.isArray(args.ingredients)?args.ingredients:[],pantry:Array.isArray(args.pantry)?args.pantry:[],cookTime:String(args.cookTime||'20分钟'),cookTools:String(args.cookTools||'普通厨具'),mealType:String(args.mealType||ctx.mealType),dayOffset:Number(args.dayOffset)||0,profile:ctx.profile,today:ctx.today})};
    if(name==='search_nearby_restaurants'){
      const key=process.env.AMAP_WEB_SERVICE_KEY;
      let lat=Number(args.latitude),lng=Number(args.longitude);
      const area=String(args.area||'').trim();
      if((!lat||!lng)&&area){
        if(!key)return {...trace,ok:false,result:{error:'AMAP_WEB_SERVICE_KEY 未配置'}};
        try{
          const geoRes=await fetch(`https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(area)}`);
          const geoData=await geoRes.json();
          const item=geoData.geocodes?.[0];
          if(geoData.status==='1'&&item?.location){
            const [parsedLng,parsedLat]=item.location.split(',').map(Number);
            if(Number.isFinite(parsedLat)&&Number.isFinite(parsedLng)){lat=parsedLat;lng=parsedLng;}
          }
        }catch(e){console.warn(`Agent geocode failed for area: ${e.message}`)}
      }
      if(!key||!lat||!lng)return {...trace,ok:false,result:{error:'缺少有效位置或高德未配置；请提供城市/商圈/地址后重试'}};
      const radius=Math.min(5000,Math.max(100,Number(args.radius)||3000)),cuisine=String(args.cuisine||''),allowedCuisines=new Set(['中餐','东北菜','川菜','湘菜','粤菜','火锅','烧烤','日料','日本料理','韩餐','西餐','面食','轻食']),c=allowedCuisines.has(cuisine)?cuisine:'';
      let location=`${lng},${lat}`;const convert=await fetch(`https://restapi.amap.com/v3/assistant/coordinate/convert?key=${encodeURIComponent(key)}&locations=${location}&coordsys=gps`),converted=await convert.json();if(converted.status==='1'&&converted.locations)location=converted.locations;
      const r=await fetch(`https://restapi.amap.com/v5/place/around?key=${encodeURIComponent(key)}&location=${location}&types=050000${c?`&keywords=${encodeURIComponent(c)}`:''}&radius=${radius}&page_size=20&show_fields=business,photos`),d=await r.json();
      if(d.status!=='1')throw new Error(d.info||'高德查询失败');
      return {...trace,result:(d.pois||[]).map(p=>({id:p.id,name:p.name,address:p.address,distance:Number(p.distance),type:p.type,business:p.business||{},location:p.location}))};
    }
    if(name==='get_restaurant_menu')return {...trace,result:await findRestaurantMenu(args.restaurant||{})};
    if(name==='personalize_restaurant'){
      const p=personalizeRestaurant(args.restaurant||{},args.menu||{},ctx);
      return {...trace,result:p.personalization};
    }
    if(name==='search_nutrition')return {...trace,result:await resolveNutrition(String(args.name||''),{allowWeb:true})};
    if(name==='get_memory')return {...trace,result:memorySummaries(ctx.clientId,7)};
    if(name==='propose_meal_record'){
      const mealType=normalizeMealType(args.mealType);if(!mealType)return {...trace,ok:false,result:{error:'餐次无效，请询问用户要记录到早餐/午餐/晚餐还是其他摄入'}};
      const today=shanghaiClock().date,rawDate=String(args.recordDate||''),minDate=String(new Date(Date.now()-7*86400000).toISOString().slice(0,10));
      const recordDate=/^\d{4}-\d{2}-\d{2}$/.test(rawDate)&&rawDate<=today&&rawDate>=minDate?rawDate:today;
      const originalMessage=String(args.originalMessage||ctx.message||args.name||''),hasExplicitEnergy=/(\d+(?:\.\d+)?)\s*(?:kcal|千卡|卡路里|卡)/i.test(originalMessage);
      const estimate=!hasExplicitEnergy?estimateTextMealRecord(originalMessage):null;
      if(estimate&&!estimate.ok)return {...trace,ok:false,result:{error:estimate.error}};
      const calories=estimate?estimate.calories:Math.round(Number(args.calories)||0),protein=estimate?estimate.protein:+((Number(args.protein)||0).toFixed(1)),recordName=estimate?estimate.name:String(args.name||'').trim();
      if(!recordName||calories<=0)return {...trace,ok:false,result:{error:'缺少可靠的餐食热量估算；请补充每种食物的份量、克数或包装营养信息后再生成记录提案'}};
      return {...trace,result:{action:'confirm_meal_record',payload:{name:recordName.slice(0,100),calories,protein:Math.max(0,protein),mealType,recordDate,source:String(estimate?.source||args.source||'用户文字记录').slice(0,120)}}};
    }
    if(name==='revise_pending_meal'){
      const calories=Math.max(0,Math.round(Number(args.revisedCalories)||0));if(calories<=0)return {...trace,ok:false,result:{error:'补充信息不足以形成可靠的新热量估算，请询问用户更多细节'}};
      let pending=ctx.pendingMeal;const row=userRow(ctx.clientId);
      if(row&&row.pending_meal){try{pending=JSON.parse(row.pending_meal)||pending}catch{}}
      if(!pending)return {...trace,ok:false,result:{error:'没有待确认的图片估算，不能修正'}};
      const revised={...pending,name:String(args.revisedName||pending.name||'图片识别餐食').replace(/[（(]?疑似[）)]?/g,'').trim().slice(0,100),calories,protein:Math.max(0,+((Number(args.revisedProtein)||0).toFixed(1))),breakdown:String(pending.breakdown||'').concat(String(args.revisionNote||'')?`；${String(args.revisionNote).slice(0,300)}`:'').slice(0,1600),followUpQuestion:'',updatedAt:new Date().toISOString()};
      if(row)db.prepare('UPDATE users SET pending_meal=?,updated_at=? WHERE id=?').run(JSON.stringify(revised),new Date().toISOString(),row.id);
      return {...trace,result:{action:'revised_meal_estimate',payload:{revisedName:revised.name,calories:revised.calories,protein:revised.protein,revisionNote:String(args.revisionNote||'').slice(0,300)}}};
    }
    return {...trace,ok:false,result:{error:`未知工具：${name}`}};
  }catch(e){return {...trace,ok:false,result:{error:e.message}}}
}
function isMealRecordRequest(message=''){
  const text=String(message||'');
  return /(?:帮我|给我|把|将).{0,24}(?:记录|入账|记上|记到|记成|记一笔|记一下)/.test(text)||/请(?:帮我)?(?:记录|入账|记上|记到|记成|记一笔|记一下)/.test(text)||/(?:早餐|午餐|晚餐|早饭|午饭|晚饭|加餐).{0,30}(?:记录|入账|记上|记到|记成|记一笔|记一下)/.test(text);
}
function mentionedFoodNames(message='',limit=8){
  const text=String(message||'');
  const rows=db.prepare('SELECT name,term FROM (SELECT name,name AS term FROM foods UNION ALL SELECT f.name,a.alias AS term FROM aliases a JOIN foods f ON f.id=a.food_id) ORDER BY length(term) DESC').all();
  return [...new Set(rows.filter(row=>String(row.term||'').length>=2&&text.includes(String(row.term||''))).map(row=>String(row.name||'')))].slice(0,limit);
}
function chineseQuantity(value=''){
  const text=String(value).trim();if(/^\d+$/.test(text))return Number(text);
  const map={一:1,二:2,两:2,俩:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  if(map[text]!=null)return map[text];
  if(/^十[一二三四五六七八九]$/.test(text))return 10+map[text[1]];
  if(/^[二三四五六七八九]十$/.test(text))return map[text[0]]*10;
  return 1;
}
function splitTextMealItems(message=''){
  const text=String(message||'').replace(/\s+/g,'').trim(),matched=text.match(/(?:吃了|吃的|吃|喝了|喝的|喝)\s*(.+)$/),body=(matched?matched[1]:text).split(/[。！？；;]/)[0];
  return body.split(/(?:还有|以及|加上|、|，|,|和|跟|及)/).map(part=>part.trim()).filter(Boolean).map(part=>{
    const grams=part.match(/^(\d+(?:\.\d+)?)\s*(?:g|克)\s*(.+)$/i);if(grams)return {name:grams[2].trim(),quantity:1,grams:Number(grams[1]),unit:'克'};
    const quantity=part.match(/^([\d一二两三四五六七八九十俩]+)\s*(个|只|份|颗|枚)?\s*(.+)$/);
    return quantity?{name:quantity[3].trim(),quantity:Math.max(1,chineseQuantity(quantity[1])),grams:null,unit:quantity[2]||'份'}:{name:part,quantity:1,grams:null,unit:'份'};
  });
}
function matchTextMealFood(name=''){
  const clean=String(name||'').replace(/[，。；;！!？?]/g,'').trim();if(!clean)return null;
  const fallback=[[/牛肉包|猪肉包|鲜肉包|肉包/, '肉包子'],[/菜包|素包/, '菜包子'],[/豆沙包|红豆包/, '豆沙包']].find(([pattern])=>pattern.test(clean));
  if(fallback)return localFoodSearch(fallback[1]);
  return localFoodSearch(clean);
}
function defaultTextMealGrams(food,name=''){
  const text=String(name||'');
  if(/鸡蛋/.test(text)&&!/鸡蛋灌饼/.test(text))return 50;
  if(/小笼/.test(text)||/小笼包/.test(String(food?.name||'')))return 30;
  if(/包/.test(text)||/包子/.test(String(food?.name||'')))return 100;
  return null;
}
function estimateTextMealRecord(message=''){
  const items=splitTextMealItems(message);if(!items.length)return {ok:false,error:'没有识别到可记录的食物，请补充吃了什么和每种食物的份量'};
  const resolved=[],unmatched=[];
  for(const item of items){const food=matchTextMealFood(item.name),grams=item.grams||defaultTextMealGrams(food,item.name);if(!food||!grams){unmatched.push(item.name);continue}resolved.push({...item,food,grams:Number(grams)*item.quantity});}
  if(unmatched.length)return {ok:false,error:`无法从本地营养库可靠估算：${unmatched.join('、')}；请补充克数、包装营养信息，或改用手动记录`};
  const calories=Math.round(resolved.reduce((sum,item)=>sum+(Number(item.food.kcal)||0)*item.grams/100,0)),protein=+(resolved.reduce((sum,item)=>sum+(Number(item.food.protein)||0)*item.grams/100,0)).toFixed(1);
  if(calories<=0)return {ok:false,error:'未能形成可靠热量估算，请补充食物份量或营养信息'};
  const name=resolved.map(item=>`${item.name} ${item.quantity}${item.unit}`).join('、'),basis=resolved.map(item=>`${item.name}按${item.grams/item.quantity}g/${item.unit}`).join('；');
  return {ok:true,name,calories,protein,source:`本地营养库文字估算（${basis}）`,items:resolved.map(item=>({name:item.name,matchedFood:item.food.name,grams:item.grams}))};
}
function explicitToolForMessage(message='',pendingMeal=null){
  const text=String(message||'');
  if(pendingMeal&&/改|修正|调整|补充/.test(text))return 'revise_pending_meal';
  if(isMealRecordRequest(text))return 'propose_meal_record';
  if(isNearbyRestaurantRequest(text))return 'search_nearby_restaurants';
  if(/用户状态工具/.test(text))return 'read_user_state';
  if(/(?:本餐|餐次)预算工具/.test(text))return 'get_meal_budget';
  if(/食谱生成工具/.test(text))return 'compose_diy_recipe';
  if(/营养查询工具/.test(text))return 'search_nutrition';
  if(/今日计划工具/.test(text))return 'get_daily_plan';
  if(/记忆工具/.test(text))return 'get_memory';
  return '';
}
function isNearbyRestaurantRequest(message=''){
  const text=String(message||'');
  return /附近|周边|周围/.test(text)&&/(?:吃|餐|饭|店|外卖)/.test(text);
}
function normalizeBrowserLocation(value=null){
  const latitude=Number(value?.latitude),longitude=Number(value?.longitude);
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude<-90||latitude>90||longitude<-180||longitude>180)return null;
  return {latitude,longitude};
}
function controlledToolArgs(tool,message,ctx){
  const text=String(message||''),foods=mentionedFoodNames(text),kcalMatches=[...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:kcal|千卡|卡路里|卡)/ig)].map(match=>Number(match[1])).filter(Number.isFinite),proteinMatch=text.match(/蛋白质(?:改为|约|为)?\s*(\d+(?:\.\d+)?)/),mealType=normalizeMealType(text.match(/早餐|午餐|晚餐|其他摄入/)?.[0])||ctx.mealType;
  if(tool==='get_meal_budget')return {mealType,dayOffset:ctx.dayOffset};
  if(tool==='compose_diy_recipe')return {ingredients:foods,pantry:[],cookTime:text.match(/(\d+\s*分钟)/)?.[1]||'20分钟',cookTools:/空气炸锅/.test(text)?'空气炸锅':'普通厨具',mealType};
  if(tool==='search_nutrition')return {name:foods[0]||text.match(/查询(?:一下)?(.{2,20}?)(?:每|的|热量|蛋白质)/)?.[1]?.trim()||''};
  if(tool==='search_nearby_restaurants')return {area:text.match(/(?:在|到)(.{2,30}?)(?:附近|周边)/)?.[1]?.trim()||'',cuisine:'',...(ctx.browserLocation||{})};
  if(tool==='get_restaurant_menu')return {restaurant:{name:text.match(/(?:餐厅|饭店|店)\s*([^，。；;]{1,30})/)?.[1]?.trim()||''}};
  if(tool==='personalize_restaurant')return {restaurant:{},menu:{},mealType};
  if(tool==='propose_meal_record'){
    const name=text.match(/(?:吃了|吃的)\s*([^，。；;]+)/)?.[1]?.replace(/约\s*\d+.*$/,'').trim()||foods[0]||'用户餐食';
    return {name,calories:kcalMatches.at(-1)||0,protein:Number(proteinMatch?.[1])||0,mealType,recordDate:shanghaiClock().date,source:'用户文字记录',originalMessage:text};
  }
  if(tool==='revise_pending_meal')return {revisedName:ctx.pendingMeal?.name||'',revisedCalories:kcalMatches.at(-1)||0,revisedProtein:Number(proteinMatch?.[1])||0,revisionNote:text.slice(0,300)};
  return {};
}
function executionArgsForLog(tool,args={}){
  if(tool!=='search_nearby_restaurants')return args;
  const {latitude,longitude,...safeArgs}=args||{};
  return Number.isFinite(Number(latitude))&&Number.isFinite(Number(longitude))?{...safeArgs,locationSource:'browser_authorized'}:safeArgs;
}
async function dispatchControlledTools(tools,message,ctx){
  const toolLog=[],results=[];let proposal=null;
  for(const tool of [...new Set((Array.isArray(tools)?tools:[]).filter(name=>AGENT_TOOLS.some(item=>item.function?.name===name)))]){
    const args=controlledToolArgs(tool,message,ctx);
    const out=await executeAgentTool(tool,args,ctx);
    logAgent(ctx.clientId,'agent_tool',`${out.tool}:${out.ok?'ok':'fail'}`);
    toolLog.push({tool:out.tool,ok:out.ok,summary:String(out.result?.error||out.result?.mealDisplay||out.result?.name||out.result?.action||out.result?.message||'').slice(0,100)});
    results.push({tool:out.tool,args,ok:out.ok,result:out.result||{}});
    if(out.ok&&out.tool==='propose_meal_record'&&out.result?.payload)proposal={kind:'meal',payload:out.result.payload};
    if(out.ok&&out.tool==='revise_pending_meal'&&out.result?.payload)proposal={kind:'revise',payload:out.result.payload};
  }
  return {toolLog,results,proposal};
}
async function planAgentTask(message,skillContext=[]){
  const contexts=Array.isArray(skillContext)?skillContext:[];
  const referenceCatalog=contexts.map(item=>{
    const files=Array.isArray(item.skill?.referenceFiles)?item.skill.referenceFiles.join('、'):'无';
    return `- ${item.skill?.name||'未命名技能'}：可选 references 路径为 ${files}`;
  }).join('\n');
  const d=await qwenChat({model:process.env.QWEN_CHAT_MODEL||process.env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:`你是规划器。把用户请求拆成最多6步执行计划，每步对应一个可用工具，不调用工具。硬约束：steps[].tool 必须严格来自可用工具列表，禁止编造工具名；请求不需要工具时 steps 返回空数组；fallback 是目标不可达时的简单替代方案；只有当前技能上下文确实需要某个 reference 时才写入 references，否则 references 返回空数组，路径必须严格来自下方列表。只返回JSON：{"goal":"一句话目标","steps":[{"tool":"工具名","why":"为什么做这步"}],"references":["references/xxx.md"],"fallback":"..."}。可用工具：${AGENT_TOOLS.map(t=>t.function.name).join('、')}\n${referenceCatalog?`当前技能上下文：\n${referenceCatalog}`:'当前没有命中技能，references 固定返回 []'}`},{role:'user',content:String(message||'')}]});
  const plan=parseJsonText(responseText(d));
  return sanitizePlanSteps(plan);
}
function sanitizePlanSteps(plan={},tools=AGENT_TOOLS){
  if(!plan||typeof plan!=='object')return {goal:'',steps:[],fallback:''};
  const known=new Set((Array.isArray(tools)?tools:[]).map(t=>String(t.function?.name||t.name||t)));
  const sanitized={...plan,goal:String(plan.goal||'').slice(0,100),fallback:String(plan.fallback||'').slice(0,200),steps:(Array.isArray(plan.steps)?plan.steps:[]).map(s=>({tool:String(s?.tool||'').trim(),why:String(s?.why||'').slice(0,120)})).filter(s=>known.has(s.tool)).slice(0,6)};
  if(Array.isArray(plan.skills)){
    const skillNames=new Set(scanSkills().map(skill=>String(skill.name).trim()).filter(Boolean));
    sanitized.skills=[...new Set(plan.skills.map(skill=>String(skill||'').trim()).filter(Boolean))].filter(name=>skillNames.has(name));
  }
  return sanitized;
}
const PROMPT_VERSION='v9';
const PROMPTS_VERSION='v3';
const SKILLS_ROOT=join(ROOT,'skills');
function parseSkillFrontmatter(text=''){
  const meta={name:'',description:'',intents:[]};
  const match=String(text).match(/^\uFEFF?---\s*\n([\s\S]*?)\n---\s*\n/);
  if(!match)return meta;
  let key='',fold=false;
  for(const raw of match[1].split('\n')){
    const line=raw.replace(/\r$/,'');
    if(fold){
      if(/^\s/.test(line)||line===''){meta[key]=(meta[key]?`${meta[key]}\n`:'')+line.trim();continue}
      fold=false;
    }
    const kv=line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if(!kv)continue;
    key=kv[1];const value=kv[2].trim();
    if(value==='>'||value==='|'){fold=true;meta[key]='';continue}
    if(key==='intents'){meta[key]=value.split(/[,，;；、\s]+/).map(x=>x.trim()).filter(Boolean)}
    else meta[key]=value;
  }
  return meta;
}
function scanSkills(){
  const skills=[];
  let entries=[];
  try{entries=readdirSync(SKILLS_ROOT,{withFileTypes:true})}catch{return skills}
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const dir=join(SKILLS_ROOT,entry.name),skillFile=join(dir,'SKILL.md');
    if(!existsSync(skillFile))continue;
    let raw='';try{raw=readFileSync(skillFile,'utf8')}catch{continue}
    const meta=parseSkillFrontmatter(raw);
    const name=String(meta.name||entry.name).trim();
    const referenceFiles=[];
    try{for(const file of readdirSync(join(dir,'references'))){if(file.endsWith('.md'))referenceFiles.push(`references/${file}`)}}catch{}
    referenceFiles.sort();
    skills.push({name,dir,meta:{name,description:meta.description,intents:meta.intents},referenceFiles});
  }
  return skills;
}
function loadSkillContent(skill,references){
  const selectedReferences=Array.isArray(references)?references:Array.from(skill.referenceFiles||[]);
  const parts=[],files=[];
  if(!Array.isArray(references)){
    try{parts.push(`【SKILL.md】\n${readFileSync(join(skill.dir,'SKILL.md'),'utf8').trim()}`);files.push('SKILL.md')}catch{}
  }
  for(const ref of selectedReferences){
    if(!String(ref||'').startsWith('references/'))continue;
    try{parts.push(`【${ref}】\n${readFileSync(join(skill.dir,ref),'utf8').trim()}`);files.push(ref)}catch{}
  }
  return {name:skill.name,text:parts.join('\n\n'),files};
}
function loadSkillCore(skill){
  let text='',files=[];
  try{text=readFileSync(join(skill.dir,'SKILL.md'),'utf8').trim();files.push('SKILL.md')}catch{}
  return {name:skill.name,text, files};
}
const SKILL_INDEX=scanSkills();
if(process.env.NODE_ENV!=='test')console.log(`技能扫描：发现 ${SKILL_INDEX.length} 个 Skill（${SKILL_INDEX.map(s=>s.name).join('、')||'无'}）`);
function normalizeRouterIntent(routerIntent='',message='',skills=[]){
  const text=String(message||'');
  const names=Array.isArray(skills)?skills.map(skill=>String(skill||'').trim()).filter(Boolean):[];
  const intent=String(routerIntent||'').trim();
  if(['meal','record','other'].includes(intent))return intent;
  if(names.includes('meal-recommendation'))return 'meal';
  if(/记录|入账|记上|记到|记成|记一笔|记一下|帮我记|补登|体重|称重/.test(text))return 'record';
  return 'other';
}
async function routeDescription(message=''){
  const text=String(message||'');
  const skillCatalog=SKILL_INDEX.map(skill=>`- ${skill.name}: ${skill.meta.description}`).join('\n');
  const d=await qwenChat({model:process.env.QWEN_CHAT_MODEL||process.env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:`你是技能路由裁判。

根据用户消息的完整语义和当前主要任务，判断是否命中已注册 Skill，并将一级意图归一为 meal / record / other。若 intent 为 meal，还必须判断本次下一餐的场景 mealScenario。

判断 Skill 时，以用户当前真正希望完成的任务为准，不要因为消息中出现某个局部关键词就触发 Skill。

特别注意：

* “涉及吃、饮食、怎么吃”不等于“下一餐推荐”。
* 疾病、慢病管理、治疗、药物或医疗健康相关的饮食咨询应归为 other，不触发 meal-recommendation。只要消息明确提到疾病或慢病名称、医生建议（医嘱）或用药背景（如糖尿病、高血压、痛风、胃炎、血糖高、吃药等），即使同时出现“中午吃什么”“外卖”“餐厅”等餐食表达，也一律按 other 处理；疾病状态下的下一餐选择不属于本技能范围。
* 只有当用户当前主要目标确实是决定具体下一餐吃什么时，才命中 meal-recommendation。
* mealScenario 只能使用以下枚举：diy（明确想在家做、给出食材/厨具或询问做法）、restaurants（明确外卖、餐厅、堂食、到店、附近/某地找吃的）、unknown（未说明在家做还是外食，或同时表达两种方式而无法判断优先项）。不要根据单个词猜测，应理解整句语义。
* intent 不是 meal 时，mealScenario 返回空字符串。
* 消息中包含历史背景、已经完成的动作或其他次要信息时，应识别当前主要请求，不要被背景词干扰。

命中多个 Skill 时可以全部返回；未命中时返回空数组。

可用技能：
${skillCatalog}

只返回严格 JSON，不要输出 Markdown 代码块或 JSON 以外的内容：
{"skills":["技能名"],"intent":"meal|record|other","mealScenario":"diy|restaurants|unknown|"}`},{role:'user',content:text}]});
  const parsed=parseJsonText(responseText(d));
  const skills=[...new Set((Array.isArray(parsed.skills)?parsed.skills:[]).map(skill=>String(skill||'').trim()).filter(name=>SKILL_INDEX.some(skill=>skill.name===name)))];
  const intent=normalizeRouterIntent(String(parsed.intent||''),text,skills);
  return {skills,intent,mealScenario:String(parsed.mealScenario||'').trim(),mode:'llm'};
}
function bucketIntent(intent=''){
  const value=String(intent||'').trim();
  if(['meal','diy','restaurant'].includes(value))return 'meal';
  if(['record','confirm_meal_record'].includes(value))return 'record';
  return 'other';
}
function checkIntentConflict(routeIntent,agentIntent){
  const route=bucketIntent(normalizeRouterIntent(routeIntent,'',[]));
  const agent=bucketIntent(agentIntent);
  return route!=='other'&&route!==agent;
}
const MEAL_SCENARIOS=new Set(['diy','restaurants','unknown']);
function isValidMealScenario(value=''){return MEAL_SCENARIOS.has(String(value||'').trim())}
function expectedMealAction(mealScenario=''){
  const scenario=String(mealScenario||'').trim();
  if(scenario==='diy')return 'open_diy';
  if(scenario==='restaurants')return 'open_restaurants';
  if(scenario==='unknown')return 'open_meal_choice';
  return '';
}
function routerActionFor(routeIntent='',mealScenario=''){
  return normalizeRouterIntent(routeIntent,'',[])==='meal'?expectedMealAction(mealScenario):'';
}
async function classifyMealScenario(message=''){
  const text=String(message||'').trim();
  const d=await qwenChat({model:process.env.QWEN_CHAT_MODEL||process.env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:`你是下一餐场景分类器。只判断用户是否已经明确下一餐方式，不要生成食谱、餐厅或建议。

只返回严格 JSON：{"mealScenario":"diy|restaurants|unknown"}。

判定规则：diy = 明确在家做、已有食材/厨具或询问做法；restaurants = 明确外卖、餐厅、堂食、到店、附近/某地找吃的；unknown = 要决定下一餐但未说明在家做还是外食，或明确在两种方式之间犹豫/意图冲突。必须理解完整语义，不能仅靠单个关键词。`},{role:'user',content:text}]});
  const parsed=parseJsonText(responseText(d));
  const scenario=String(parsed.mealScenario||'').trim();
  if(!isValidMealScenario(scenario))throw new Error('场景分类器返回了非法 mealScenario');
  return scenario;
}
function detectMealScenario(message = '') {
  const text = String(message || '').trim();

  // 1. 强 DIY：已经明确在做饭 / 请求做法
  const strongDiySignals = [
    /我.*自己.*(做|煮|炒|蒸|烤|炖|下厨)/,
    /我.*在家.*(做|煮|炒|蒸|烤|炖|吃)/,
    /自己在家.*(做|煮|炒|蒸|烤|炖)/,
    /(在家|自己).*(做|煮|炒|蒸|烤|炖|下厨)/,

    /(?:晚餐|午餐|早餐|晚饭|午饭|早饭).*做法/,
    /做法/,
    /菜谱/,
    /怎么(做|煮|炒|蒸|烤|炖)/,

    /冰箱里.*(做|搭|配|煮|炒)/,
    /冰箱的.*(做|搭|配|煮|炒)/,
    /把.*做成一顿/,
    /做成一顿饭/,

    /(电饭煲|空气炸锅|烤箱|微波炉).*(做什么|怎么做|做|煮|烤)/,
    /(做什么|怎么做).*(电饭煲|空气炸锅|烤箱|微波炉)/,

    /煮面/,
    /炒个/,
    /做个/,
  ];

  // 2. 强外食：用户明确要去外面 / 找店 / 点外卖
  const strongRestaurantSignals = [
    /我.*(出去吃|出去解决|在外面吃|在外面解决)/,
    /我.*(点|叫).*外卖/,
    /想.*(点|叫).*外卖/,
    /在外面(吃|解决)/,
    /出去吃/,
    /出去解决/,
    /附近.*(餐厅|饭店|吃的|吃饭)/,
    /找.*(餐厅|饭店)/,
    /堂食/,
    /到店/,
  ];

  const strongDiy = strongDiySignals.some(re => re.test(text));
  const strongRestaurant = strongRestaurantSignals.some(re => re.test(text));

  // 强信号优先。
  if (strongDiy && !strongRestaurant) return 'diy';
  if (strongRestaurant && !strongDiy) return 'restaurants';

  // 同时有两类强信号时归为 unknown，由前端先让用户选择方式。
  if (strongDiy && strongRestaurant) return 'unknown';


  // 3. 弱 DIY：能说明环境，但不能无条件压过强外食意图
  const weakDiySignals = [
    /家里有/,
    /冰箱里/,
    /冰箱的/,
    /剩下.*(菜|饭|食材)/,
    /电饭煲/,
    /空气炸锅/,
    /烤箱/,
    /微波炉/,
    /家常(饭|午饭|晚饭|菜)/,
  ];

  // 4. 弱外食：出现这些词，不一定表示用户自己要这么做
  const weakRestaurantSignals = [
    /餐厅/,
    /饭店/,
    /外卖/,
    /外食/,
  ];

  const weakDiy = weakDiySignals.some(re => re.test(text));
  const weakRestaurant = weakRestaurantSignals.some(re => re.test(text));

  if (weakDiy && !weakRestaurant) return 'diy';
  if (weakRestaurant && !weakDiy) return 'restaurants';

  if (weakDiy && weakRestaurant) return 'unknown';

  return 'unknown';
}
function hasScenarioSignal(message=''){
  const scenario=detectMealScenario(message);
  return scenario==='diy'||scenario==='restaurants';
}
async function resolveMealScenario(route={},message=''){
  const intent=normalizeRouterIntent(route.intent,message,route.skills);
  if(intent!=='meal')return {mealScenario:'',source:'not_meal'};
  const routerScenario=String(route.mealScenario||'').trim();
  if(isValidMealScenario(routerScenario))return {mealScenario:routerScenario,source:'router_llm'};
  try{return {mealScenario:await classifyMealScenario(message),source:'scene_llm'}}catch(error){
    console.warn(`meal scenario LLM fallback: ${error.message}`);
    return {mealScenario:detectMealScenario(message),source:'regex_fallback'};
  }
}
function selectActionType(routerAction='',agentAction={}){
  if(routerAction)return routerAction;
  const type=String(agentAction?.type||'none');
  return new Set(['none','open_meal_choice','open_diy','open_restaurants','open_manual_log']).has(type)?type:'none';
}
function selectSkillReferences(plan={},context=[]){
  const hasPlan=plan&&typeof plan==='object';
  const requested=hasPlan&&Array.isArray(plan.references)?plan.references:[];
  return (Array.isArray(context)?context:[]).map(item=>{
    const skill=item.skill,core=item.core||loadSkillCore(skill);
    const allowed=Array.from(skill.referenceFiles||[]);
    const references=hasPlan?[...new Set(requested.map(ref=>String(ref||'').trim()).filter(ref=>allowed.includes(ref)))]:[...allowed];
    return {skill,core,references,content:loadSkillContent(skill,references)};
  });
}
function buildSkillCorrection(routeIntent,agentIntent,appliedSkillNames=[],baseSystem='BASE'){
  const route=normalizeRouterIntent(routeIntent,'',[]);
  const agent=bucketIntent(agentIntent);
  if(route==='other'&&agent==='meal'&&!(Array.isArray(appliedSkillNames)?appliedSkillNames:[]).includes('meal-recommendation')){
    const skill=SKILL_INDEX.find(item=>item.name==='meal-recommendation');
    if(skill){
      const core=loadSkillCore(skill);
      return {system:`${baseSystem}\n\n【运行时技能】\n【技能：${skill.name}】\n${core.text}`,note:'纠错：本轮路由未命中餐食技能，但你的执行意图是 meal；已补充 meal-recommendation 技能规则，请重新按技能输出。'};
    }
  }
  if(route!=='other'&&agent!=='other'&&route!==agent){
    return {system:baseSystem,note:`纠错：路由意图为 ${route}，但你返回的执行意图为 ${agent}；请优先遵循路由意图 ${route} 重新组织输出。`};
  }
  return {system:baseSystem,note:''};
}
const SYSTEM_BASE=`你是“小饭”，一名帮助用户进行饮食管理和减脂规划的 AI 营养助手。

你的表达应专业、友好、具体、可执行，不居高临下，不制造饮食焦虑，不做不科学的承诺。理解用户真实生活中的外卖、聚餐、加班、嘴馋和没有时间做饭等情况；用户执行得好时可以给予适度肯定，出现波动时优先解释原因和提供下一步建议，而不是责备用户。

你具备 Tool 能力，可以读取用户状态、查询营养、计算预算、生成食谱、查询餐厅与菜单、读取记忆以及生成待确认操作。是否进入专项 Skill 由运行时路由决定；没有命中 Skill 时，仍按照本 System、当前上下文和可用 Tool 完成用户请求。

【事实与数据】

1. 以当前用户明确提供的信息、系统状态和 Tool 返回结果作为回答依据，不得虚构用户记录、营养数据、餐厅、菜单、位置、Tool 调用结果或其他系统状态。

2. Tool 或确定性程序已经返回的预算、营养、BMI、趋势、记录状态等结果，不得自行重新计算、修改或为了让答案更合理而改写。

3. Chat History 和 Memory 只能作为上下文参考，不能因为历史回答中曾出现某个数字或结论，就把它视为当前真实系统状态。涉及今日摄入、已记录餐食、待确认内容等状态时，以当前系统上下文或 Tool 返回结果为准。

4. 查不到可靠事实时应明确说明信息不足，并根据当前可用能力进行合理降级或询问必要信息，不得用模型记忆补造精确事实。

5. 热量、蛋白质等面向用户的估算数值只返回单一数值，不输出区间；估算时应说明主要误差来源，不要把估算表达成精确事实。

【安全】

6. 疾病、药物和治疗相关问题不提供诊断、药物调整或治疗方案，应说明能力边界并建议咨询专业医生。

7. 当系统或 Tool 返回 targets.safety 等明确风险提示时，必须如实向用户表达，不得隐藏、弱化或自行修改其中的风险结论。

【状态变更与写入】

8. 不得仅通过文字声称已经完成需要确认或授权的状态变更。是否真正完成，以对应 Tool / 系统状态为准。

9. 饮食记录的确认流程为：
用户提出记录意图
→ 调用 propose_meal_record 生成待确认提案
→ 用户确认后才可视为正式记录。

propose_meal_record 只生成待确认提案，不代表已经写入。未确认前不得声称已写入；没有得到确认结果时，不得说“已经记录”“已经入账”或把该餐视为已确认记录。

10. 当存在 pendingMeal，且用户补充了会改变原估算的信息，例如食材、份量、用油或漏识别食物时，应优先使用 revise_pending_meal 修正当前待确认估算，不要绕过修正流程直接把旧结果当作最终记录。

11. 涉及写入、授权、定位或其他需要用户确认的动作时，只执行当前 Tool 和产品能力允许的步骤，不得假装获得用户尚未提供的授权。

【Tool 使用】

12. 需要 Tool 才能可靠完成的任务，应实际调用 Tool；不能只在回答中描述“我会查询”“我会记录”“我已经计算”。

13. 调用 Tool 后，以 Tool 的实际返回结果继续判断和回答。Tool 失败时，不得假装成功；优先根据失败原因更换有效路径、进行合理降级，或询问完成任务所必需的信息。

14. 不要用相同参数无意义地重复调用同一 Tool。只有输入信息、查询条件或任务目标发生有效变化后，才重新调用。

15. 已经存在于当前上下文、系统状态或 Tool 结果中的信息，不要无必要地再次询问用户。只有缺少的信息会阻塞当前任务或明显影响结果时，才进行追问。

16. Runtime Skill 只约束其对应专项任务。命中 Skill 时遵循该 Skill 及其按需加载的 Reference；未命中 Skill 时，不自行假设某个 Skill 已激活，只依据本 System、当前上下文和 Tool 契约完成任务。

【输出】

最终只返回严格 JSON，不要输出 Markdown 代码块或 JSON 以外的文字：

{
  "answer":"面向用户的中文回答",
  "intent":"meal|diy|restaurant|record|confirm_meal_record|general",
  "action":{
    "type":"none|open_meal_choice|open_diy|open_restaurants|open_manual_log",
    "cuisine":"",
    "mealType":"",
    "recordDate":"",
    "portionRatio":1,
    "radiusMeters":3000,
    "requestedCount":5,
    "area":""
  },
  "planSummary":"仅当本轮实际调用过 Tool 时填写一句简短说明，否则为空字符串"
}

没有前端动作时 action.type 返回 "none"。
当运行时上下文注明 Router 已确定餐食入口时，入口由 Router 直接返回给前端；你不得决定或改变该入口，action.type 必须返回 "none"。你仍可填写 cuisine、mealType、area 等字段作为入口的可选参数。`;
function buildAgentContext(ctx,extra={}){
  const profile=ctx.profile||{},truncate=(value,n=200)=>String(value||'').slice(0,n);
  return JSON.stringify({
    longTermMemory:{activity:profile.activity,mealMode:profile.mealMode,habit:truncate(profile.habit),tastePreference:profile.tastePreference,preferences:truncate(profile.preferences),dislikedFoods:truncate(profile.dislikedFoods),allergies:truncate(profile.allergies)},
    profile:{name:profile.name,age:profile.age,sex:profile.sex,height:profile.height,weight:profile.weight,targetWeight:profile.targetWeight,targetDate:profile.targetDate,budgetAdjustmentKcal:Number(profile.budgetAdjustmentKcal)||0},
    targets:ctx.targets||{},
    today:ctx.today||{},
    pendingMeal:ctx.pendingMeal||null,
    memory:{recent:(Array.isArray(extra.memory)?extra.memory:[]).slice(0,10),hits:extra.memoryHits||[]},
    recentConfirmed:ctx.recentConfirmed||[]
  });
}
async function runAgentRound({message,history,system,ctx,correctionNote='',traceSeed=[],proposalSeed=null}){
  const PROPOSE_KINDS={propose_meal_record:'meal',revise_pending_meal:'revise'};
  const messages=[{role:'system',content:system},...history,{role:'user',content:message}];
  if(correctionNote)messages.push({role:'system',content:correctionNote});
  const trace=[...traceSeed];
  const toolLog=[];
  let proposal=proposalSeed,result=null,rounds=0;
  const writeIntent=isMealRecordRequest(message);
  while(rounds<AGENT_CONFIG.maxToolRounds+2){
    rounds++;
    const d=await qwenChat({model:process.env.QWEN_CHAT_MODEL||process.env.QWEN_WEB_MODEL||'qwen-plus',messages,tools:AGENT_TOOLS,tool_choice:'auto',response_format:{type:'json_object'}});
    const msg=d.choices?.[0]?.message||{};
    const calls=Array.isArray(msg.tool_calls)?msg.tool_calls:[];
    if(!calls.length){
      const text=responseText(d);
      let parsed=null;
      if(text){try{parsed=parseJsonText(text)}catch(_){const s=text.indexOf('{'),e=text.lastIndexOf('}');if(s>=0&&e>s){try{parsed=JSON.parse(text.slice(s,e+1))}catch(_){}}}}
      if(!parsed&&rounds<AGENT_CONFIG.maxToolRounds+2){
        messages.push({role:'system',content:'你上次的回复不是严格 JSON（或内容为空），无法解析。请只返回一个 JSON 对象：不要 markdown 代码块、不要“好的/好的呀”等开场白、不要任何 JSON 以外的文字，字段严格按输出契约。'});
        trace.push('retry:invalid_json');
        continue;
      }
      if(!parsed)throw Object.assign(new Error('模型连续多次未返回合法 JSON，请稍后重试'),{status:502});
      if(writeIntent&&!proposal&&rounds<AGENT_CONFIG.maxToolRounds+2){
        messages.push({role:'system',content:'你刚才没有调用任何写库提案工具。饮食记录的唯一路径是调用 propose_meal_record / revise_pending_meal 生成确认提案；请先调用对应工具，再基于工具回传结果输出最终 JSON。不要用文字代替提案。'});
        trace.push('retry:force_proposal');
        continue;
      }
      result=parsed;break;
    }
    for(const call of calls){
      let args={};try{args=JSON.parse(call.function?.arguments||'{}')}catch{}
      const out=await executeAgentTool(call.function?.name||'',args,ctx);
      if(out.ok&&PROPOSE_KINDS[out.tool]&&out.result?.payload)proposal={kind:PROPOSE_KINDS[out.tool],payload:out.result.payload};
      logAgent(ctx.clientId,'agent_tool',`${out.tool}:${out.ok?'ok':'fail'}`);
      toolLog.push({tool:out.tool,ok:out.ok,summary:String(out.result?.error||out.result?.mealDisplay||out.result?.name||out.result?.action||out.result?.message||'').slice(0,100)});
      trace.push(out.ok?`tool:${out.tool}`:`tool:${out.tool}(失败)`);
      messages.push({role:'assistant',content:null,tool_calls:[call]});
      messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(out.result||{})});
      if(!out.ok&&call.function?.name==='propose_meal_record'){
        result=mealRecordFailureResult(out.result?.error,ctx);
        trace.push('record_proposal_blocked');
        break;
      }
      if(!out.ok&&call.function?.name==='search_nearby_restaurants'&&/缺少|位置|区域|高德/.test(out.result?.error||'')){
        result={
          answer:'我还没有拿到你的位置或区域。请告诉我常点外卖的区域（例如：北京朝阳区国贸、上海静安寺、广州天河体育中心等），或点下方“附近餐厅”手动输入城市/商圈后搜索。',
          intent:'restaurant',
          action:{type:'open_restaurants',area:'',cuisine:'',mealType:ctx.mealType,recordDate:'',portionRatio:1,radiusMeters:3000,requestedCount:5},
          planSummary:''
        };
        break;
      }
    }
    if(result)break;
  }
  if(!result)throw new Error('Agent未能在限定轮次内完成任务');
  return {result,proposal,toolLog,trace};
}
function mealRecordFailureResult(error='',ctx={}){
  const reason=String(error||'无法形成可靠的营养估算').slice(0,300);
  return {
    answer:`这餐尚未记录。原因：${reason}。请通过“记录一餐”手动补充每项食物的克数、包装营养信息或你确认的总热量后再保存。`,
    intent:'meal_record',
    action:{type:'open_manual_log',mealType:normalizeMealType(ctx.mealType)||'其他摄入',recordDate:shanghaiClock().date,portionRatio:1,radiusMeters:3000,requestedCount:5,area:'',cuisine:''},
    planSummary:''
  };
}
async function agentLoop(input){
  const message=String(input.message||'').trim();
  const profile=input.profile||{};
  const meals=Array.isArray(input.todayMeals)?input.todayMeals.slice(-30):[];
  const history=(Array.isArray(input.history)?input.history:[]).slice(-24).map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'').slice(0,2000)}));
  const rawPending=input.pendingMeal&&typeof input.pendingMeal==='object'?input.pendingMeal:null;
  const pendingMeal=rawPending&&Number.isFinite(Number(rawPending.calories))?{id:String(rawPending.id||''),name:String(rawPending.name||'图片识别餐食').slice(0,100),calories:Math.max(0,Number(rawPending.calories)),protein:Math.max(0,Number(rawPending.protein)||0),breakdown:String(rawPending.breakdown||'').slice(0,1200),followUpQuestion:String(rawPending.followUpQuestion||'').slice(0,500),suggestedMealType:normalizeMealType(rawPending.suggestedMealType),recordDate:String(rawPending.recordDate||shanghaiClock().date),createdAt:String(rawPending.createdAt||'')}:null;
  const mealType=inferMealType(message,input.mealType);
  const dayOffset=/明天|明日|明早|明晚/.test(message)?1:0;
  const budgetMeals=dayOffset?[]:meals;
  const today={calories:budgetMeals.reduce((s,x)=>s+(Number(x.calories)||0),0),protein:budgetMeals.reduce((s,x)=>s+(Number(x.protein)||0),0),meals:budgetMeals.map(x=>({type:x.type,name:x.name,calories:x.calories,protein:x.protein,status:x.status||'eaten'}))};
  const targets=mealTargets(profile,today,mealType);
  const ctx={clientId:String(input.clientId||''),message,profile,today,mealType,dayOffset,cuisine:'',browserLocation:normalizeBrowserLocation(input.location),targets,pendingMeal,consumed:{calories:today.calories,protein:today.protein},recentConfirmed:recentConfirmedNames(input.clientId,10)};
  const executionGoal=beginExecutionGoal(ctx.clientId,profile,message,AGENT_CONFIG.maxToolRounds);
  const memory=memorySummaries(ctx.clientId,7);
  const memorySearch=searchMemory(ctx.clientId,message,5).catch(e=>{console.warn(`memory search failed: ${e.message}`);return []});
  const routeSearch=routeDescription(message).catch(e=>{console.warn(`agent route failed: ${e.message}`);return null});
  logAgent(ctx.clientId,'agent_chat_start',message.slice(0,200));
  const [memoryHits,routeResult]=await Promise.all([memorySearch,routeSearch]);
  let route=routeResult;
  route=route||{skills:[],intent:'other',mealScenario:'',mode:'fallback'};
  const routeSkills=(Array.isArray(route.skills)?route.skills:[]).filter(name=>SKILL_INDEX.some(skill=>skill.name===name));
  const routeIntent=normalizeRouterIntent(route.intent,message,routeSkills);
  const routeMode=route.mode||'fallback';
  const scenarioSearch=resolveMealScenario({...route,intent:routeIntent,skills:routeSkills},message);
  const skillContext=[];
  for(const name of routeSkills){
    const skill=SKILL_INDEX.find(item=>item.name===name);if(!skill)continue;
    const core=loadSkillCore(skill);
    if(core.files.length)skillContext.push({skill,core});
  }
  const planSearch=planAgentTask(message,skillContext).catch(e=>{console.warn(`agent plan failed: ${e.message}`);return null});
  const [scenarioResolution,plan]=await Promise.all([scenarioSearch,planSearch]);
  const mealScenario=scenarioResolution.mealScenario;
  const routerAction=routerActionFor(routeIntent,mealScenario);
  const plannedTools=(Array.isArray(plan?.steps)?plan.steps:[]).map(step=>String(step.tool||'').trim()).filter(name=>AGENT_TOOLS.some(tool=>tool.function?.name===name));
  const explicitTool=explicitToolForMessage(message,pendingMeal);
  const requiredTools=explicitTool?[explicitTool]:[...new Set(plannedTools)];
  const trace=['route:'+routeIntent+','+routeMode,mealScenario?`meal_scenario:${mealScenario}`:'meal_scenario:none',`meal_scenario_source:${scenarioResolution.source}`,routerAction?`router_action:${routerAction}`:'router_action:none','agent_plan',plan&&Array.isArray(plan.steps)?`plan:${plan.steps.length}步`:'plan:fallback',requiredTools.length?`controlled_tools:${requiredTools.join(',')}`:'controlled_tools:none'];
  const appliedSkills=[];
  for(const item of skillContext){
    const {skill,core}=item;
    const selected=selectSkillReferences(plan,[item])[0];
    if(!core.files.length&&!selected.content.files.length)continue;
    appliedSkills.push(selected);
    const parts=core.files.length+selected.content.files.length;
    logAgent(ctx.clientId,'agent_skill',`${skill.name}:ok(${parts}份)`);
    trace.push(`skill:${skill.name}(${parts}份,${routeMode})`);
  }
  const skillText=appliedSkills.map(item=>`【技能：${item.skill.name}】\n${item.core.text}${item.content.text?`\n\n${item.content.text}`:''}`).join('\n\n').slice(0,24000);
  const baseWithSkill=`${SYSTEM_BASE}${skillText?`\n\n【运行时技能】\n${skillText}`:''}`;
  const routingContext=routerAction?`\n\n【餐食入口】\nRouter 已识别场景 ${mealScenario}，将直接为前端展示 ${routerAction}。请只围绕该场景生成建议与调用 Tool；不要决定前端入口，最终 action.type 返回 "none"。`:'';
  let dispatched=await dispatchControlledTools(requiredTools,message,ctx);
  let stepNo=0;
  for(const entry of dispatched.results)recordExecutionStep(executionGoal,++stepNo,entry.tool,executionArgsForLog(entry.tool,entry.args),{tool:entry.tool,ok:entry.ok,result:entry.result},'返回可用于推进目标的结构化结果');
  let replanAttempted=false;
  const failedDispatch=dispatched.results.find(entry=>!entry.ok);
  if(failedDispatch&&!explicitTool&&stepNo<AGENT_CONFIG.maxToolRounds){
    replanAttempted=true;
    const observation=`已执行 ${failedDispatch.tool}，但失败：${String(failedDispatch.result?.error||'未知错误')}。请基于该结果只规划一个可行替代 Tool；不要重复失败 Tool。`;
    try{
      const recoveryPlan=await planAgentTask(`${message}\n\n执行反馈：${observation}`,skillContext);
      const recoveryTool=(Array.isArray(recoveryPlan?.steps)?recoveryPlan.steps:[]).map(step=>String(step.tool||'')).find(tool=>tool&&tool!==failedDispatch.tool&&AGENT_TOOLS.some(item=>item.function?.name===tool));
      if(recoveryTool){
        const recovery=await dispatchControlledTools([recoveryTool],message,ctx);
        dispatched={toolLog:[...dispatched.toolLog,...recovery.toolLog],results:[...dispatched.results,...recovery.results],proposal:recovery.proposal||dispatched.proposal};
        for(const entry of recovery.results)recordExecutionStep(executionGoal,++stepNo,entry.tool,executionArgsForLog(entry.tool,entry.args),{tool:entry.tool,ok:entry.ok,result:entry.result},'替代步骤应解除上一工具失败造成的阻塞');
      }
    }catch(error){logAgent(ctx.clientId,'agent_goal_replan_failed',error.message)}
  }
  for(const entry of dispatched.toolLog)trace.push(entry.ok?`controlled_tool:${entry.tool}`:`controlled_tool:${entry.tool}(失败)`);
  if(replanAttempted)trace.push('goal_replan');
  const dispatchResults=JSON.stringify(dispatched.results.map(entry=>({tool:entry.tool,ok:entry.ok,result:entry.result}))).slice(0,6000);
  const dispatchContext=requiredTools.length?`\n\n【受控 Tool 调度】系统已按规划或明确意图执行 Tool：${requiredTools.join(' → ')}。必须基于下列真实执行结果回答；不得声称未执行或重复编造结果。\n${dispatchResults}`:'';
  const systemBase=`${baseWithSkill}${routingContext}${dispatchContext}`;
  const contextText=buildAgentContext(ctx,{memory,memoryHits});
  let system=`${systemBase}\n上下文：${contextText}`;
  const explicitRecordFailure=explicitTool==='propose_meal_record'?dispatched.results.find(entry=>entry.tool==='propose_meal_record'&&!entry.ok):null;
  let outcome=explicitRecordFailure
    ?{result:mealRecordFailureResult(explicitRecordFailure.result?.error,ctx),proposal:dispatched.proposal||null,toolLog:[],trace:[...trace,'record_proposal_blocked']}
    :await runAgentRound({message,history,system,ctx,traceSeed:trace,proposalSeed:dispatched.proposal});
  const toolLog=[...dispatched.toolLog,...outcome.toolLog];
  let result=outcome.result,proposal=outcome.proposal||dispatched.proposal;
  const recordProposalFailure=toolLog.find(entry=>entry.tool==='propose_meal_record'&&!entry.ok);
  const recordProposalBlocked=isMealRecordRequest(message)&&!proposal&&!!recordProposalFailure;
  if(recordProposalBlocked){
    result=mealRecordFailureResult(recordProposalFailure.summary,ctx);
    trace.push('record_proposal_blocked');
  }
  let agentIntent=bucketIntent(result?.intent);
  let correctionAttempted=false;
  const routeMissedMeal=routeIntent==='other'&&agentIntent==='meal';
  const intentConflict=checkIntentConflict(routeIntent,agentIntent);
  if(!recordProposalBlocked&&(routeMissedMeal||intentConflict)){
    const correction=buildSkillCorrection(routeIntent,agentIntent,appliedSkills.map(item=>item.skill.name),systemBase);
    if(correction.note){
      correctionAttempted=true;
      trace.push(`correction:${routeMissedMeal?'route_missed':'intent_conflict'}`);
      system=`${correction.system||systemBase}\n上下文：${contextText}`;
      outcome=await runAgentRound({message,history,system,ctx,correctionNote:correction.note,traceSeed:trace,proposalSeed:proposal});
      toolLog.push(...outcome.toolLog);
      result=outcome.result;proposal=outcome.proposal||proposal;
      agentIntent=bucketIntent(result?.intent);
    }
  }
  const agentActionType=selectActionType('',result.action);
  const actionType=selectActionType(routerAction,result.action);
  const failedTools=dispatched.results.filter(entry=>!entry.ok);
  const executionState=proposal?'awaiting_user':failedTools.length?'blocked':'completed';
  const goal=finishExecutionGoal(executionGoal,executionState,proposal?'已生成待用户确认的提案':failedTools.length?String(failedTools.at(-1).result?.error||'Tool 执行失败'):'目标已完成当前可验证步骤');
  const planTrace=plan&&Array.isArray(plan.steps)?plan.steps.map(s=>`plan:${s.tool}`):[];
  logAgent(input.clientId,'agent_chat_done',planTrace.concat(outcome.trace).join('|').slice(0,1500));
  return {answer:String(result.answer||'我暂时无法组织回答，请换一种方式提问。'),intent:String(result.intent||'general'),action:{type:actionType,cuisine:String(result.action?.cuisine||''),mealType:normalizeMealType(result.action?.mealType)||mealType,recordDate:/^\d{4}-\d{2}-\d{2}$/.test(String(result.action?.recordDate||''))?String(result.action.recordDate):pendingMeal?.recordDate||shanghaiClock().date,portionRatio:Math.min(2,Math.max(.05,Number(result.action?.portionRatio)||1)),dayOffset,radiusMeters:Math.min(5000,Math.max(100,Number(result.action?.radiusMeters)||3000)),requestedCount:Math.min(20,Math.max(1,Number(result.action?.requestedCount)||5)),area:String(result.action?.area||'').slice(0,100)},proposal,goal,routing:{intent:routeIntent,mealScenario:mealScenario||null,scenarioSource:scenarioResolution.source,routerAction:routerAction||null,agentAction:agentActionType,actionSource:routerAction?'router':'agent',correctionAttempted},toolLog,trace:[...planTrace,...outcome.trace,proposal?`proposal:${proposal.kind}`:'', 'qwen_agent_loop'].filter(Boolean)};
}
async function agentChat(input){
  if(!process.env.DASHSCOPE_API_KEY)throw Object.assign(new Error('Agent 服务未配置：缺少 DASHSCOPE_API_KEY，无法进行对话'),{status:503});
  return agentLoop(input);
}
// ==================== 完整 Agent：目标追踪 / SSE 主动通道 / 语义记忆 / 反思复盘 / 工程化 ====================
const AGENT_CONFIG={
  maxToolRounds:Math.max(3,Math.min(12,Number(process.env.AGENT_MAX_TOOL_ROUNDS)||6)),
  chatRateLimit:Math.max(1,Number(process.env.AGENT_CHAT_RATE_LIMIT)||10),
  embedModel:process.env.QWEN_EMBED_MODEL||'text-embedding-v3',
  sseHeartbeatMs:25000
};
function syncGoal(userId,profile){
  const target=Number(profile.targetWeight),deadline=String(profile.targetDate||''),start=Number(profile.startWeight)||Number(profile.weight)||target;
  if(!target||!deadline)return;
  const now=new Date().toISOString();
  const existing=db.prepare("SELECT id FROM goals WHERE user_id=? AND kind='weight_loss'").get(userId);
  if(existing)db.prepare('UPDATE goals SET start_value=?,target_value=?,deadline=?,updated_at=? WHERE id=?').run(start,target,deadline,now,existing.id);
  else db.prepare('INSERT INTO goals(user_id,kind,start_value,current_value,target_value,deadline,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(userId,'weight_loss',start,start,target,deadline,'active',now,now);
}
function goalState(clientId){
  const row=userRow(clientId);if(!row)return null;
  const goal=db.prepare("SELECT * FROM goals WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(row.id);if(!goal)return null;
  const weights=db.prepare('SELECT date,weight FROM weight_logs WHERE user_id=? ORDER BY date').all(row.id);
  const trend=weightTrend(weights);
  const current=trend.enough?trend.avg7:(weights.length?weights.at(-1).weight:Number(goal.start_value)||0);
  const deadline=String(goal.deadline||'');
  const daysLeft=deadline?Math.max(1,Math.ceil((new Date(`${deadline}T12:00:00`)-new Date())/86400000)):1;
  const totalLoss=Number(goal.start_value)-Number(goal.target_value);
  const requiredWeekly=totalLoss>0?totalLoss*7/daysLeft:0;
  const actualWeekly=trend.enough?trend.deltaWeek:null;
  let pace='unknown';
  if(actualWeekly!=null){if(actualWeekly<0&&Math.abs(actualWeekly)>=requiredWeekly*0.9)pace='on';else if(actualWeekly<0)pace='behind';else pace='stalling';}
  const pct=totalLoss>0?Math.max(0,Math.min(1,(Number(goal.start_value)-current)/totalLoss))*100:0;
  return {goalId:goal.id,kind:goal.kind,startValue:Number(goal.start_value),current:+current.toFixed(2),targetValue:Number(goal.target_value),deadline,daysLeft,requiredWeekly:+requiredWeekly.toFixed(2),actualWeekly:actualWeekly==null?null:+actualWeekly.toFixed(2),pct:Math.round(pct),pace,latestWeight:weights.length?Number(weights.at(-1).weight):null};
}
const sseClients=new Map();
function sseSend(clientId,data){
  const set=sseClients.get(String(clientId||''));if(!set||!set.size)return;
  const payload=`event: agent\ndata: ${JSON.stringify(data)}\n\n`;
  for(const res of set){try{res.write(payload)}catch{}}
}
function sseConnect(req,res,clientId){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.write('retry: 15000\n\n');
  if(!sseClients.has(clientId))sseClients.set(clientId,new Set());
  sseClients.get(clientId).add(res);
  const heartbeat=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},AGENT_CONFIG.sseHeartbeatMs);
  const tasks=pendingTasks(clientId,shanghaiClock().date);
  if(tasks.length)sseSend(clientId,{type:'tasks',tasks});
  req.on('close',()=>{clearInterval(heartbeat);const set=sseClients.get(clientId);if(set){set.delete(res);if(!set.size)sseClients.delete(clientId)}});
}
async function embedText(text){
  const key=process.env.DASHSCOPE_API_KEY;if(!key)return null;
  const base=(process.env.QWEN_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/,'');
  try{const r=await fetch(`${base}/embeddings`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:AGENT_CONFIG.embedModel,input:String(text||'').slice(0,1200)})});if(!r.ok)return null;const d=await r.json();return Array.isArray(d.data)&&d.data[0]?.embedding?d.data[0].embedding:null;}catch(e){return null}
}
function cosineSimilarity(a,b){
  if(!Array.isArray(a)||!Array.isArray(b)||!a.length||a.length!==b.length)return 0;
  let dot=0,na=0,nb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]}
  return na&&nb?dot/(Math.sqrt(na)*Math.sqrt(nb)):0;
}
async function embedPendingMemories(clientId){
  const row=userRow(clientId);if(!row)return;
  const unembedded=db.prepare('SELECT m.id,m.kind,m.date,m.payload FROM agent_memory m LEFT JOIN memory_embeddings e ON e.memory_id=m.id WHERE m.user_id=? AND e.id IS NULL ORDER BY m.id DESC LIMIT 20').all(row.id);
  for(const m of unembedded){
    let payload={};try{payload=JSON.parse(m.payload||'{}')}catch{}
    const vec=await embedText(`${m.kind} ${m.date} ${JSON.stringify(payload)}`);if(!vec)continue;
    db.prepare('INSERT INTO memory_embeddings(memory_id,embedding) VALUES(?,?)').run(m.id,JSON.stringify(vec));
  }
}
async function searchMemory(clientId,query,topK=5){
  const row=userRow(clientId);if(!row)return [];
  const qvec=await embedText(query);if(!qvec)return [];
  const rows=db.prepare('SELECT e.embedding,m.kind,m.date,m.payload FROM memory_embeddings e JOIN agent_memory m ON m.id=e.memory_id WHERE m.user_id=?').all(row.id);
  const scored=[];
  for(const r of rows){let v=[];try{v=JSON.parse(r.embedding||'[]')}catch{}const s=cosineSimilarity(qvec,v);if(s>0.30)scored.push({score:+s.toFixed(3),kind:r.kind,date:r.date,payload:JSON.parse(r.payload||'{}')});}
  return scored.sort((a,b)=>b.score-a.score).slice(0,topK);
}
function logAgent(clientId,kind,detail){
  try{db.prepare('INSERT INTO agent_logs(client_id,kind,detail,created_at) VALUES(?,?,?,?)').run(String(clientId||'').slice(0,100),String(kind||'').slice(0,40),String(detail||'').slice(0,2000),new Date().toISOString())}catch{}
}
function ensureAgentUser(clientId,profile={}){
  const id=String(clientId||'').trim();if(!id)return null;
  let row=userRow(id);if(row)return row;
  const now=new Date().toISOString();
  db.prepare('INSERT INTO users(client_id,profile,chat_history,pending_meal,budget_adjustment_kcal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,JSON.stringify(profile||{}),'[]','null',0,now,now);
  return userRow(id);
}
function beginExecutionGoal(clientId,profile,objective,maxSteps=6){
  const row=ensureAgentUser(clientId,profile);if(!row)return null;
  const now=new Date().toISOString(),criteria='目标回复或关键 Tool 步骤满足预期；写入类操作须等待用户确认。';
  const info=db.prepare('INSERT INTO agent_goals(user_id,client_id,objective,success_criteria,state,current_step,max_steps,last_observation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.id,String(clientId).slice(0,100),String(objective||'').slice(0,500),criteria,'running',0,Math.max(1,Math.min(12,Number(maxSteps)||6)),'',now,now);
  return {id:Number(info.lastInsertRowid),state:'running',currentStep:0,maxSteps:Math.max(1,Math.min(12,Number(maxSteps)||6)),objective:String(objective||'')};
}
function recordExecutionStep(goal,stepNo,tool,args,out,expectedObservation=''){
  if(!goal?.id)return;
  const now=new Date().toISOString(),state=out.ok?'succeeded':'failed',result=JSON.stringify(out.result||{}).slice(0,12_000);
  db.prepare('INSERT OR REPLACE INTO agent_goal_steps(goal_id,step_no,tool,args,result,state,expected_observation,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)').run(goal.id,stepNo,String(tool||''),JSON.stringify(args||{}).slice(0,4_000),result,state,String(expectedObservation||'').slice(0,300),now,now);
  db.prepare('UPDATE agent_goals SET current_step=?,last_observation=?,updated_at=? WHERE id=?').run(stepNo,`${tool}:${state}:${String(out.result?.error||out.result?.action||out.result?.name||'ok')}`.slice(0,1_000),now,goal.id);
}
function finishExecutionGoal(goal,state,observation=''){
  if(!goal?.id)return null;
  const now=new Date().toISOString(),terminal=['completed','blocked','failed','awaiting_user'].includes(state)?state:'failed';
  db.prepare('UPDATE agent_goals SET state=?,last_observation=?,updated_at=?,completed_at=? WHERE id=?').run(terminal,String(observation||'').slice(0,1_000),now,['completed','failed'].includes(terminal)?now:null,goal.id);
  return executionGoal(goal.id);
}
function executionGoal(goalId){
  const row=db.prepare('SELECT * FROM agent_goals WHERE id=?').get(Number(goalId)||0);if(!row)return null;
  const steps=db.prepare('SELECT step_no,tool,args,result,state,expected_observation,created_at,finished_at FROM agent_goal_steps WHERE goal_id=? ORDER BY step_no').all(row.id).map(step=>({stepNo:Number(step.step_no),tool:step.tool,args:JSON.parse(step.args||'{}'),result:JSON.parse(step.result||'{}'),state:step.state,expectedObservation:step.expected_observation,createdAt:step.created_at,finishedAt:step.finished_at}));
  return {id:Number(row.id),objective:row.objective,successCriteria:row.success_criteria,state:row.state,currentStep:Number(row.current_step),maxSteps:Number(row.max_steps),lastObservation:row.last_observation,createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at,steps};
}
function executionGoals(clientId,limit=20){
  return db.prepare('SELECT id FROM agent_goals WHERE client_id=? ORDER BY id DESC LIMIT ?').all(String(clientId||''),Math.max(1,Math.min(100,Number(limit)||20))).map(row=>executionGoal(row.id)).filter(Boolean);
}
const AGENT_LOG_KINDS=new Set(['agent_chat_start','agent_tool','agent_chat_done','agent_review','agent_skill']);
function readAgentLogs(clientId,limit=200,kind=''){
  const safeKind=AGENT_LOG_KINDS.has(String(kind||''))?String(kind):'';
  const rows=db.prepare(`SELECT id,kind,detail,created_at FROM agent_logs WHERE client_id=?${safeKind?' AND kind=?':''} ORDER BY id DESC LIMIT ?`).all(String(clientId||'').slice(0,100),...(safeKind?[safeKind]:[]),Math.max(1,Math.min(500,Number(limit)||200)));
  return rows.map(r=>({id:Number(r.id),kind:r.kind,detail:r.detail,createdAt:r.created_at}));
}
const rateBuckets=new Map();
function rateAllowed(clientId,limit=AGENT_CONFIG.chatRateLimit,windowMs=60_000){
  const now=Date.now(),key=String(clientId||'anon');let arr=rateBuckets.get(key)||[];arr=arr.filter(t=>now-t<windowMs);
  if(arr.length>=limit)return false;arr.push(now);rateBuckets.set(key,arr);return true;
}
function createAgentTask(clientId,kind,dueDate,payload={},options={}){
  const row=userRow(clientId);if(!row)return null;
  const existing=db.prepare("SELECT id FROM agent_tasks WHERE user_id=? AND kind=? AND due_date=? AND status IN ('pending','planned')").get(row.id,kind,String(dueDate||''));
  if(existing){
    // 同类型同日任务已存在：用最新文案覆盖旧文案，避免历史旧任务把旧话术一直展示下去
    db.prepare('UPDATE agent_tasks SET payload=?,priority=? WHERE id=?').run(JSON.stringify(payload||{}),Math.max(0,Math.min(9,Number(options.priority)||0)),existing.id);
    return {id:Number(existing.id),duplicate:true,refreshed:true};
  }
  const now=new Date().toISOString(),dueAt=String(options.dueAt||now),status=options.planned?'planned':'pending';
  const info=db.prepare('INSERT INTO agent_tasks(user_id,kind,due_date,status,payload,created_at,priority,state,due_at,goal_id,dependencies) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.id,kind,String(dueDate||''),status,JSON.stringify(payload||{}),now,Math.max(0,Math.min(9,Number(options.priority)||0)),status,dueAt,Number(options.goalId)||null,String(options.dependencies||'').slice(0,200));
  return {id:Number(info.lastInsertRowid)};
}
function schedulerTick(){
  const clock=shanghaiClock(),date=clock.date,minute=clock.minutes,nowIso=new Date().toISOString();
  db.prepare("UPDATE agent_tasks SET status='pending',state='pending' WHERE status='planned' AND due_at IS NOT NULL AND due_at<=?").run(nowIso);
  const tickCounter=(schedulerTick.count||0)+1;schedulerTick.count=tickCounter;
  for(const u of db.prepare('SELECT id,client_id,profile FROM users').all()){
    const profile=JSON.parse(u.profile||'{}');
    if(!profile.weight)continue;
    const loggedTypes=new Set(db.prepare('SELECT type FROM meal_logs WHERE user_id=? AND date=?').all(u.id,date).map(x=>normalizeMealType(x.type)));
    const newTasks=[];
    if(minute>=11*60&&minute<=12*60&&!loggedTypes.has('午餐'))newTasks.push(createAgentTask(u.client_id,'plan_lunch',date,{text:'午餐时间临近，今天午餐还没规划，需要我按剩余预算帮你选吗？'}));
    if(minute>=16*60+30&&minute<=18*60&&!loggedTypes.has('晚餐'))newTasks.push(createAgentTask(u.client_id,'plan_dinner',date,{text:'晚餐时间临近，今天晚餐还没安排，要我生成 DIY 食谱或找附近餐馆吗？'}));
    const goal=goalState(u.client_id);
    if(goal&&(goal.pace==='behind'||goal.pace==='stalling'))newTasks.push(createAgentTask(u.client_id,'goal_intervention',date,{text:`目标进度：近7日平均 ${goal.current}kg${goal.latestWeight!=null?`（最新记录 ${goal.latestWeight}kg）`:''} / 目标 ${goal.targetValue}kg，剩余 ${goal.daysLeft} 天，实际 ${goal.actualWeekly==null?'未知':goal.actualWeekly+' kg/周'}，所需约 ${goal.requiredWeekly} kg/周，进度${goal.pace==='behind'?'偏慢':'停滞'}。已按当前数据完成评估：${(Number(u.budget_adjustment_kcal)||0)<0?`预算已下调 ${Math.abs(Number(u.budget_adjustment_kcal))} kcal，本周按调整后的计划执行。`:(Number(u.budget_adjustment_kcal)||0)>0?`预算已上调 ${Number(u.budget_adjustment_kcal)} kcal，本周按调整后的计划执行。`:'当前无需调整预算，本周继续执行原计划。'}`},{priority:2}));
    if(newTasks.some(t=>t&&!t.duplicate))sseSend(u.client_id,{type:'tasks',tasks:pendingTasks(u.client_id,date)});
    if(tickCounter%5===0)embedPendingMemories(u.client_id).catch(()=>{});
  }
}
async function runAgentReview(clientId){
  const row=userRow(clientId);if(!row)return {error:'用户不存在'};
  const profile=JSON.parse(row.profile||'{}'),today=shanghaiClock().date;
  const weights=db.prepare('SELECT date,weight FROM weight_logs WHERE user_id=? ORDER BY date').all(row.id);
  const trend=weightTrend(weights);
  if(!trend.enough)return {ok:true,message:'体重记录不足14天，暂不调整预算',trend};
  const days=Math.max(1,Math.ceil((new Date(`${profile.targetDate||today}T12:00:00`)-new Date())/86400000));
  const targetWeekly=Math.max(0,(Number(profile.weight||0)-Number(profile.targetWeight||0))*7/days);
  const recentMeals=db.prepare('SELECT COUNT(*) count FROM meal_logs WHERE user_id=? AND date>=?').get(row.id,String(new Date(Date.now()-13*86400000).toISOString().slice(0,10))).count;
  const complete=recentMeals>=10;
  const confirmedCount=recentMemory(clientId,300).filter(e=>e.kind==='meal_confirmed').length;
  let adjustment=Number(row.budget_adjustment_kcal)||0,strategy='本周继续执行原计划，无需调整。',taskText='',decidedBy='rules';
  if(process.env.DASHSCOPE_API_KEY){
    try{
      const d=await qwenChat({model:process.env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:'你是减脂数据复盘专家。只能依据给定数据判断，不得虚构趋势数字。硬约束：趋势数据不足或波动无明确结论时 adjustment 必须为 0；adjustment 只能是 -100 到 100 之间的整数，0 表示不调整；adjustment 为 0 时 strategy 固定为“本周继续执行原计划，无需调整”，taskText 必须为空字符串；adjustment 非 0 时 strategy 必须具体可落地（如“晚餐主食减半”），不写空话，taskText 是给用户的一句话行动。只返回JSON：{"adjustment":0,"strategy":"","taskText":""}。累计调整应保持在-150到300之间。'},{role:'user',content:JSON.stringify({trend:{deltaWeek:trend.deltaWeek,targetWeekly,slopePerWeek:trend.slopePerWeek},complete,confirmedCount,currentAdjustment:adjustment,profile:{weight:profile.weight,targetWeight:profile.targetWeight,targetDate:profile.targetDate}})}]});
      const decision=parseJsonText(responseText(d));
      const rawProposed=Math.round(Number(decision.adjustment));
      const proposed=Number.isFinite(rawProposed)?Math.max(-100,Math.min(100,rawProposed)):0;
      adjustment=Math.max(-150,Math.min(300,adjustment+proposed));
      strategy=String(decision.strategy||strategy).slice(0,200);
      taskText=String(decision.taskText||'').slice(0,200);
      decidedBy='llm';
    }catch(e){console.warn(`review LLM failed: ${e.message}`)}
  }else{
    const slow=targetWeekly>0.2&&(trend.deltaWeek>=0||Math.abs(trend.deltaWeek)<targetWeekly*.5);
    if(slow&&complete){adjustment=Math.max(-150,adjustment-100);strategy='记录完整时优先减少主食和油脂份量';}
    else if(trend.deltaWeek>0){adjustment=Math.max(-150,adjustment-50);strategy='体重反弹时保持克制，先记录真实摄入';}
  }
  // 服务端硬约束：调整量为 0 时不生成任何 action_plan 任务，话术固定为肯定句，不依赖 LLM 自觉
  if(adjustment===0){strategy='本周继续执行原计划，无需调整。';taskText='';}
  db.prepare('UPDATE users SET profile=?,budget_adjustment_kcal=?,updated_at=? WHERE id=?').run(JSON.stringify({...profile,budgetAdjustmentKcal:adjustment}),adjustment,new Date().toISOString(),row.id);
  addMemoryEvent(clientId,'weekly_review',today,{deltaWeek:trend.deltaWeek,targetWeekly,complete,adjustment,strategy,decidedBy});
  if(taskText)createAgentTask(clientId,'action_plan',today,{text:taskText},{priority:1});
  logAgent(clientId,'agent_review',`decidedBy=${decidedBy} adjustment=${adjustment} strategy=${strategy}`);
  return {ok:true,trend:{...trend,targetWeekly},complete,adjustment,strategy,decidedBy,message:adjustment!==0?`预算已调整 ${adjustment} kcal`:'当前无需调整预算，本周继续执行原计划。'};
}
if(process.env.NODE_ENV!=='test'){
  // 任务维护：过期未处理任务、旧文案目标干预任务、以及“无需调整”的空动作任务不再展示，避免提醒里出现历史旧话术或自相矛盾
  try{
    const today=shanghaiClock().date;
    db.prepare("UPDATE agent_tasks SET status='cancelled',state='cancelled' WHERE status IN ('pending','planned') AND due_date<?").run(today);
    const oldCopyMarker='要不要我重新算一下预算或调整策略？';
    for(const t of db.prepare("SELECT id,payload FROM agent_tasks WHERE status IN ('pending','planned') AND kind IN ('goal_intervention','action_plan')").all()){
      let p={};try{p=JSON.parse(t.payload||'{}')}catch{}
      const text=String(p.text||'');
      if(text.includes(oldCopyMarker)||text==='本周继续执行原计划，无需调整')db.prepare("UPDATE agent_tasks SET status='cancelled',state='cancelled' WHERE id=?").run(t.id);
    }
  }catch(e){console.warn(`agent task maintenance: ${e.message}`)}
  setInterval(()=>{try{schedulerTick()}catch(e){console.warn(`agent scheduler: ${e.message}`)}},60_000);schedulerTick();
}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname.startsWith('/api/')){const handled=await api(req,res,url);if(handled===false)return json(res,404,{error:'API not found'});return}staticFile(req,res,url)}catch(e){console.error(e);if(!res.headersSent)json(res,500,{error:e.message})}});
if(process.env.NODE_ENV!=='test'){server.listen(PORT,()=>console.log(`小饭 running at http://localhost:${PORT}`));}
export {weightTrend,mealTargets,cosineSimilarity,normalizeMealType,inferMealType,goalState,syncGoal,rateAllowed,schedulerTick,createAgentTask,pendingTasks,PROMPT_VERSION,PROMPTS_VERSION,SYSTEM_BASE,buildAgentContext,sanitizePlanSteps,agentChat,parseSkillFrontmatter,scanSkills,loadSkillContent,routeDescription,normalizeRouterIntent,detectMealScenario,bucketIntent,isValidMealScenario,expectedMealAction,routerActionFor,selectActionType,hasScenarioSignal,checkIntentConflict,selectSkillReferences,loadSkillCore,buildSkillCorrection,isMealRecordRequest,isNearbyRestaurantRequest,normalizeBrowserLocation,controlledToolArgs,executionArgsForLog,mealRecordFailureResult,beginExecutionGoal,recordExecutionStep,finishExecutionGoal,executionGoal,executionGoals,estimateTextMealRecord};
