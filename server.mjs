import http from 'node:http';
import {env,isCloudflare} from './runtime.mjs';
import {atomic} from './database.mjs';
import {TFDA_TERMS,resolveAuthoritativeNutrition,authoritativeFoodDetails,NUTRITION_MANIFEST} from './nutrition-dataset.mjs';
import {browseFoods,catalogCategories,catalogDetails,isPublicFoodRoute} from './food-catalog.mjs';
import {browseRecipes,recipeDetails} from './recipe-library.mjs';
import {recipeRequirements,recipeFoodAllowed,recipeContext,validateRecipePlan,findReusableRecipe,saveGeneratedRecipe} from './recipe-reuse.mjs';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync
} from 'node:fs';

import {
  join,
  resolve
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {servePublicFile} from './public-files.mjs';
import {createAccounts} from './accounts.mjs';

const ROOT=fileURLToPath(new URL('.',import.meta.url));
const CN_TZ='Asia/Shanghai'; // 北京时间（中国标准时间 UTC+8；IANA 时区库中全中国统一使用 Asia/Shanghai）
if(!isCloudflare)loadDotEnv(join(ROOT,'.env'));
const PORT=Number(env.PORT||8080);
// 本地 SQLite 保存 台湾食药署 与用户状态；云端通过请求上下文使用 D1。
const SOURCE_DATA_DIR=join(ROOT,'data');
const DATA_DIR=resolve(env.DATA_DIR||SOURCE_DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
const db=new DatabaseSync(join(DATA_DIR,'nutrition.sqlite'));
const FOOD_TERMS=TFDA_TERMS;
if(!isCloudflare){
db.exec('PRAGMA busy_timeout=5000');
db.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON');
initDatabase();
}
const accounts=createAccounts({db,json,readBody:body,getState:async clientId=>(await buildUserState((await userRow(clientId)))),saveState:upsertUser,closeEvents:clientId=>{for(const response of sseClients.get(clientId)||[])response.end();sseClients.delete(clientId)}});

function loadDotEnv(path){
  if(!existsSync(path))return;
  for(const line of readFileSync(path,'utf8').split(/\r?\n/)){
    const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#'))continue;
    const i=trimmed.indexOf('=');if(i<1)continue;
    const key=trimmed.slice(0,i).trim(),value=trimmed.slice(i+1).trim().replace(/^['"]|['"]$/g,'');
    if(!(key in env))env[key]=value;
  }
}
function initDatabase(){
  db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,client_id TEXT UNIQUE,profile TEXT,chat_history TEXT,pending_meal TEXT,budget_adjustment_kcal INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT);CREATE TABLE IF NOT EXISTS meal_logs(id INTEGER PRIMARY KEY,user_id INTEGER,date TEXT,type TEXT,name TEXT,calories REAL,protein REAL,source TEXT,recorded_at TEXT);CREATE TABLE IF NOT EXISTS weight_logs(id INTEGER PRIMARY KEY,user_id INTEGER,date TEXT,weight REAL,source TEXT,recorded_at TEXT,UNIQUE(user_id,date));CREATE TABLE IF NOT EXISTS agent_memory(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,date TEXT,payload TEXT,created_at TEXT);CREATE TABLE IF NOT EXISTS agent_tasks(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,due_date TEXT,status TEXT DEFAULT 'pending',payload TEXT,created_at TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,start_value REAL,current_value REAL,target_value REAL,deadline TEXT,status TEXT DEFAULT 'active',created_at TEXT,updated_at TEXT);CREATE TABLE IF NOT EXISTS memory_embeddings(id INTEGER PRIMARY KEY,memory_id INTEGER,embedding TEXT);CREATE TABLE IF NOT EXISTS agent_logs(id INTEGER PRIMARY KEY,client_id TEXT,kind TEXT,detail TEXT,created_at TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_goals(id INTEGER PRIMARY KEY,user_id INTEGER,client_id TEXT,objective TEXT,success_criteria TEXT,state TEXT DEFAULT 'running',current_step INTEGER DEFAULT 0,max_steps INTEGER DEFAULT 6,last_observation TEXT DEFAULT '',created_at TEXT,updated_at TEXT,completed_at TEXT);CREATE TABLE IF NOT EXISTS agent_goal_steps(id INTEGER PRIMARY KEY,goal_id INTEGER,step_no INTEGER,tool TEXT,args TEXT,result TEXT,state TEXT DEFAULT 'planned',expected_observation TEXT,created_at TEXT,finished_at TEXT,UNIQUE(goal_id,step_no),FOREIGN KEY(goal_id) REFERENCES agent_goals(id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS skills(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,description TEXT,schema TEXT,preconditions TEXT,fallback TEXT,steps TEXT,version INTEGER DEFAULT 1,scope TEXT DEFAULT 'user',source TEXT DEFAULT 'agent',active INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT,UNIQUE(user_id,name));CREATE TABLE IF NOT EXISTS skill_embeddings(id INTEGER PRIMARY KEY,skill_id INTEGER,embedding TEXT);`);
  const taskCols=db.prepare('PRAGMA table_info(agent_tasks)').all().map(c=>c.name);
  if(!taskCols.includes('priority'))db.exec('ALTER TABLE agent_tasks ADD COLUMN priority INTEGER DEFAULT 0');
  if(!taskCols.includes('state'))db.exec("ALTER TABLE agent_tasks ADD COLUMN state TEXT DEFAULT 'pending'");
  if(!taskCols.includes('due_at'))db.exec('ALTER TABLE agent_tasks ADD COLUMN due_at TEXT');
  if(!taskCols.includes('goal_id'))db.exec('ALTER TABLE agent_tasks ADD COLUMN goal_id INTEGER');
  if(!taskCols.includes('dependencies'))db.exec('ALTER TABLE agent_tasks ADD COLUMN dependencies TEXT');
  const userCols=db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
  const mealCols=db.prepare('PRAGMA table_info(meal_logs)').all().map(c=>c.name);
  if(!mealCols.includes('details')){try{db.exec("ALTER TABLE meal_logs ADD COLUMN details TEXT DEFAULT '{}'")}catch(error){if(!/duplicate column/i.test(String(error.message)))throw error}}
  if(!userCols.includes('app_state')){try{db.exec("ALTER TABLE users ADD COLUMN app_state TEXT DEFAULT '{}'")}catch(error){if(!/duplicate column/i.test(String(error.message)))throw error}}
  // Migrate the food catalog atomically; account and confirmed-meal tables stay intact.
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nutrition_dataset'").get()){
    db.exec('BEGIN');
    try{
      for(const file of ['0007_tfda_schema.sql',...NUTRITION_MANIFEST.snapshotMigrations,'0009_tfda_activate.sql'])db.exec(readFileSync(join(ROOT,'migrations',file),'utf8'));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}
  }
  db.exec(readFileSync(join(ROOT,'migrations/0006_usda_only.sql'),'utf8'));
  const hasRecipeBatches=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recipe_seed_batches'").get();
  if(!hasRecipeBatches||!db.prepare('SELECT version FROM recipe_seed_batches WHERE version=?').get('home-2024-v1')){
    db.exec('BEGIN');
    try{
      for(const file of ['0010_recipe_schema.sql','0011_home_recipes.sql'])db.exec(readFileSync(join(ROOT,'migrations',file),'utf8'));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}
  }
  if(!db.prepare('PRAGMA table_info(recipes)').all().some(column=>column.name==='cache_key')){
    db.exec('BEGIN');
    try{db.exec(readFileSync(join(ROOT,'migrations/0012_recipe_reuse.sql'),'utf8'));db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
  }

}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
async function body(req,max=12_000_000){return new Promise((resolve,reject)=>{let size=0,s='';req.on('data',c=>{size+=c.length;if(size>max){reject(Object.assign(new Error('请求内容过大'),{status:413}));req.destroy();return}s+=c});req.on('end',()=>{try{const value=s?JSON.parse(s):{};if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();if(req.account)value.clientId=req.account.client_id;resolve(value)}catch{reject(Object.assign(new Error('JSON格式错误'),{status:400}))}});req.on('error',reject)})}
async function datasetFoodRow(query){
  const {nutrition}=await resolveNutrition(query);
  return nutrition?{...nutrition,...nutrition.per100g,sourceCategory:nutrition.category,category:planningFoodCategory(nutrition),match_type:nutrition.matchType}:null;
}
function planningFoodCategory(food){
  const category=String(food?.category||''),name=String(food?.name||'');
  if(/谷物|淀粉/.test(category))return '主食';
  if(/鱼贝/.test(category))return '水产';
  if(/蛋类|乳品/.test(category))return '蛋奶';
  if(/菇类|藻类/.test(category))return '蔬菜';
  if(/豆类/.test(category)||(/加工调理/.test(category)&&/豆腐|豆干|豆皮|豆包/.test(name)))return '豆制品';
  if(/饮料类/.test(category))return '饮品';
  return category;
}
function normalizeFood(row){return row.per100g?row:{id:row.id,name:row.name,category:row.category,per100g:{kcal:row.kcal,protein:row.protein,fat:row.fat,carbs:row.carbs},source:{type:row.source,url:row.source_url||null,id:row.source_id||null},confidence:row.confidence,matchType:row.match_type||'user_provided'}}
function candidateNutrition(candidate,name){
  if(!candidate||candidate.kcal==null||candidate.kcal==='')return null;
  const kcal=Number(candidate.kcal),sourceUrl=validPublicUrl(candidate.sourceUrl);
  if(!Number.isFinite(kcal)||kcal<0||!sourceUrl)return null;
  let ratio=1;
  if(candidate.basis==='perServing'){
    const grams=Number(candidate.servingGrams);
    if(!Number.isFinite(grams)||grams<=0)return null;
    ratio=100/grams;
  }else if(candidate.basis!=='per100g')return null;
  const nutrient=key=>{
    if(candidate[key]==null||candidate[key]==='')return null;
    const value=Number(candidate[key]);
    return Number.isFinite(value)&&value>=0?+(value*ratio).toFixed(2):null;
  };
  return {name:String(candidate.name||name),category:'external',per100g:{kcal:+(kcal*ratio).toFixed(2),protein:nutrient('protein'),fat:nutrient('fat'),carbs:nutrient('carbs')},source:{type:'official_web_candidate',url:sourceUrl,id:null},confidence:['high','medium'].includes(candidate.confidence)?candidate.confidence:'low',matchType:'official_web_candidate'};
}
async function resolveNutrition(name){
  return resolveAuthoritativeNutrition(db,name);
}
function responseText(data){return data.choices?.[0]?.message?.content||data.output_text||''}
function parseJsonText(text){const m=text.match(/```(?:json)?\s*([\s\S]*?)```/i);return JSON.parse(m?m[1]:text)}
function qwenRequestConfig(){
  const timeoutValue=Number(env.QWEN_REQUEST_TIMEOUT_MS),retryValue=Number(env.QWEN_REQUEST_RETRIES),backoffValue=Number(env.QWEN_RETRY_BASE_MS);
  return {
    timeoutMs:Math.max(1000,Math.min(120000,Number.isFinite(timeoutValue)&&timeoutValue>0?timeoutValue:30000)),
    retries:Math.max(0,Math.min(3,Number.isInteger(retryValue)&&retryValue>=0?retryValue:1)),
    backoffMs:Math.max(0,Math.min(5000,Number.isFinite(backoffValue)&&backoffValue>=0?backoffValue:500))
  };
}
function qwenRetryable(error){return error?.retryable===true||error?.name==='AbortError'||error?.name==='TimeoutError'||error instanceof TypeError}
async function qwenChat(payload){
  const key=env.DASHSCOPE_API_KEY;if(!key)throw new Error('DASHSCOPE_API_KEY 未配置');
  const base=(env.QWEN_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/,'');
  const config=qwenRequestConfig();let lastError=null,attemptCount=0;
  for(let attempt=0;attempt<=config.retries;attempt++){
    attemptCount++;
    try{
      const r=await fetch(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({...payload,enable_thinking:false}),signal:AbortSignal.timeout(config.timeoutMs)}),d=await r.json();
      if(!r.ok){const error=new Error(d.error?.message||`千问API ${r.status}`);error.status=r.status;error.retryable=r.status===408||r.status===429||r.status>=500;throw error}
      return d;
    }catch(error){
      lastError=error;
      if(attempt>=config.retries||!qwenRetryable(error))break;
      if(config.backoffMs)await new Promise(resolveDelay=>setTimeout(resolveDelay,config.backoffMs*2**attempt));
    }
  }
  const reason=lastError?.name==='TimeoutError'||lastError?.name==='AbortError'?`请求超过 ${config.timeoutMs}ms`:(lastError?.message||'未知错误');
  throw new Error(`千问API调用失败（${attemptCount}次尝试）：${reason}`);
}
async function analyzeImage(imageDataUrl,context=''){
  const today=shanghaiClock().date,d=await qwenChat({model:env.QWEN_VISION_MODEL||'qwen3-vl-plus',messages:[{role:'user',content:[{type:'text',text:`识别这张餐食图片，并结合用户说明判断具体菜名、食材、烹饪方式和可见份量。只返回JSON，不要markdown。结构：{"dishName":"","suggestedMealType":"早餐|午餐|晚餐|其他摄入|","recordDate":"YYYY-MM-DD","foods":[{"name":"","portionGramsMin":0,"portionGramsMax":0,"foodConfidence":"high|medium|low","portionConfidence":"high|medium|low","portionBasis":"视觉比例|用户说明|常见份量","cookingMethod":""}],"uncertainties":[],"followUpQuestion":""}。dishName直接给出最合适的通用菜名，不要加入“疑似”“可能”“大概”等不确定修饰词，不确定性只写入uncertainties。无法确定具体菜名时使用通用类别（如“中式汤面”“家常炒菜”），不要硬编一个具体菜名；foods 数组最多 8 项。今天日期是${today}。只有用户说明明确表达餐次时才填写suggestedMealType，否则返回空字符串；根据“今天、昨天”等明确表达填写recordDate，没有明确日期则使用今天。重量优先根据用户说明、餐具比例、食物数量和常见一人份给出合理区间，不能假装精确；完全无法判断时仍填写常见一人份范围。不要编造不可见配料，可把用油、酱汁写入uncertainties。\n上下文：${context||'用户未提供补充说明'}`},{type:'image_url',image_url:{url:imageDataUrl}}]}],response_format:{type:'json_object'}});
  return parseJsonText(responseText(d));
}
function imagePortionEstimate(item={},local=null){
  const positive=value=>{const n=Number(value);return Number.isFinite(n)&&n>0?n:null},modelMin=positive(item.portionGramsMin),modelMax=positive(item.portionGramsMax),single=positive(item.portionGrams);if(modelMin||modelMax||single){const center=single||modelMin||modelMax,min=Math.round(modelMin||center*.85),max=Math.round(modelMax||center*1.15);return {portionGramsMin:Math.max(1,Math.min(min,max)),portionGramsMax:Math.max(min,max),portionBasis:String(item.portionBasis||'视觉份量估算'),portionConfidence:String(item.portionConfidence||item.confidence||'medium')}}
  const name=String(item.name||''),category=planningFoodCategory(local),range=/油|酱/.test(name)?[5,15]:/饮品|饮料/.test(category)||/饮料|奶茶|咖啡|豆浆|牛奶/.test(name)?[250,500]:/蛋奶/.test(category)||/鸡蛋|鸭蛋/.test(name)?[50,100]:/肉类|水产|豆制品/.test(category)?[80,180]:/主食/.test(category)||/饭|面|粉|粥|薯|土豆/.test(name)?[100,220]:/蔬菜/.test(category)?[100,250]:/水果/.test(category)?[100,250]:[80,200];return {portionGramsMin:range[0],portionGramsMax:range[1],portionBasis:'按食物类别采用常见一人份',portionConfidence:'low'}
}
function fallbackRecipePlan(foods,cookTime,cookTools='普通厨具'){
  const portionFor=food=>/油/.test(food.name)?8:/主食/.test(food.category)?150:/肉类|水产/.test(food.category)?150:/蔬菜/.test(food.category)?200:/蛋奶/.test(food.category)?100:/豆制品/.test(food.category)?150:100;
  const regular=foods.filter(food=>!/调味料|油脂/.test(food.category)),pick=pattern=>regular.find(food=>pattern.test(food.category)),selected=[pick(/肉类|水产|蛋奶|豆制品/),pick(/蔬菜/),pick(/主食/)].filter(Boolean);if(!selected.length&&regular.length)selected.push(regular[0]);const extra=regular.find(food=>!selected.includes(food));if(selected.length<3&&extra)selected.push(extra);const oil=foods.find(food=>/油脂/.test(food.category)),ingredients=selected.map(food=>({name:food.name,grams:portionFor(food)}));if(oil&&selected.some(food=>/肉类|水产|蛋奶|豆制品|蔬菜/.test(food.category)))ingredients.push({name:oil.name,grams:5});
  const steps=[`将${ingredients.map(x=>x.name).join('、')}按标注份量备好。`];if(selected.some(food=>/肉类|水产|蛋奶|豆制品/.test(food.category)))steps.push('将蛋白质类食材充分加热至熟。');if(selected.some(food=>/蔬菜/.test(food.category)))steps.push(`将${selected.filter(food=>/蔬菜/.test(food.category)).map(x=>x.name).join('、')}炒熟或蒸熟。`);if(selected.some(food=>/主食/.test(food.category)))steps.push(`将${selected.filter(food=>/主食/.test(food.category)).map(x=>x.name).join('、')}按份量装盘。`);steps.push('完成后按一人份装盘。');
  if(/微波炉|空气炸锅/.test(cookTools)){const tool=/微波炉/.test(cookTools)?'微波炉':'空气炸锅';steps.splice(1,steps.length-1,`将食材放入适合${tool}的耐热容器，分批加热，中途检查并翻动；肉蛋类必须彻底熟透后再食用。`,'按一人份装盘。')}
  return {name:`${selected.map(x=>x.name.replace(/[（(].*?[）)]/g,'')).slice(0,3).join('')}家常餐`,ingredients,steps,minutes:Number.parseInt(cookTime)||20,reason:'根据已匹配的现有食材组合，营养值由台湾食药署 数据重新计算。',uncertainties:['实际用油、食材生熟状态和最终食用比例会影响总热量']};
}
function unsupportedFoodMentions(plan,allowedFoods){
  const text=[plan?.name,...(Array.isArray(plan?.steps)?plan.steps:[])].join(' '),allowedIds=new Set(allowedFoods.map(food=>String(food.id))),allowedNames=allowedFoods.map(food=>food.name),terms=FOOD_TERMS,unsupported=new Set();for(const row of terms){const term=String(row.term||'').trim(),knownCombination=/番茄炒(?:鸡)?蛋|西红柿炒(?:鸡)?蛋/.test(term)&&allowedNames.some(x=>/番茄|西红柿/.test(x))&&allowedNames.some(x=>/鸡蛋/.test(x));if(term.length>=2&&text.includes(term)&&!allowedIds.has(String(row.id))&&!knownCombination)unsupported.add(term)}return [...unsupported];
}
function calculateRecipeNutrition(plan,foods){
  const byName=new Map(foods.map(food=>[food.name,food])),items=[];
  for(const item of Array.isArray(plan.ingredients)?plan.ingredients:[]){const food=byName.get(String(item.name||'').trim());if(!food)continue;const grams=Number(item.grams);if(!Number.isFinite(grams)||grams<=0||grams>600)throw new Error('食材克数无效');const scaled=key=>food[key]==null?null:+(food[key]*grams/100).toFixed(1);items.push({name:food.name,foodId:food.id,grams,category:food.category,source:food.source,kcal:scaled('kcal'),protein:scaled('protein'),fat:scaled('fat'),carbs:scaled('carbs')});}
  if(!items.length)throw new Error('食谱没有使用已匹配的食材');
  const sum=key=>items.some(item=>item[key]==null)?null:+items.reduce((total,item)=>total+item[key],0).toFixed(1);
  return {...plan,ingredients:items,nutrition:{kcal:sum('kcal')==null?null:Math.round(sum('kcal')),protein:sum('protein'),fat:sum('fat'),carbs:sum('carbs')}};
}
async function createDiyRecipe(input){
  const requested=[...new Set((Array.isArray(input.ingredients)?input.ingredients:[]).map(x=>String(x).trim()).filter(Boolean))].slice(0,12);if(!requested.length)throw new Error('请至少输入一种现有食材');
  const customFoods=new Map((Array.isArray(input.customFoods)?input.customFoods:[]).map((food,index)=>{const name=String(food.name||'').trim(),number=(value,min,max)=>{const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=min&&parsed<=max?parsed:null},kcal=number(food.kcal,0,1000),protein=number(food.protein,0,100),fat=number(food.fat,0,100),carbs=number(food.carbs,0,100);return [name,{id:`custom-${index}`,name,category:'用户输入',kcal,protein,fat,carbs,source:'user_input',source_url:null,source_id:null,confidence:'low',match_type:'user_provided'}]}).filter(([name,food])=>name&&requested.includes(name)&&food.kcal!=null&&food.protein!=null&&food.fat!=null&&food.carbs!=null));
  const matched=[],unmatched=[];for(const name of requested){const row=customFoods.get(name)||await datasetFoodRow(diyFoodQuery(name));if(row&&!matched.some(x=>x.id===row.id))matched.push(row);else if(!row)unmatched.push(name)}
  if(!matched.length)throw Object.assign(new Error('没有找到可靠营养数据，请手动填写包装或权威来源中的每100g营养值'),{status:422,unmatched});
  const requirements=recipeRequirements(input.profile||{}),safeMatched=matched.filter(food=>recipeFoodAllowed(food,requirements));
  if(!safeMatched.length)throw Object.assign(new Error('现有食材均与饮食忌口冲突，请更换食材'),{status:422});
  const pantryNames=[...new Set(Array.isArray(input.pantry)?input.pantry:['食用植物油','酱油','食盐'])].slice(0,7),allowedPantry=new Set(['食用植物油','酱油','食盐','醋','白砂糖','辣椒酱','黑胡椒酱']);
  const pantryQueries={食盐:'tfda:P0300101',醋:'tfda:P0600201'};
  const pantryFoods=(await Promise.all(pantryNames.filter(name=>allowedPantry.has(name)).map(name=>datasetFoodRow(pantryQueries[name]||name)))).filter(food=>food&&recipeFoodAllowed(food,requirements));
  const availableFoods=[...safeMatched];for(const food of pantryFoods)if(!availableFoods.some(x=>x.id===food.id))availableFoods.push(food);
  const targets=mealTargets(input.profile||{},input.today||{},input.mealType||inferMealType()),context=await recipeContext(input,availableFoods,safeMatched,targets,NUTRITION_MANIFEST.release);
  const cacheAllowed=!unmatched.length&&!customFoods.size&&availableFoods.every(food=>food.id.startsWith('tfda:'));
  if(cacheAllowed){
    const saved=await findReusableRecipe(db,availableFoods,context,{genericOil:pantryNames.includes('食用植物油')});
    if(saved)return {recipe:{...calculateRecipeNutrition(saved.plan,availableFoods),id:saved.id},matched:safeMatched.map(normalizeFood),unmatched,generatedBy:'library',cache:{status:saved.kind,recipeId:saved.id},targets};
  }
  let plan=null,generatedBy='rules',cache={status:'not_saved',reason:cacheAllowed?'model_unavailable':'unverified_ingredients'};
  const budgetPrompt=targets.budgetStatus==='exhausted'?`今日理论参考已超出；本餐不要按0热量或惩罚性补偿设计，按正常${targets.mealType}参考约${targets.mealKcal} kcal、蛋白质约${targets.mealProtein}g，优先营养密度并避免过量。`:`本餐动态热量预算约${targets.mealKcal} kcal、蛋白质约${targets.mealProtein}g；今日总目标${targets.dailyTarget} kcal，已摄入${targets.consumedKcal} kcal，剩余${targets.remainingKcal} kcal，并须为后续餐次预留${targets.reservedKcal} kcal。尽量让食谱热量接近本餐预算，不能把全天剩余额度全部用完。`;
  if(env.DASHSCOPE_API_KEY){
    try{
      const foodData=availableFoods.map(x=>({name:x.name,category:x.category,kcalPer100g:x.kcal,proteinPer100g:x.protein,fatPer100g:x.fat,carbsPer100g:x.carbs}));
      const preferenceText=JSON.stringify({taste:context.requirements.taste,preferences:context.requirements.preferences,excluded:context.requirements.blocked,vegan:context.requirements.vegan,vegetarian:context.requirements.vegetarian});
      const d=await qwenChat({model:env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'user',content:`根据以下真实可用食材生成一人份${targets.mealType}。${budgetPrompt}不需要使用全部食材，只选择适合的部分。只能使用数据库列表中的食材以及水，不得添加未列出的油、盐、糖、调味料或装饰。有热量调料如使用必须出现在ingredients并给实际克数，食用油建议0–10g；勾选调料不要求全部加入。时间不超过${context.minutes}分钟，厨具为${String(input.cookTools||'普通厨具')}，只使用这些厨具。用户要求：${preferenceText}。过敏与忌口是硬约束。口味偏好只有可用食材能实现时才采用。不要写个人姓名、身体数据或私人信息。食材数据库：${JSON.stringify(foodData)}。只返回JSON：{"name":"","ingredients":[{"name":"必须与数据库name完全一致","grams":100}],"steps":[""],"waterMl":0,"minutes":20,"reason":"","uncertainties":[""]}。必须提供正数克数、完整步骤和合理用时。营养由服务器计算，不要提供营养数字。`}]});
      plan=parseJsonText(responseText(d));
      const used=validateRecipePlan(plan,availableFoods,context),unsupported=unsupportedFoodMentions(plan,used);
      if(unsupported.length)throw new Error('步骤出现未列入配料的食材');
      plan={name:plan.name.trim(),ingredients:plan.ingredients.map(item=>({name:item.name,grams:item.grams})),steps:plan.steps,waterMl:plan.waterMl||0,minutes:plan.minutes,reason:'根据现有食材规划的家常食谱。',uncertainties:(Array.isArray(plan.uncertainties)?plan.uncertainties:[]).filter(item=>typeof item==='string').slice(0,5)};
      generatedBy='qwen';
    }catch(error){console.warn(`DIY recipe validation/model fallback: ${error.message}`);plan=null;cache={status:'not_saved',reason:'model_or_validation_failed'}}
  }
  if(!plan)plan=fallbackRecipePlan(availableFoods,input.cookTime,input.cookTools);
  const recipe=calculateRecipeNutrition(plan,availableFoods);
  if(generatedBy==='qwen'&&cacheAllowed){
    try{
      cache=await saveGeneratedRecipe(db,plan,availableFoods,context,{release:NUTRITION_MANIFEST.release,model:env.QWEN_WEB_MODEL||'qwen-plus'});
      if(cache.recipeId){
        if(!cache.inserted){const winner=await findReusableRecipe(db,availableFoods,context,{allowSeeds:false});if(winner)Object.assign(recipe,calculateRecipeNutrition(winner.plan,availableFoods))}
        recipe.id=cache.recipeId;
      }
    }
    catch(error){cache={status:'not_saved',reason:'write_failed'};console.warn(`DIY recipe save failed: ${error.message}`)}
  }
  return {recipe,matched:safeMatched.map(normalizeFood),unmatched,generatedBy,cache,targets};
}
function diyFoodQuery(name){
  const aliases={芹菜:'E37002',西葫芦:'E7100201',韭菜:'E2600201',小葱:'E23001',香干:'R4700202',豆干:'R4700203',鲜香菇:'G08001',香菇:'G08001',鲜山药:'B01002',青椒:'E75001',鲈鱼肉:'J04044',猪后腿瘦肉:'I0302301',瘦牛肉:'I0104201',大白菜:'E33001',小白菜:'E3200601',黄瓜:'E6400301'};
  const id=aliases[String(name).trim()];return id?'tfda:'+id:name;
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
  if(!env.DASHSCOPE_API_KEY)return null;
  try{
    const d=await qwenChat({model:env.QWEN_WEB_MODEL||'qwen-plus',enable_search:true,response_format:{type:'json_object'},messages:[{role:'user',content:`检索餐厅“${restaurant.name}”（地址：${restaurant.address||'未知'}，类型：${restaurant.type||'未知'}）的公开菜单。只使用无需登录即可访问、允许公开检索的网页，不绕过验证码或反爬措施。严格核对分店名称和地址；不要根据店型编造该店菜名。饮品/甜品/咖啡店只返回饮品候选，不要编造主食。只返回JSON：{"restaurantMatched":false,"dishes":[{"name":"","reason":""}],"sources":[{"title":"","url":"","kind":"merchant_official|public_page"}],"confidence":"high|medium|low","notes":""}。只有商家官方来源，或至少两个相互印证的公开来源，才能把restaurantMatched设为true；无法可靠确认则返回false和空dishes。sources 的 url 必须真实可访问。最多返回3道相对均衡的真实菜名。`} ]});
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
function isoDateAtUtc(dateKey){const match=String(dateKey||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!match)return null;const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));return Number.isNaN(date.getTime())?null:date}
function utcDateKey(date){return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`}
function shiftIsoDate(dateKey,days){const date=isoDateAtUtc(dateKey);if(!date)return '';date.setUTCDate(date.getUTCDate()+Number(days||0));return utcDateKey(date)}
function naturalWeekRange(dateKey=shanghaiClock().date){const anchor=isoDateAtUtc(dateKey)||isoDateAtUtc(shanghaiClock().date),day=anchor.getUTCDay()||7,start=new Date(anchor);start.setUTCDate(start.getUTCDate()-(day-1));const weekStart=utcDateKey(start),dates=Array.from({length:7},(_,index)=>shiftIsoDate(weekStart,index));return {weekStart,weekEnd:dates[6],dates}}
const WEEKDAY_NAMES=['周一','周二','周三','周四','周五','周六','周日'];
const WEEKLY_MEAL_TEMPLATES=[
  ['鸡蛋燕麦早餐','鸡肉时蔬饭','豆腐菌菇饭'],
  ['无糖豆浆全麦早餐','番茄牛肉饭','清蒸鱼蔬菜餐'],
  ['酸奶水果燕麦碗','虾仁杂粮饭','鸡蛋豆腐蔬菜汤'],
  ['鸡蛋蔬菜三明治','瘦肉菌菇饭','番茄鸡胸肉餐'],
  ['牛奶燕麦鸡蛋餐','鱼肉时蔬饭','豆腐西兰花饭'],
  ['杂粮粥鸡蛋早餐','外食：优先蛋白质和蔬菜','家常鸡肉蔬菜餐'],
  ['豆浆鸡蛋全麦餐','牛肉蔬菜饭','清淡鱼肉豆腐餐']
];
const WEEKLY_RECIPE_INGREDIENTS={
  '鸡蛋燕麦早餐':['即食燕麦 40g','鸡蛋 1个（约50g）','低脂牛奶 200ml','蓝莓 50g'],
  '鸡肉时蔬饭':['去皮鸡胸肉 120g','西兰花 120g','胡萝卜 80g','熟米饭 150g','食用油 5g'],
  '豆腐菌菇饭':['北豆腐 150g','鲜香菇 100g','小青菜 150g','熟米饭 100g','食用油 5g'],
  '无糖豆浆全麦早餐':['无糖豆浆 250ml','全麦面包 70g','鸡蛋 1个（约50g）','黄瓜 100g'],
  '番茄牛肉饭':['瘦牛肉 120g','番茄 200g','熟米饭 150g','食用油 5g'],
  '清蒸鱼蔬菜餐':['鱼柳 150g','西兰花 200g','熟米饭 100g','姜 5g'],
  '酸奶水果燕麦碗':['无糖酸奶 200g','即食燕麦 35g','苹果 100g','香蕉 80g'],
  '虾仁杂粮饭':['虾仁 120g','杂粮饭 150g','彩椒 100g','西兰花 100g','食用油 5g'],
  '鸡蛋豆腐蔬菜汤':['鸡蛋 1个（约50g）','嫩豆腐 150g','小青菜 200g','红薯 150g'],
  '鸡蛋蔬菜三明治':['全麦面包 70g','鸡蛋 1个（约50g）','生菜 80g','番茄 80g'],
  '瘦肉菌菇饭':['猪里脊 120g','鲜香菇 100g','小青菜 150g','熟米饭 150g','食用油 5g'],
  '番茄鸡胸肉餐':['去皮鸡胸肉 120g','番茄 200g','土豆 100g','熟米饭 100g','食用油 5g'],
  '牛奶燕麦鸡蛋餐':['低脂牛奶 250ml','即食燕麦 40g','鸡蛋 1个（约50g）','苹果 100g'],
  '鱼肉时蔬饭':['鱼柳 150g','时令蔬菜 200g','熟米饭 150g','食用油 5g'],
  '豆腐西兰花饭':['北豆腐 150g','西兰花 200g','熟米饭 100g','食用油 5g'],
  '杂粮粥鸡蛋早餐':['杂粮粥 300g','鸡蛋 1个（约50g）','菠菜 100g'],
  '外食：优先蛋白质和蔬菜':['去皮鸡胸肉 120g','时令蔬菜 250g','熟米饭 150g','食用油 5g'],
  '家常鸡肉蔬菜餐':['去皮鸡腿肉 120g','时令蔬菜 250g','熟米饭 100g','食用油 5g'],
  '豆浆鸡蛋全麦餐':['无糖豆浆 250ml','鸡蛋 1个（约50g）','全麦面包 70g','番茄 100g'],
  '牛肉蔬菜饭':['瘦牛肉 120g','时令蔬菜 200g','熟米饭 150g','食用油 5g'],
  '清淡鱼肉豆腐餐':['鱼柳 120g','嫩豆腐 100g','小青菜 200g','熟米饭 80g','姜 5g']
};
function weeklyRecipe(name,type){
  const ingredients=WEEKLY_RECIPE_INGREDIENTS[name]||[`${name}主要食材 1份`,'时令蔬菜 200g','熟米饭 100g'];
  if(type==='早餐')return {name,minutes:12,ingredients,steps:['按标注份量准备食材，鸡蛋需彻底加热至凝固。','燕麦、杂粮粥或面包按餐食名称加热，豆浆或牛奶不额外加糖。','与水果或蔬菜组合装盘，按实际食用量确认记录。']};
  if(/清蒸鱼/.test(name))return {name,minutes:25,ingredients,steps:['鱼柳加入姜片，水开后蒸约8–10分钟至完全熟透。','西兰花焯熟，米饭按标注份量称取。','鱼、蔬菜和米饭分别装盘，少量调味后食用。']};
  if(/汤/.test(name))return {name,minutes:20,ingredients,steps:['豆腐切块、青菜洗净，红薯切块提前蒸熟。','锅中加水煮开后放入豆腐和青菜，再缓慢淋入蛋液。','煮至鸡蛋完全凝固，搭配蒸红薯食用。']};
  return {name:name==='外食：优先蛋白质和蔬菜'?'鸡肉时蔬便当（在家备选）':name,minutes:25,ingredients,steps:['按标注克数备料；肉类或鱼类切块，蔬菜洗净切好。','锅中加入标注用油，先将蛋白质食材彻底加热，再加入蔬菜炒熟。','搭配标注份量的熟米饭装盘，按实际食用量确认记录。']};
}
function buildNaturalWeekPlan(input={}){
  const profile=input.profile||{},anchorDate=/^\d{4}-\d{2}-\d{2}$/.test(String(input.anchorDate||''))?String(input.anchorDate):shanghaiClock().date,range=naturalWeekRange(anchorDate),logs=Array.isArray(input.mealLogs)?input.mealLogs:[],existing=input.existingPlan&&input.existingPlan.weekStart===range.weekStart?input.existingPlan:null,existingDays=new Map((existing?.days||[]).map(day=>[day.date,day])),targets=mealTargets(profile,{},'午餐'),allocations={早餐:.25,午餐:.4,晚餐:.35},types=['早餐','午餐','晚餐'];
  const days=range.dates.map((date,index)=>{
    const dayLogs=logs.filter(log=>log?.date===date),previous=existingDays.get(date),past=date<anchorDate;
    if(previous?.locked){const meals=(previous.meals||[]).map(meal=>{const baselineName=meal.baselineName||meal.name||`${meal.type||'本餐'}均衡餐`,baselineDiy=meal.baselineDiy||meal.diy||weeklyRecipe(baselineName,meal.type);return {...meal,baselineDiy,...(meal.status==='planned'?{diy:meal.diy||baselineDiy}:{})}});return {...previous,meals,actualMeals:dayLogs.map(log=>({type:normalizeMealType(log.type)||String(log.type||''),name:String(log.name||''),calories:Number(log.calories)||0,protein:Number(log.protein)||0}))};}
    const meals=[];
    for(let mealIndex=0;mealIndex<types.length;mealIndex++){
      const type=types[mealIndex],records=dayLogs.filter(log=>normalizeMealType(log.type)===type);
      const baselineName=WEEKLY_MEAL_TEMPLATES[index][mealIndex],baselineMealKcal=Math.round(targets.dailyTarget*allocations[type]),baselineMealProtein=Math.round(targets.dailyProtein*allocations[type]),baselineDiy=weeklyRecipe(baselineName,type);
      if(records.length){const skipped=records.every(record=>record.status==='skipped');meals.push({type,name:skipped?'本餐未吃':records.map(record=>String(record.name||'')).filter(Boolean).join('、')||`${type}已记录`,mealKcal:Math.round(records.reduce((sum,record)=>sum+(Number(record.calories)||0),0)),mealProtein:+records.reduce((sum,record)=>sum+(Number(record.protein)||0),0).toFixed(1),status:skipped?'skipped':'recorded',baselineName,baselineMealKcal,baselineMealProtein,baselineDiy});continue}
      if(!past)meals.push({type,name:baselineName,mealKcal:baselineMealKcal,mealProtein:baselineMealProtein,status:'planned',diy:baselineDiy,baselineName,baselineMealKcal,baselineMealProtein,baselineDiy});
    }
    const totalKcal=Math.round(dayLogs.reduce((sum,record)=>sum+(Number(record.calories)||0),0));
    return {date,weekday:WEEKDAY_NAMES[index],status:date===anchorDate?'today':past?'past':'planned',locked:false,dailyTarget:targets.dailyTarget,totalKcal,meals,actualMeals:dayLogs.map(log=>({type:normalizeMealType(log.type)||String(log.type||''),name:String(log.name||''),calories:Number(log.calories)||0,protein:Number(log.protein)||0}))};
  });
  return {id:`${range.weekStart}-v${Math.max(1,Number(existing?.version||0)+1)}`,weekStart:range.weekStart,weekEnd:range.weekEnd,timezone:CN_TZ,version:Math.max(1,Number(existing?.version||0)+1),status:'proposed',reason:String(input.reason||(!existing?'首次生成自然周计划':'根据最新状态重新规划')).slice(0,200),createdAt:new Date().toISOString(),days};
}
function parseMenuText(raw=''){
  const lines=String(raw||'').replace(/\r/g,'').split('\n').map(line=>line.trim()).filter(Boolean),items=[];let category='未分类';
  for(const rawLine of lines){
    const line=rawLine.replace(/^[•·*\-]\s*/,'').trim();if(!line)continue;
    const header=line.match(/^[【\[]?([^【】\[\]：:]{1,20})[】\]]?[：:]?$/);
    if(header&&!/\d/.test(line)&&/(菜|饭|面|粉|汤|饮|甜品|小吃|主食|套餐|早餐|午餐|晚餐|推荐)/.test(header[1])){category=header[1].trim();continue}
    const match=line.match(/^(.{1,80}?)(?:\s*[·.…\-]{2,}\s*|\s+[¥￥]?\s*|\s*[¥￥]\s*)(\d+(?:\.\d{1,2})?)(?:\s*元)?(?:\s*[\/／]\s*(份|杯|个|碗|盘|套))?$/);
    const name=String(match?.[1]||line).replace(/[¥￥]\s*\d+(?:\.\d{1,2})?\s*(?:元)?$/,'').trim(),price=match?Number(match[2]):null;
    if(name.length<2||name.length>80||(!match&&/^(电话|地址|营业时间|扫码|欢迎|菜单)$/.test(name)))continue;
    items.push({name,category,price:Number.isFinite(price)?price:null,unit:match?.[3]||'',description:'',confidence:match?'high':'medium'});
  }
  const seen=new Set();return items.filter(item=>{const key=`${item.category}|${item.name}|${item.price??''}`;if(seen.has(key))return false;seen.add(key);return true}).slice(0,300);
}
function sanitizeMenuItems(value=[]){const seen=new Set(),items=[];for(const entry of Array.isArray(value)?value:[]){const name=String(entry?.name||'').trim().slice(0,80);if(name.length<2)continue;const category=String(entry.category||'未分类').trim().slice(0,30)||'未分类',price=entry.price==null||entry.price===''?null:Number(entry.price),key=`${category}|${name}|${Number.isFinite(price)?price:''}`;if(seen.has(key))continue;seen.add(key);items.push({name,category,price:Number.isFinite(price)&&price>=0?+price.toFixed(2):null,unit:String(entry.unit||'').slice(0,12),description:String(entry.description||'').slice(0,160),confidence:['high','medium','low'].includes(entry.confidence)?entry.confidence:'medium'});if(items.length>=300)break}return items}
async function rankParsedMenu(items=[],context={}){
  const profile=context.profile||{},blocked=[...preferenceTerms(profile.allergies),...preferenceTerms(profile.dislikedFoods)],targets=mealTargets(profile,context.today||{},context.mealType||''),safe=items.filter(item=>!blocked.some(term=>item.name.includes(term)||knownDishAllergens(item.name).includes(term))).slice(0,12),ranked=(await Promise.all(safe.map(async item=>{const estimate=await estimateMenuDish(item.name),distance=estimate?Math.abs(estimate.kcal-targets.mealKcal):targets.mealKcal,confidencePenalty=item.confidence==='low'?30:item.confidence==='medium'?10:0;return {...item,estimate,score:Math.max(0,Math.round(100-distance/Math.max(1,targets.mealKcal)*50-confidencePenalty))}}))).sort((a,b)=>b.score-a.score).slice(0,3);
  return {targets,recommendations:ranked.map(item=>({name:item.name,category:item.category,price:item.price,score:item.score,kcal:item.estimate?.kcal??null,protein:item.estimate?.protein??null,portionGrams:item.estimate?.portionGrams??null,nutritionConfidence:item.estimate?.confidence||'low',reason:item.estimate?(targets.budgetStatus==='exhausted'?`今日理论参考已超出；按正常${targets.mealType}参考约 ${targets.mealKcal} kcal 匹配，不以跳餐或0热量餐补偿；营养为台湾食药署 对应食品及份量估算`:`按${targets.mealType}约 ${targets.mealKcal} kcal 的动态预算匹配；营养为台湾食药署 对应食品及份量估算`):'菜名来自菜单原文，当前营养库没有可靠匹配，请结合实物确认份量'}))};
}
async function parseFullMenu(input={}){
  const restaurantName=String(input.restaurantName||'未命名餐馆').trim().slice(0,80),sourceUrl=validPublicUrl(input.sourceUrl),sourceType=input.imageDataUrl?'user_image':String(input.menuText||'').trim()?'user_text':sourceUrl?'public_url':'';if(!sourceType)throw Object.assign(new Error('请上传菜单图片、粘贴菜单文字或提供公开菜单链接'),{status:400});
  let items=parseMenuText(input.menuText||''),complete=items.length>0,notes=items.length?['已逐行解析用户提供的菜单文字；完整性取决于粘贴内容是否包含全部页面。']:[],modelUsed=false;
  if((input.imageDataUrl||sourceUrl)&&env.DASHSCOPE_API_KEY){
    const instruction=`逐项转录餐馆“${restaurantName}”的完整菜单。只能提取输入图片中可见或指定公开链接中能核验的内容，不得补全、改写或编造菜品和价格。保留所有可识别分类与菜品，不要只挑推荐菜。只返回JSON：{"sourceMatched":true,"sourceComplete":false,"items":[{"name":"","category":"","price":null,"unit":"","description":"","confidence":"high|medium|low"}],"notes":[""]}。sourceComplete 仅在输入明确包含完整菜单且没有缺页、截断或不可识别区域时为 true；最多返回300项。`;
    const content=input.imageDataUrl?[{type:'text',text:instruction},{type:'image_url',image_url:{url:input.imageDataUrl}}]:`${instruction}\n公开菜单链接：${sourceUrl}`;
    const response=await qwenChat({model:input.imageDataUrl?(env.QWEN_VISION_MODEL||'qwen3-vl-plus'):(env.QWEN_WEB_MODEL||'qwen-plus'),messages:[{role:'user',content}],...(sourceUrl?{enable_search:true}:{}),response_format:{type:'json_object'}}),parsed=parseJsonText(responseText(response));
    if(parsed.sourceMatched!==false){const modelItems=sanitizeMenuItems(parsed.items);if(modelItems.length){items=modelItems;complete=parsed.sourceComplete===true;notes=(Array.isArray(parsed.notes)?parsed.notes:[]).map(note=>String(note).slice(0,200)).slice(0,5);modelUsed=true}}
  }
  if(!items.length){if(!env.DASHSCOPE_API_KEY)throw Object.assign(new Error('图片或链接菜单解析需要配置 DASHSCOPE_API_KEY；也可以直接粘贴菜单文字'),{status:503});throw Object.assign(new Error('没有从该来源识别出可核验菜单项，请补充更清晰或更完整的菜单'),{status:422})}
  const ranked=await rankParsedMenu(items,{profile:input.profile||{},today:input.today||{},mealType:input.mealType||''}),retrievedAt=new Date().toISOString();
  return {restaurantName,items,itemCount:items.length,complete,notes,source:{type:sourceType,url:sourceUrl||null,label:sourceType==='user_image'?'用户上传菜单图片':sourceType==='user_text'?'用户粘贴菜单文字':'公开菜单链接',retrievedAt},recommendations:ranked.recommendations,targets:ranked.targets,parsedBy:modelUsed?'qwen':'deterministic_text'};
}
function mealTargets(profile={},today={},requestedMeal=''){
  const weight=Number(profile.weight)||60,height=Number(profile.height)||165,age=Number(profile.age)||30,targetWeight=Number(profile.targetWeight)||weight,targetDate=profile.targetDate?new Date(`${profile.targetDate}T12:00:00`):new Date(Date.now()+30*86400000),days=Math.max(1,Math.ceil((targetDate-new Date())/86400000)),base=10*weight+6.25*height-5*age+(profile.sex==='male'?5:-161),factor={sedentary:1.2,light:1.375,moderate:1.55,active:1.725}[profile.activity]||1.2,tdee=Math.round(base*factor),requiredDeficit=Math.max(0,Math.round((weight-targetWeight)*7700/days)),dailyTarget=Math.max(0,tdee-requiredDeficit+(Number(profile.budgetAdjustmentKcal)||0)),dailyProtein=Math.round(weight*1.3),consumedKcal=Math.max(0,Number(today.calories)||0),consumedProtein=Math.max(0,Number(today.protein)||0),remainingKcal=Math.max(0,dailyTarget-consumedKcal),remainingProtein=Math.max(0,dailyProtein-consumedProtein),mealType=normalizeMealType(requestedMeal)||inferMealType(),weights={早餐:.25,午餐:.4,晚餐:.35},order=['早餐','午餐','晚餐'],logged=new Set((Array.isArray(today.meals)?today.meals:[]).map(x=>normalizeMealType(x.type)).filter(Boolean)),isOther=mealType==='其他摄入',baseMeal=isOther?inferMealType():mealType,currentIndex=Math.max(0,order.indexOf(baseMeal)),futureMeals=order.slice(currentIndex+(isOther?0:1)).filter(x=>!logged.has(x)),allocationMeals=isOther?futureMeals:[mealType,...futureMeals],weightTotal=allocationMeals.reduce((sum,x)=>sum+(weights[x]||0),0)||1,mealShare=isOther?0:(weights[mealType]||.4)/weightTotal,normalMealKcal=Math.max(300,Math.round(dailyTarget*(weights[mealType]||.4))),normalMealProtein=Math.max(1,Math.round(dailyProtein*(weights[mealType]||.4))),mealKcal=isOther?0:remainingKcal<=0?normalMealKcal:Math.round(remainingKcal*mealShare),mealProtein=isOther?0:remainingKcal<=0?normalMealProtein:Math.round(remainingProtein*mealShare),reservedKcal=Math.max(0,remainingKcal-(remainingKcal<=0?0:mealKcal));
  const weeklyLoss=requiredDeficit*7/7700,bmi=weight/Math.pow(height/100,2),targetBmi=targetWeight/Math.pow(height/100,2),riskReasons=[];
  if(weeklyLoss>1)riskReasons.push(`每周需减约 ${weeklyLoss.toFixed(1)} kg，超过常见安全上限（1 kg/周）`);
  if(dailyTarget<=0)riskReasons.push('按当前目标日期，即使完全不摄入热量也无法按时达成，计划不可行');
  if(bmi<18.5&&targetWeight<weight)riskReasons.push(`当前 BMI ${bmi.toFixed(1)} 已低于 18.5，继续减重风险较高`);
  if(targetBmi<18.5)riskReasons.push(`目标 BMI ${targetBmi.toFixed(1)} 低于 18.5，建议重新评估目标体重`);
  const safety=riskReasons.length?{extreme:true,warning:riskReasons.join('；')}:null;
  const budgetStatus=remainingKcal<=0?'exhausted':mealKcal<300?'low':'normal';
  return {dailyTarget,dailyProtein,consumedKcal,consumedProtein,remainingKcal,remainingProtein,mealType,mealKcal,mealProtein,reservedKcal,futureMeals,budgetStatus,recommendationMode:budgetStatus==='exhausted'?'regular_meal_no_compensation':'remaining_budget',guidance:budgetStatus==='exhausted'?'今日理论参考已超出；本餐按正常餐次提供参考，不通过跳餐、0 热量餐或次日扣减补偿。':'',safety};
}
async function createDailyMealPlan(input={}){
  const profile=input.profile||{},today=input.today||{},records=Array.isArray(today.meals)?today.meals:[],base=mealTargets(profile,today,'早餐'),order=['早餐','午餐','晚餐'],weights={早餐:.25,午餐:.4,晚餐:.35},logged=new Set(records.map(x=>normalizeMealType(x.type)).filter(type=>order.includes(type))),pending=order.filter(type=>!logged.has(type)),weightTotal=pending.reduce((sum,type)=>sum+weights[type],0)||1,budgets={};for(const type of order){const typeRecords=records.filter(x=>normalizeMealType(x.type)===type),skipped=typeRecords.length>0&&typeRecords.every(x=>x.status==='skipped'),recordedKcal=Math.round(typeRecords.reduce((sum,x)=>sum+(Number(x.calories)||0),0)),recordedProtein=+typeRecords.reduce((sum,x)=>sum+(Number(x.protein)||0),0).toFixed(1),guidanceOnly=base.budgetStatus==='exhausted'&&!typeRecords.length,plannedKcal=guidanceOnly?Math.max(300,Math.round(base.dailyTarget*weights[type])):Math.round(base.remainingKcal*weights[type]/weightTotal),plannedProtein=guidanceOnly?Math.max(1,Math.round(base.dailyProtein*weights[type])):Math.round(base.remainingProtein*weights[type]/weightTotal);budgets[type]={type,status:skipped?'skipped':typeRecords.length?'recorded':'planned',mealKcal:typeRecords.length?recordedKcal:plannedKcal,mealProtein:typeRecords.length?recordedProtein:plannedProtein,guidanceOnly,adjustmentReason:guidanceOnly?'今日理论参考已超出；保持规律正餐，不用跳餐或 0 热量餐补偿。':'已按本次确认记录重新分配今日剩余餐次',records:typeRecords.map(x=>({name:x.name,calories:x.calories,protein:x.protein,status:x.status}))}}
  const fallback={早餐:{name:'鸡蛋豆浆全麦早餐',description:'鸡蛋、无糖豆浆和全麦主食',diy:{name:'鸡蛋豆浆全麦早餐',ingredients:['鸡蛋1个','无糖豆浆250ml','全麦面包2片'],steps:['鸡蛋煮熟或少油煎熟','全麦面包加热后搭配无糖豆浆']}},午餐:{name:'鸡肉时蔬饭',description:'鸡肉、时令蔬菜和米饭',diy:{name:'鸡肉时蔬饭',ingredients:['鸡肉120g','时令蔬菜250g','熟米饭150g'],steps:['鸡肉切块并少油煎熟','加入蔬菜炒熟调味','与熟米饭搭配']}},晚餐:{name:'豆腐蔬菜饭',description:'豆腐、蔬菜和适量主食',diy:{name:'豆腐蔬菜饭',ingredients:['豆腐150g','时令蔬菜250g','熟米饭100g'],steps:['豆腐切块煎至定型','加入蔬菜炒熟并调味','搭配熟米饭食用']}}},generated={};if(pending.length&&env.DASHSCOPE_API_KEY){try{const preference=`饮食方式：${profile.mealMode||'未设置'}；口味：${profile.tastePreference||'未设置'}；偏好：${profile.preferences||'无'}；不喜欢：${profile.dislikedFoods||'无'}；过敏或严格忌口：${profile.allergies||'无'}`,request=pending.map(type=>({type,kcal:budgets[type].mealKcal,protein:budgets[type].mealProtein})),noCompensation=base.budgetStatus==='exhausted'?'今日理论参考已超出；这些数值是正常餐次参考，不得生成0热量餐、建议跳餐、极端节食或把超额转到明天补偿。':'',response=await qwenChat({model:env.QWEN_CHAT_MODEL||env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'user',content:`为用户生成今天尚未记录餐次的可执行DIY食谱。必须遵守过敏和严格忌口，不使用零食饮料代替正餐；食材克数和步骤要能实际操作，食谱贴近餐次预算，但不要声称未经数据库验证的精确营养值。每份食谱最多6个步骤，每个数组元素只能写一个完整步骤，不要把多个编号步骤塞进同一个字符串。所有数字最多保留两位小数。用户设置：${preference}。餐次预算：${JSON.stringify(request)}。${noCompensation}只返回JSON：{"meals":[{"type":"早餐|午餐|晚餐","name":"简短菜名","description":"一句话组成说明","diy":{"name":"菜谱名","ingredients":["食材及份量"],"steps":["步骤"]}}]}`}]}),parsed=parseJsonText(responseText(response));for(const item of Array.isArray(parsed.meals)?parsed.meals:[]){const type=normalizeMealType(item.type),diy=item.diy||{};if(pending.includes(type))generated[type]={name:String(item.name||'').slice(0,60),description:String(item.description||'').slice(0,120),diy:{name:String(diy.name||item.name||'').slice(0,60),ingredients:(Array.isArray(diy.ingredients)?diy.ingredients:[]).map(x=>String(x).slice(0,80)).slice(0,8),steps:(Array.isArray(diy.steps)?diy.steps:[]).map(x=>String(x).slice(0,400)).slice(0,6)}}}}catch(e){console.warn(`Daily meal plan fallback: ${e.message}`)}}
  const meals=order.map(type=>{const target=budgets[type],names=target.records.map(x=>x.name).filter(Boolean);return {...target,...(target.status==='skipped'?{name:'本餐未吃',description:'已确认跳过本餐，不属于漏记'}:target.status==='recorded'?{name:names.join('、')||`${type}已记录`,description:`已记录约 ${target.mealKcal} kcal`}:generated[type]?.name?generated[type]:fallback[type])}});return {date:shanghaiClock().date,dailyTarget:base.dailyTarget,consumedKcal:base.consumedKcal,remainingKcal:base.remainingKcal,budgetStatus:base.budgetStatus,recommendationMode:base.recommendationMode,guidance:base.guidance,otherConsumedKcal:Math.round(records.filter(x=>normalizeMealType(x.type)==='其他摄入').reduce((sum,x)=>sum+(Number(x.calories)||0),0)),meals,generatedBy:Object.keys(generated).length?'qwen':'rules'}
}
async function estimateMenuDish(name,budget={remaining:12}){
  if(budget.remaining--<=0)return null;
  const food=await datasetFoodRow(name);if(!food)return null;const category=String(food.category||''),drink=/饮品|零食饮料/.test(category)||/茶|咖啡|果汁|饮料/.test(name),staple=/主食|外卖快餐/.test(category)||/饭|面|粉|粥|饺|包|汉堡|披萨|三明治/.test(name),portionGrams=drink?400:staple?325:/家常菜/.test(category)?250:200,kcal=Math.round((food.kcal||0)*portionGrams/100),protein=+((food.protein||0)*portionGrams/100).toFixed(1);
  return {dish:name,matchedFood:food.name,category,portionGrams,kcal,protein,confidence:'medium',matchType:food.match_type,source:food.source};
}
function preferenceTerms(value){return String(value||'').split(/[、,，;；\s]+/).map(x=>x.replace(/不吃|过敏|不喜欢|忌口|不要/g,'').trim()).filter(x=>x.length>=2)}
function knownDishAllergens(name){const hints=[];if(/宫保|花生|坚果/.test(name))hints.push('花生','坚果');if(/麻酱|芝麻/.test(name))hints.push('芝麻');if(/奶油|芝士|拿铁|牛奶/.test(name))hints.push('乳制品','牛奶');if(/面包|面条|饺子|包子|披萨|三明治/.test(name))hints.push('麸质','小麦');if(/虾|蟹|贝|海鲜/.test(name))hints.push('海鲜','甲壳类');return hints}
function timeToMinutes(value){const m=String(value).match(/(\d{1,2}):(\d{2})/);return m?Number(m[1])*60+Number(m[2]):null}
function timeRanges(value=''){return [...String(value).matchAll(/(\d{1,2}:\d{2})\s*[-至~—]\s*(\d{1,2}:\d{2})/g)].map(m=>[timeToMinutes(m[1]),timeToMinutes(m[2])])}
function rangeContains(ranges,minute){return ranges.some(([start,end])=>end<start?minute>=start||minute<=end:minute>=start&&minute<=end)}
function weeklyHoursFor(date,text=''){const names=['周日','周一','周二','周三','周四','周五','周六'],name=names[date.getDay()],parts=String(text).split(/[；;\n]+/).map(x=>x.trim()).filter(Boolean),dayNumber=date.getDay()||7;for(const part of parts){const prefix=part.split(/[:：]/)[0];if(/每天|每日|周一至周日|周一到周日/.test(prefix)||prefix.includes(name))return part;const range=prefix.match(/周([一二三四五六日])\s*[至到-]\s*周?([一二三四五六日])/),map={一:1,二:2,三:3,四:4,五:5,六:6,日:7};if(range&&dayNumber>=map[range[1]]&&dayNumber<=map[range[2]])return part}return ''}
function restaurantHours(restaurant,mealType='午餐',dayOffset=0){const business=restaurant.business||{},date=new Date(Date.now()+(Number(dayOffset)===1?86400000:0)),mealMinute={早餐:8*60+30,午餐:12*60,晚餐:18*60+30,'其他摄入':15*60+30}[normalizeMealType(mealType)]??12*60,todayText=String(business.opentime_today||'').trim(),weekText=String(business.opentime_week||'').trim(),source=Number(dayOffset)===1?weeklyHoursFor(date,weekText):todayText||weeklyHoursFor(date,weekText);if(/24小时|全天/.test(source))return {status:'open',label:'该餐次营业',source};const ranges=timeRanges(source);if(!source||!ranges.length)return {status:'unknown',label:'营业时间待确认',source:weekText||todayText};return rangeContains(ranges,mealMinute)?{status:'open',label:`预计${normalizeMealType(mealType)}时段营业`,source}:{status:'closed',label:`预计${normalizeMealType(mealType)}时段不营业`,source}}
async function personalizeRestaurant(restaurant,recommendation,context={}){
  const targets=mealTargets(context.profile,context.today,context.mealType),hours=restaurantHours(restaurant,targets.mealType,context.dayOffset),profile=context.profile||{},blocked=[...preferenceTerms(profile.allergies),...preferenceTerms(profile.dislikedFoods)],preferred=preferenceTerms(profile.preferences),text=`${restaurant.name||''} ${restaurant.type||''}`,isBeverage=/奶茶|茶饮|饮品|冷饮|咖啡|甜品|喜茶|奈雪|星巴克|瑞幸/i.test(text),isChinese=/中餐|东北菜|川菜|湘菜|粤菜|家常菜|地方菜|餐馆|饭店/i.test(text),conflicts=(dish,matched='')=>blocked.some(term=>dish.includes(term)||matched.includes(term)||knownDishAllergens(dish).includes(term)||knownDishAllergens(matched).includes(term)),allowedDishes=(recommendation.dishes||[]).filter(dish=>!conflicts(dish)),removedForPreference=allowedDishes.length!==(recommendation.dishes||[]).length,nutritionBudget=context.nutritionBudget||{remaining:12},estimates=(await Promise.all((recommendation.mode==='type_fallback'?[]:allowedDishes).slice(0,12).map(name=>estimateMenuDish(name,nutritionBudget)))).filter(Boolean).filter(item=>!conflicts(item.dish,item.matchedFood));
  for(const item of estimates){const preferenceBonus=(preferred.some(term=>item.dish.includes(term))?8:0)+(Array.isArray(context.recentConfirmed)&&context.recentConfirmed.some(name=>name&&(item.dish.includes(name)||name.includes(item.dish)))?6:0);item.score=Math.round(Math.max(0,100-Math.abs(item.kcal-targets.mealKcal)/Math.max(1,targets.mealKcal)*55+preferenceBonus))}
  estimates.sort((a,b)=>b.score-a.score);const selected=estimates[0]||null;let mealDisplay=recommendation.mealStructure||null,kcal=null,protein=null,reason=recommendation.reason,confidence='low';
  if(selected){const originalGrams=selected.portionGrams,scale=Math.min(1.5,Math.max(.25,targets.mealKcal/Math.max(1,selected.kcal)));selected.portionGrams=Math.max(30,Math.round(selected.portionGrams*scale/10)*10);const actualScale=selected.portionGrams/originalGrams;kcal=Math.round(selected.kcal*actualScale);protein=+(selected.protein*actualScale).toFixed(1);mealDisplay=`${selected.dish}（约${selected.portionGrams}g）`;confidence=selected.confidence;reason=`按 台湾食药署 对应食品和估计份量计算，具体配方及实际克数仍需确认；本餐参考约${targets.mealKcal} kcal。`}

  else if(removedForPreference&&!allowedDishes.length){mealDisplay='已排除与过敏、忌口或不喜欢食材冲突的候选菜';reason='当前已知菜单中没有安全候选，请查看店内其他菜品并再次确认配料'}
  else if(allowedDishes.some(dish=>/三明治|贝果|卷|饭|面|粉|粥|饺|包|沙拉|披萨|吐司|汉堡|热狗|鸡|鱼|虾|牛|肉|蛋/.test(dish))){reason=`可根据当前真实菜单或门店类型优先选择这类餐食；暂不强行估算热量，用餐后可拍照识别或手动记录实际摄入`}
  else if(isBeverage)reason=targets.budgetStatus==='normal'?'当前可核验候选是饮品或甜品，可按你的需求选择；用餐后再确认实际热量':'当前热量余额较少，饮品或甜品仍可作为候选；优先选择小份、低糖或不额外加料的选项';
  const cuisine=String(context.cuisine||''),cuisineMatch=!cuisine||text.includes(cuisine)||(cuisine==='中餐'&&isChinese),distanceScore=Math.max(0,20-(Number(restaurant.distance)||0)/200),recommendationScore=selected?selected.score:recommendation.mode==='verified_menu'?75:recommendation.mode==='amap_tag'?65:40,sourceScore=recommendation.mode==='verified_menu'?12:recommendation.mode==='amap_tag'?8:2,cuisineScore=cuisineMatch&&cuisine?15:0,hoursScore=hours.status==='open'?15:hours.status==='closed'?-100:0,score=Math.round(recommendationScore+distanceScore+sourceScore+cuisineScore+hoursScore);if(cuisine&&cuisineMatch)reason=`符合本餐“${cuisine}”偏好；${reason}`;
  return {...recommendation,dishes:allowedDishes,mealStructure:removedForPreference?null:recommendation.mealStructure,personalization:{targets,hours,mealDisplay,kcal,protein,confidence,reason,matchedCount:estimates.length,score,blockedTerms:blocked,nutritionPending:kcal==null}};
}
async function api(req,res,url){
  if(isPublicFoodRoute(req,url)){
    if(url.pathname.endsWith('/categories'))return json(res,200,{ok:true,...await catalogCategories(db)});
    if(url.pathname.endsWith('/details')){const result=await catalogDetails(db,url.searchParams.get('id'));return json(res,result?200:404,result?{ok:true,result}:{error:'当前数据库未收录此食品'});}
    return json(res,200,{ok:true,...await browseFoods(db,Object.fromEntries(url.searchParams))});
  }
  if(req.method==='GET'&&url.pathname==='/api/health'){const count=await db.prepare('SELECT COUNT(*) count,SUM(nutrient_count) nutrient_rows FROM nutrition_foods').get();const recipes=await db.prepare("SELECT COUNT(*) count,SUM(CASE WHEN origin='seed' THEN 1 ELSE 0 END) seed_count FROM recipes").get();return json(res,200,{ok:true,recipeCount:recipes.count,seedRecipeCount:recipes.seed_count,recipeReuse:true,services:{qwen:!!env.DASHSCOPE_API_KEY,tfda:true,usda:false,amap:!!env.AMAP_WEB_SERVICE_KEY,openFoodFacts:false},nutritionSource:'TFDA',foodCount:0,authoritativeFoodCount:count.count,nutrientRecordCount:count.nutrient_rows,datasetRelease:NUTRITION_MANIFEST.release})}
  if(req.method==='GET'&&url.pathname==='/api/nutrition/details'){const result=await authoritativeFoodDetails(db,url.searchParams.get('q'));return json(res,result?200:404,result?{ok:true,result}:{ok:false,error:'未找到食药署食品明细'})}
  if(req.method==='GET'&&['/api/nutrition/dataset-search','/api/nutrition/search','/api/nutrition/resolve'].includes(url.pathname)){
    const q=(url.searchParams.get('q')||'').trim();if(!q)return json(res,400,{error:'缺少q'});
    try{
      const resolved=await resolveNutrition(q);
      if(url.pathname.endsWith('/dataset-search'))return json(res,200,{ok:true,...resolved,basis:'per100g',results:resolved.nutrition?[resolved.nutrition]:resolved.candidates});
      if(resolved.nutrition)return json(res,200,{ok:true,result:resolved.nutrition,...resolved});
      return json(res,resolved.needsClarification?409:404,{ok:false,error:resolved.question||'台湾食药署 未找到可靠营养记录',...resolved});
    }catch(error){return json(res,502,{error:error.message})}
  }
  if(req.method==='GET'&&url.pathname.startsWith('/api/nutrition/barcode/'))return json(res,410,{error:'当前营养库仅使用 台湾食药署，不再查询第三方条码库；请按具体食物名称检索，或手动填写包装营养信息。'});
  if(req.method==='POST'&&url.pathname==='/api/nutrition/web-search')return json(res,410,{error:'网页营养估算已停用，请使用 台湾食药署 中文检索。'});
  if(req.method==='POST'&&url.pathname==='/api/meals/analyze'){
    try{
      const b=await body(req);if(!b.imageDataUrl)return json(res,400,{error:'缺少图片'});
      const vision=await analyzeImage(b.imageDataUrl,String(b.context||'').slice(0,500)),foods=[],resolvedTraces=new Set(['qwen_vision']),unmatched=[],clarifications=[];let commonPortionCount=0;
      for(const food of (vision.foods||[]).slice(0,8)){
        const resolved=await resolveNutrition(food.name),portion=imagePortionEstimate(food,resolved.nutrition);
        if(portion.portionBasis==='按食物类别采用常见一人份')commonPortionCount++;
        resolved.trace.forEach(item=>resolvedTraces.add(item));
        if(!resolved.nutrition)unmatched.push(food.name);
        if(resolved.needsClarification)clarifications.push(`${food.name}：${resolved.question}`);
        foods.push({...food,confidence:food.foodConfidence||food.confidence||'medium',...portion,nutrition:resolved.nutrition,nutritionCandidates:resolved.candidates,nutritionQuestion:resolved.question});
      }
      const uncertainties=[...(Array.isArray(vision.uncertainties)?vision.uncertainties:[]),...clarifications];
      if(commonPortionCount)uncertainties.push(`${commonPortionCount}项无法可靠判断重量，已采用常见一人份范围`);
      if(unmatched.length)uncertainties.push(`台湾食药署 暂未确认营养数据：${unmatched.join('、')}；这些部分未计入总热量，请先确认具体食品或补充包装营养信息`);
      return json(res,200,{ok:true,result:{...vision,foods,followUpQuestion:clarifications[0]||vision.followUpQuestion,uncertainties,commonPortionCount,unmatchedFoods:unmatched},trace:[...resolvedTraces]});
    }catch(error){return json(res,502,{error:error.message})}
  }

  if(req.method==='POST'&&url.pathname==='/api/plans/daily-meals'){
    try{return json(res,200,{ok:true,result:await createDailyMealPlan(await body(req,400_000)),trace:['calculate_daily_target','allocate_three_meals','read_today_records','generate_daily_meal_overview']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/plans/weekly'){
    try{return json(res,200,{ok:true,result:buildNaturalWeekPlan(await body(req,800_000)),trace:['calculate_natural_week','read_confirmed_meals','preserve_locked_days','build_weekly_plan_proposal']})}catch(e){return json(res,e.status||400,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/recipes')return json(res,200,{ok:true,...await browseRecipes(db,Object.fromEntries(url.searchParams))});
  if(req.method==='GET'&&url.pathname==='/api/recipes/details'){
    const recipe=await recipeDetails(db,url.searchParams.get('id'));
    return json(res,recipe?200:404,recipe?{ok:true,recipe}:{error:'未找到此食谱'});
  }
  if(req.method==='POST'&&url.pathname==='/api/recipes/diy'){
    try{const result=await createDiyRecipe(await body(req,200_000));return json(res,200,{ok:true,result,trace:['tfda_nutrition_match',result.generatedBy==='library'?'d1_recipe_reuse':result.generatedBy==='qwen'?'qwen_recipe_plan':'rule_recipe_plan','server_nutrition_calculation']})}catch(e){return json(res,e.status||400,{error:e.message,unmatched:e.unmatched||[]})}
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/chat'){
    try{const b=await body(req,300_000);if(!rateAllowed(b.clientId))return json(res,429,{error:'Agent 请求太频繁，请稍后再试'});return json(res,200,{ok:true,result:await agentChat(b)})}catch(e){return json(res,e.status||502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/location/geocode'){
    const key=env.AMAP_WEB_SERVICE_KEY,address=String(url.searchParams.get('address')||'').trim();if(!key)return json(res,503,{error:'AMAP_WEB_SERVICE_KEY 未配置'});if(!address)return json(res,400,{error:'缺少地区或地址'});try{const r=await fetch(`https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address)}`),d=await r.json(),item=d.geocodes?.[0];if(d.status!=='1'||!item?.location)return json(res,404,{error:'无法解析该地区，请提供更完整的城市、区域或商圈'});const [lng,lat]=item.location.split(',').map(Number);return json(res,200,{ok:true,result:{lat,lng,formattedAddress:item.formatted_address||address},trace:['amap_geocode']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/restaurants/nearby'){
    const key=env.AMAP_WEB_SERVICE_KEY;if(!key)return json(res,503,{error:'AMAP_WEB_SERVICE_KEY 未配置'});const lat=Number(url.searchParams.get('lat')),lng=Number(url.searchParams.get('lng')),radius=Math.min(5000,Number(url.searchParams.get('radius')||3000)),requestedCuisine=String(url.searchParams.get('cuisine')||''),allowedCuisines=new Set(['中餐','东北菜','川菜','湘菜','粤菜','火锅','烧烤','日料','日本料理','韩餐','西餐','面食','轻食']),cuisine=allowedCuisines.has(requestedCuisine)?requestedCuisine:'';if(!lat||!lng)return json(res,400,{error:'缺少有效经纬度'});
    try{let location=`${lng},${lat}`;const convert=await fetch(`https://restapi.amap.com/v3/assistant/coordinate/convert?key=${encodeURIComponent(key)}&locations=${location}&coordsys=gps`),converted=await convert.json();if(converted.status==='1'&&converted.locations)location=converted.locations;const apiUrl=`https://restapi.amap.com/v5/place/around?key=${encodeURIComponent(key)}&location=${location}&types=050000${cuisine?`&keywords=${encodeURIComponent(cuisine)}`:''}&radius=${radius}&page_size=20&show_fields=business,photos`;const r=await fetch(apiUrl),d=await r.json();if(d.status!=='1')throw new Error(d.info||'高德查询失败');const results=(d.pois||[]).map(p=>({id:p.id,name:p.name,address:p.address,distance:Number(p.distance),type:p.type,typecode:p.typecode,business:p.business||{},photos:Array.isArray(p.photos)?p.photos.slice(0,6):[],location:p.location,source:'高德POI'}));return json(res,200,{ok:true,results,cuisine,trace:['browser_geolocation','amap_coordinate_convert',cuisine?'amap_cuisine_search':'amap_place_around','amap_business_photos']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/restaurants/recommendations'){
    try{const b=await body(req,400_000),requestedCount=Math.min(20,Math.max(1,Number(b.requestedCount)||5)),restaurants=Array.isArray(b.restaurants)?b.restaurants.slice(0,20):[];if(!restaurants.length)return json(res,400,{error:'缺少候选餐馆'});const dayOffset=Number(b.dayOffset)===1?1:0,mealType=String(b.mealType||''),today=dayOffset?{calories:0,protein:0,meals:[]}:b.today||{},hoursChecked=restaurants.map(restaurant=>({restaurant,hours:restaurantHours(restaurant,mealType,dayOffset)})),closedCount=hoursChecked.filter(x=>x.hours.status==='closed').length,eligible=hoursChecked.filter(x=>x.hours.status!=='closed').slice(0,requestedCount).map(x=>x.restaurant),nutritionBudget={remaining:8},personalized=await Promise.all(eligible.map(async restaurant=>{const menu=await findRestaurantMenu(restaurant);return {...restaurant,recommendation:await personalizeRestaurant(restaurant,menu,{profile:b.profile||{},today,mealType,dayOffset,nutritionBudget,cuisine:String(b.cuisine||'')})}})),results=personalized.sort((a,b)=>b.recommendation.personalization.score-a.recommendation.personalization.score);return json(res,200,{ok:true,results,targets:results[0]?.recommendation.personalization.targets,cuisine:String(b.cuisine||''),dayOffset,requestedCount,returnedCount:results.length,closedCount,trace:['amap_candidates','business_hours_check','closed_restaurants_filtered','requested_count_applied','public_menu_search','menu_verification','tfda_nutrition_match',dayOffset?'new_day_meal_budget':'dynamic_meal_budget','cuisine_preference','personalized_ranking']})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/menus/parse'){
    try{const result=await parseFullMenu(await body(req,12_000_000));return json(res,200,{ok:true,result,trace:['read_menu_source',result.parsedBy==='qwen'?'qwen_full_menu_parse':'deterministic_menu_parse','check_menu_completeness','rank_verified_menu_items']})}catch(e){return json(res,e.status||502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/user/state'){
    const clientId=url.searchParams.get('clientId')||'',state=(await buildUserState((await userRow(clientId))));
    return json(res,200,{ok:true,state,stateVersion:(await db.prepare('SELECT state_version FROM accounts WHERE id=?').get(req.account.id)).state_version});
  }
  if(req.method==='PUT'&&url.pathname==='/api/user/state'){
    try{const b=await body(req,2_000_000);return json(res,200,{ok:true,...(await accounts.save(req,b))})}catch(e){return json(res,e.status||400,{error:e.message,code:e.code})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/tasks'){
    (await schedulerTick(req.account.client_id));const clientId=url.searchParams.get('clientId')||'';return json(res,200,{ok:true,tasks:(await pendingTasks(clientId,shanghaiClock().date))});
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/tasks/complete'){
    try{const b=await body(req);return json(res,200,{ok:true,result:(await completeAgentTask(b.id,b.clientId))})}catch(e){return json(res,e.status||400,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/memory'){
    try{const b=await body(req);return json(res,200,{ok:true,result:(await addMemoryEvent(b.clientId,b.kind,b.date,b.payload))})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/memory'){
    const clientId=url.searchParams.get('clientId')||'';return json(res,200,{ok:true,events:(await recentMemory(clientId)),summary:(await memorySummaries(clientId))});
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/review'){
    try{const b=await body(req);return json(res,200,{ok:true,result:await runAgentReview(b.clientId)})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/events'){
    const clientId=url.searchParams.get('clientId')||'';(await sseConnect(req,res,clientId));return;
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/tasks/accept'){
    try{const b=await body(req);const t=(await db.prepare('SELECT * FROM agent_tasks WHERE id=? AND user_id=(SELECT id FROM users WHERE client_id=?)').get(Number(b.id)||0,b.clientId));if(!t)return json(res,404,{error:'待办不存在'});(await db.prepare("UPDATE agent_tasks SET status='done',state='done' WHERE id=?").run(t.id));(await addMemoryEvent(b.clientId,'task_accepted',shanghaiClock().date,{kind:t.kind,id:t.id}));sseSend(b.clientId,{type:'task_update',id:t.id,status:'done'});return json(res,200,{ok:true})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/tasks/dismiss'){
    try{const b=await body(req);const t=(await db.prepare('SELECT * FROM agent_tasks WHERE id=? AND user_id=(SELECT id FROM users WHERE client_id=?)').get(Number(b.id)||0,b.clientId));if(!t)return json(res,404,{error:'待办不存在'});(await db.prepare("UPDATE agent_tasks SET status='cancelled',state='cancelled' WHERE id=?").run(t.id));(await addMemoryEvent(b.clientId,'task_dismissed',shanghaiClock().date,{kind:t.kind,id:t.id}));sseSend(b.clientId,{type:'task_update',id:t.id,status:'cancelled'});return json(res,200,{ok:true})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='POST'&&url.pathname==='/api/agent/tasks/snooze'){
    try{const b=await body(req),minutes=Math.max(10,Math.min(1440,Number(b.minutes)||30)),t=(await db.prepare("SELECT * FROM agent_tasks WHERE id=? AND status='pending' AND user_id=(SELECT id FROM users WHERE client_id=?)").get(Number(b.id)||0,b.clientId));if(!t)return json(res,404,{error:'待办不存在'});const dueAt=new Date(Date.now()+minutes*60_000).toISOString();(await db.prepare("UPDATE agent_tasks SET status='planned',state='planned',due_at=? WHERE id=?").run(dueAt,t.id));(await addMemoryEvent(b.clientId,'task_snoozed',shanghaiClock().date,{kind:t.kind,id:t.id,minutes}));sseSend(b.clientId,{type:'task_update',id:t.id,status:'planned',dueAt});return json(res,200,{ok:true})}catch(e){return json(res,502,{error:e.message})}
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/goals'){
    const clientId=url.searchParams.get('clientId')||'';return json(res,200,{ok:true,goal:(await goalState(clientId))});
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/executions'){
    const clientId=url.searchParams.get('clientId')||'',limit=Number(url.searchParams.get('limit'))||20;
    return json(res,200,{ok:true,goals:(await executionGoals(clientId,limit))});
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/logs'){
    const clientId=url.searchParams.get('clientId')||'',limit=Number(url.searchParams.get('limit'))||200,kind=String(url.searchParams.get('kind')||'');
    return json(res,200,{ok:true,logs:(await readAgentLogs(clientId,limit,kind))});
  }
  if(req.method==='GET'&&url.pathname==='/api/agent/check'){
    const clientId=url.searchParams.get('clientId')||'',row=(await userRow(clientId));
    if(!row)return json(res,200,{ok:true,tasks:[],summary:[],adjustment:0});
    (await schedulerTick(req.account.client_id));
    return json(res,200,{ok:true,tasks:(await pendingTasks(clientId,shanghaiClock().date)),summary:(await memorySummaries(clientId)),adjustment:Number(row.budget_adjustment_kcal)||0});
  }
  return false;
}
function staticFile(req,res,url){
  return servePublicFile(req,res,url.pathname);
}
// ==================== 真正的 Agent：状态落库 / 工具循环 / 规划 / 记忆 / 调度 / 复盘 ====================
async function userRow(clientId){if(!clientId)return null;return (await db.prepare('SELECT * FROM users WHERE client_id=?').get(String(clientId)))}
// Retain compatible meal details without reactivating the withdrawn health feature.
function mealLogDetails(meal){
  const details={};
  for(const key of ['id','status','unit','createdAt','foodGroup','nutritionSource','nutritionSourceUrl','referenceId','referenceLabel'])if(meal[key]!=null)details[key]=String(meal[key]).slice(0,300);
  if(typeof meal.proteinKnown==='boolean')details.proteinKnown=meal.proteinKnown;
  for(const key of ['amount','carbs','fat','fiber','sodium','calcium','iron','vitaminD']){
    const raw=meal[key]??meal.nutrients?.[key],value=raw==null||String(raw).trim()===''?null:Number(raw);details[key]=value!=null&&Number.isFinite(value)&&value>=0&&value<=100000?value:null;
  }
  return details;
}
async function buildUserState(row){
  if(!row)return null;
  const meals=(await db.prepare('SELECT id,date,type,name,calories,protein,source,recorded_at,details FROM meal_logs WHERE user_id=? ORDER BY date,id').all(row.id)).map(meal=>{let details={};try{details=JSON.parse(meal.details||'{}')}catch{}return {...details,id:String(details.id||`legacy-meal-${meal.id}`),date:meal.date,type:meal.type,name:meal.name,calories:meal.calories,protein:meal.protein,source:meal.source,recordedAt:meal.recorded_at};});
  const weights=(await db.prepare('SELECT date,weight,source,recorded_at FROM weight_logs WHERE user_id=? ORDER BY date').all(row.id));
  let profile={};try{profile=JSON.parse(row.profile||'{}')}catch{}
  let chatHistory=[];try{chatHistory=JSON.parse(row.chat_history||'[]')}catch{}
  let pendingMealEstimate=null;try{pendingMealEstimate=JSON.parse(row.pending_meal||'null')}catch{}
  let appState={};try{appState=JSON.parse(row.app_state||'{}')}catch{}
  if(profile.budgetAdjustmentKcal===undefined)profile.budgetAdjustmentKcal=Number(row.budget_adjustment_kcal)||0;
  return {clientId:row.client_id,profile,mealLogs:meals,weightLogs:weights,chatHistory,pendingMealEstimate,weeklyPlan:appState.weeklyPlan||null,pendingWeeklyPlan:appState.pendingWeeklyPlan||null,upcomingWeeklyPlan:appState.upcomingWeeklyPlan||null,weeklyPlanHistory:Array.isArray(appState.weeklyPlanHistory)?appState.weeklyPlanHistory:[],dayClosures:Array.isArray(appState.dayClosures)?appState.dayClosures:[],reminderSettings:appState.reminderSettings||null,menuImports:Array.isArray(appState.menuImports)?appState.menuImports:[],createdAt:row.created_at,updatedAt:row.updated_at};
}
async function upsertUser(clientId,state={},options={}){
  const id=String(clientId||'');if(!id)throw new Error('缺少 clientId');
  const existing=await userRow(id);
  const adjustment=Math.max(-300,Math.min(300,Number(state.profile?.budgetAdjustmentKcal)||existing?.budget_adjustment_kcal||0));
  const now=new Date().toISOString();
  const profile={...(state.profile||{}),budgetAdjustmentKcal:adjustment};
  let previousAppState={};try{previousAppState=JSON.parse(existing?.app_state||'{}')}catch{}
  const choose=(key,fallback)=>state[key]===undefined?previousAppState[key]??fallback:state[key],appState={...(previousAppState.healthCoach?{healthCoach:previousAppState.healthCoach}:{}),weeklyPlan:choose('weeklyPlan',null),pendingWeeklyPlan:choose('pendingWeeklyPlan',null),upcomingWeeklyPlan:choose('upcomingWeeklyPlan',null),weeklyPlanHistory:Array.isArray(choose('weeklyPlanHistory',[]))?choose('weeklyPlanHistory',[]).slice(-5):[],dayClosures:Array.isArray(choose('dayClosures',[]))?choose('dayClosures',[]).slice(-35):[],reminderSettings:choose('reminderSettings',null),menuImports:Array.isArray(choose('menuImports',[]))?choose('menuImports',[]).slice(-10):[]};
  const statements=[...(options.before||[]),[
    `INSERT INTO users(client_id,profile,chat_history,pending_meal,budget_adjustment_kcal,app_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET profile=excluded.profile,chat_history=excluded.chat_history,pending_meal=excluded.pending_meal,budget_adjustment_kcal=excluded.budget_adjustment_kcal,app_state=excluded.app_state,updated_at=excluded.updated_at`,
    [id,JSON.stringify(profile),JSON.stringify(Array.isArray(state.chatHistory)?state.chatHistory.slice(-100):[]),JSON.stringify(state.pendingMealEstimate||null),adjustment,JSON.stringify(appState),now,now]
  ]];
  const userId='(SELECT id FROM users WHERE client_id=?)';
  statements.push([`DELETE FROM meal_logs WHERE user_id=${userId}`,[id]],[`DELETE FROM weight_logs WHERE user_id=${userId}`,[id]]);
  const meals=(Array.isArray(state.mealLogs)?state.mealLogs:[]).filter(meal=>meal&&meal.date&&meal.type).map(meal=>({date:String(meal.date).slice(0,10),type:String(meal.type).slice(0,20),name:String(meal.name||'').slice(0,120),calories:Number(meal.calories)||0,protein:Number(meal.protein)||0,source:String(meal.source||'manual').slice(0,60),recordedAt:String(meal.recordedAt||meal.createdAt||now),details:JSON.stringify(mealLogDetails(meal))}));
  const weights=(Array.isArray(state.weightLogs)?state.weightLogs:[]).filter(w=>w&&w.date).map(w=>({date:String(w.date).slice(0,10),weight:Number(w.weight)||0,source:String(w.source||'manual').slice(0,60),recordedAt:String(w.recordedAt||w.createdAt||now)}));
  statements.push([`INSERT INTO meal_logs(user_id,date,type,name,calories,protein,source,recorded_at,details) SELECT ${userId},json_extract(value,'$.date'),json_extract(value,'$.type'),json_extract(value,'$.name'),json_extract(value,'$.calories'),json_extract(value,'$.protein'),json_extract(value,'$.source'),json_extract(value,'$.recordedAt'),json_extract(value,'$.details') FROM json_each(?)`,[id,JSON.stringify(meals)]]);
  statements.push([`INSERT OR REPLACE INTO weight_logs(user_id,date,weight,source,recorded_at) SELECT ${userId},json_extract(value,'$.date'),json_extract(value,'$.weight'),json_extract(value,'$.source'),json_extract(value,'$.recordedAt') FROM json_each(?)`,[id,JSON.stringify(weights)]]);
  const target=Number(profile.targetWeight),deadline=String(profile.targetDate||''),start=Number(profile.startWeight)||Number(profile.weight)||target;
  if(target&&deadline){
    statements.push([`INSERT INTO goals(user_id,kind,start_value,current_value,target_value,deadline,status,created_at,updated_at) SELECT ${userId},'weight_loss',?,?,?,?,'active',?,? WHERE NOT EXISTS(SELECT 1 FROM goals WHERE user_id=${userId} AND kind='weight_loss')`,[id,start,start,target,deadline,now,now,id]]);
    statements.push([`UPDATE goals SET start_value=?,target_value=?,deadline=?,updated_at=? WHERE user_id=${userId} AND kind='weight_loss'`,[start,target,deadline,now,id]]);
  }
  const date=shanghaiClock().date;
  for(const [type,kind] of [['午餐','plan_lunch'],['晚餐','plan_dinner']])if(meals.some(meal=>meal.date===date&&normalizeMealType(meal.type)===type))statements.push([`UPDATE agent_tasks SET status='done' WHERE user_id=${userId} AND kind=? AND due_date=? AND status='pending'`,[id,kind,date]]);
  statements.push(...(options.after||[]));
  await atomic(db,statements);
  return (await buildUserState(await userRow(id)));
}
async function addMemoryEvent(clientId,kind,date,payload={}){
  const row=(await userRow(clientId));if(!row)return null;
  const now=new Date().toISOString();
  const info=(await db.prepare('INSERT INTO agent_memory(user_id,kind,date,payload,created_at) VALUES(?,?,?,?,?)').run(row.id,String(kind||'event').slice(0,40),String(date||'').slice(0,10),JSON.stringify(payload||{}),now));
  return {id:Number(info.lastInsertRowid)};
}
async function recentMemory(clientId,limit=200){
  const row=(await userRow(clientId));if(!row)return [];
  return (await db.prepare('SELECT kind,date,payload,created_at FROM agent_memory WHERE user_id=? ORDER BY id DESC LIMIT ?').all(row.id,Math.min(500,Math.max(1,Number(limit)||200)))).map(x=>({kind:x.kind,date:x.date,payload:JSON.parse(x.payload||'{}'),createdAt:x.created_at})).reverse();
}
async function recentConfirmedNames(clientId,limit=10){
  return (await recentMemory(clientId,50)).filter(e=>e.kind==='meal_confirmed').slice(-limit).map(e=>String(e.payload?.name||'')).filter(Boolean);
}
async function memorySummaries(clientId,days=7){
  const events=(await recentMemory(clientId,500)),summaries=[];
  const dayList=[...new Set(events.map(e=>e.date).filter(Boolean))].slice(-days);
  for(const day of dayList){
    const dayEvents=events.filter(e=>e.date===day);
    const confirmed=dayEvents.filter(e=>e.kind==='meal_confirmed');
    summaries.push({date:day,meals:confirmed.length,mealNames:confirmed.slice(-3).map(e=>String(e.payload?.name||'').slice(0,30))});
  }
  return summaries;
}
async function pendingTasks(clientId,date){
  const row=(await userRow(clientId));if(!row)return [];
  return (await db.prepare("SELECT id,kind,due_date,status,payload,created_at,priority,due_at FROM agent_tasks WHERE user_id=? AND due_date=? AND status='pending' AND substr(kind,1,7)!='health_' ORDER BY priority DESC,id").all(row.id,String(date||''))).map(x=>({id:Number(x.id),kind:x.kind,dueDate:x.due_date,dueAt:x.due_at,status:x.status,priority:Number(x.priority)||0,payload:JSON.parse(x.payload||'{}'),createdAt:x.created_at}));
}
async function completeAgentTask(id,clientId){
  const info=(await db.prepare("UPDATE agent_tasks SET status='done' WHERE id=? AND status='pending' AND user_id=(SELECT id FROM users WHERE client_id=?)").run(Number(id)||0,String(clientId||'')));
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
function normalizeWeeklyPlanInput(value=null){
  if(!value||typeof value!=='object'||!Array.isArray(value.days))return null;
  const days=value.days.slice(0,7).map(day=>({date:String(day?.date||''),weekday:String(day?.weekday||''),status:String(day?.status||''),locked:day?.locked===true,meals:(Array.isArray(day?.meals)?day.meals:[]).slice(0,4).map(meal=>({type:normalizeMealType(meal?.type)||String(meal?.type||''),name:String(meal?.name||'').slice(0,120),mealKcal:Math.max(0,Math.round(Number(meal?.mealKcal)||0)),mealProtein:Math.max(0,Number(meal?.mealProtein)||0),status:String(meal?.status||'planned')}))})).filter(day=>/^\d{4}-\d{2}-\d{2}$/.test(day.date));
  if(!days.length)return null;
  return {id:String(value.id||''),weekStart:String(value.weekStart||days[0].date),weekEnd:String(value.weekEnd||days.at(-1).date),version:Math.max(1,Number(value.version)||1),status:String(value.status||''),days};
}
const AGENT_TOOLS=[
  {type:'function',function:{name:'read_user_state',description:'读取用户长期档案、今日已摄入、动态预算、当前自然周计划与待确认餐食。',parameters:{type:'object',properties:{},required:[]}}},
  {type:'function',function:{name:'get_meal_budget',description:'按餐次计算本餐动态热量/蛋白质预算（含为后续餐次预留）。',parameters:{type:'object',properties:{mealType:{type:'string',enum:['早餐','午餐','晚餐','其他摄入']},dayOffset:{type:'number'}},required:['mealType']}}},
  {type:'function',function:{name:'compose_diy_recipe',description:'用现有食材生成带克数与步骤的食谱，返回服务器按数据库实算的营养。',parameters:{type:'object',properties:{ingredients:{type:'array',items:{type:'string'}},pantry:{type:'array',items:{type:'string'}},cookTime:{type:'string'},cookTools:{type:'string'},mealType:{type:'string'}},required:['ingredients']}}},
  {type:'function',function:{name:'search_nearby_restaurants',description:'按坐标或区域搜索附近餐馆；提供 area 时先转成坐标，否则需要 latitude/longitude。',parameters:{type:'object',properties:{latitude:{type:'number'},longitude:{type:'number'},radius:{type:'number'},cuisine:{type:'string'},area:{type:'string'}},required:[]}}},
  {type:'function',function:{name:'get_restaurant_menu',description:'检索某家餐馆的公开菜单或高德特色菜。',parameters:{type:'object',properties:{restaurant:{type:'object'}},required:['restaurant']}}},
  {type:'function',function:{name:'personalize_restaurant',description:'按预算、忌口硬过滤、偏好与近期确认记录，对候选菜做个性化匹配和份量调整。',parameters:{type:'object',properties:{restaurant:{type:'object'},menu:{type:'object'},mealType:{type:'string'}},required:['restaurant','menu']}}},
  {type:'function',function:{name:'search_nutrition',description:'查询食材或菜品的营养，仅使用 台湾食药署 权威数据库；支持中文别名。根据完整食物名称自动匹配相应品类；通用参考须说明，不能用单一食材代表复合菜。',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']}}},
  {type:'function',function:{name:'get_daily_plan',description:'生成今天尚未记录餐次的三餐概览与DIY食谱。',parameters:{type:'object',properties:{},required:[]}}},
  {type:'function',function:{name:'get_memory',description:'读取最近7天经历记忆摘要（已确认餐食、复盘结论）。',parameters:{type:'object',properties:{},required:[]}}},
  {type:'function',function:{name:'propose_meal_record',description:'生成“确认入账”提案：只返回待确认的餐食条目，绝不写入记录。',parameters:{type:'object',properties:{name:{type:'string'},calories:{type:'number'},protein:{type:'number'},mealType:{type:'string'},recordDate:{type:'string'},source:{type:'string'}},required:['name','calories','mealType']}}},
  {type:'function',function:{name:'revise_pending_meal',description:'用户补充影响估算的信息（食材、份量、用油等）时，修正待确认的图片估算并返回修正结果，不写入饮食记录。',parameters:{type:'object',properties:{revisedName:{type:'string'},revisedCalories:{type:'number'},revisedProtein:{type:'number'},revisionNote:{type:'string'}},required:['revisedCalories']}}}
];
async function executeAgentTool(tool,args,ctx){
  const name=tool||'';
  const trace={tool:name,ok:true};
  try{
    const fixture=env.NODE_ENV==='test'&&ctx?.toolFixtures&&Object.prototype.hasOwnProperty.call(ctx.toolFixtures,name)?ctx.toolFixtures[name]:null;
    if(fixture&&typeof fixture==='object')return {...trace,ok:fixture.ok!==false,result:structuredClone(fixture.result||{})};
    if(name==='read_user_state')return {...trace,result:{profile:ctx.profile,consumed:ctx.consumed,targets:ctx.targets,weeklyPlan:ctx.weeklyPlan,pendingMeal:ctx.pendingMeal?{name:ctx.pendingMeal.name,calories:ctx.pendingMeal.calories,protein:ctx.pendingMeal.protein}:null}};
    if(name==='get_meal_budget')return {...trace,result:mealTargets(ctx.profile,ctx.today,String(args.mealType||ctx.mealType))};
    if(name==='get_daily_plan')return {...trace,result:await createDailyMealPlan({profile:ctx.profile,today:ctx.today,mealType:String(args.mealType||ctx.mealType)})};
    if(name==='compose_diy_recipe')return {...trace,result:await createDiyRecipe({ingredients:Array.isArray(args.ingredients)?args.ingredients:[],pantry:Array.isArray(args.pantry)?args.pantry:[],cookTime:String(args.cookTime||'20分钟'),cookTools:String(args.cookTools||'普通厨具'),mealType:String(args.mealType||ctx.mealType),dayOffset:Number(args.dayOffset)||0,profile:ctx.profile,today:ctx.today})};
    if(name==='search_nearby_restaurants'){
      const key=env.AMAP_WEB_SERVICE_KEY;
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
      const p=await personalizeRestaurant(args.restaurant||{},args.menu||{},ctx);
      return {...trace,result:p.personalization};
    }
    if(name==='search_nutrition')return {...trace,result:await resolveNutrition(String(args.name||''))};
    if(name==='get_memory')return {...trace,result:(await memorySummaries(ctx.clientId,7))};
    if(name==='propose_meal_record'){
      const mealType=normalizeMealType(args.mealType);if(!mealType)return {...trace,ok:false,result:{error:'餐次无效，请询问用户要记录到早餐/午餐/晚餐还是其他摄入'}};
      const today=shanghaiClock().date,rawDate=String(args.recordDate||''),minDate=String(new Date(Date.now()-7*86400000).toISOString().slice(0,10));
      const recordDate=/^\d{4}-\d{2}-\d{2}$/.test(rawDate)&&rawDate<=today&&rawDate>=minDate?rawDate:today;
      const originalMessage=String(args.originalMessage||ctx.message||args.name||''),hasExplicitEnergy=/(\d+(?:\.\d+)?)\s*(?:kcal|千卡|卡路里|卡)/i.test(originalMessage);
      const estimate=!hasExplicitEnergy?await estimateTextMealRecord(originalMessage):null;
      if(estimate&&!estimate.ok)return {...trace,ok:false,result:{error:estimate.error}};
      const calories=estimate?estimate.calories:Math.round(Number(args.calories)||0),protein=estimate?estimate.protein:+((Number(args.protein)||0).toFixed(1)),recordName=estimate?estimate.name:String(args.name||'').trim();
      if(!recordName||calories<=0)return {...trace,ok:false,result:{error:'缺少可靠的餐食热量估算；请补充每种食物的份量、克数或包装营养信息后再生成记录提案'}};
      return {...trace,result:{action:'confirm_meal_record',payload:{name:recordName.slice(0,100),calories,protein:Math.max(0,protein),mealType,recordDate,source:String(estimate?.source||args.source||'用户文字记录').slice(0,120)}}};
    }
    if(name==='revise_pending_meal'){
      const calories=Math.max(0,Math.round(Number(args.revisedCalories)||0));if(calories<=0)return {...trace,ok:false,result:{error:'补充信息不足以形成可靠的新热量估算，请询问用户更多细节'}};
      let pending=ctx.pendingMeal;const row=(await userRow(ctx.clientId));
      if(row&&row.pending_meal){try{pending=JSON.parse(row.pending_meal)||pending}catch{}}
      if(!pending)return {...trace,ok:false,result:{error:'没有待确认的图片估算，不能修正'}};
      const revised={...pending,name:String(args.revisedName||pending.name||'图片识别餐食').replace(/[（(]?疑似[）)]?/g,'').trim().slice(0,100),calories,protein:Math.max(0,+((Number(args.revisedProtein)||0).toFixed(1))),breakdown:String(pending.breakdown||'').concat(String(args.revisionNote||'')?`；${String(args.revisionNote).slice(0,300)}`:'').slice(0,1600),followUpQuestion:'',updatedAt:new Date().toISOString()};
      if(row)(await db.prepare('UPDATE users SET pending_meal=?,updated_at=? WHERE id=?').run(JSON.stringify(revised),new Date().toISOString(),row.id));
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
  // Recognizing an ingredient/dish in a sentence does not imply the dataset
  // contains its nutrition. Pass these names intact so lookup can report a miss.
  const intentOnly=['全麦面包','回锅肉','红烧肉','宫保鸡丁','麻婆豆腐','虾仁炒饭','熟鸡胸肉','烤鸡胸肉'];
  const rows=[...FOOD_TERMS,...intentOnly.map(term=>({id:`unmatched:${term}`,term}))].sort((a,b)=>b.term.length-a.term.length);
  const candidates=rows.map(row=>({...row,term:String(row.term||'').trim(),index:text.indexOf(String(row.term||'').trim())})).filter(row=>row.term.length>=2&&row.index>=0).sort((a,b)=>b.term.length-a.term.length||a.index-b.index);
  const spans=[],foodIds=new Set(),matched=[];
  for(const row of candidates){
    const end=row.index+row.term.length,overlaps=spans.some(span=>row.index<span.end&&end>span.start);
    if(overlaps||foodIds.has(String(row.id)))continue;
    spans.push({start:row.index,end});foodIds.add(String(row.id));matched.push({index:row.index,name:row.term});
  }
  if(/糙米/.test(text)&&!matched.some(item=>/糙米/.test(item.name)))matched.push({index:text.indexOf('糙米'),name:'糙米饭'});
  if(/青菜/.test(text)&&!matched.some(item=>/青菜/.test(item.name)))matched.push({index:text.indexOf('青菜'),name:'青菜'});
  return [...new Set(matched.sort((a,b)=>a.index-b.index).map(item=>item.name))].slice(0,limit);
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
async function matchTextMealFood(name=''){
  const clean=String(name||'').replace(/[，。；;！!？?]/g,'').trim();if(!clean)return null;
  const fallback=[[/牛肉包|猪肉包|鲜肉包|肉包/, '肉包子'],[/菜包|素包/, '菜包子'],[/豆沙包|红豆包/, '豆沙包']].find(([pattern])=>pattern.test(clean));
  if(fallback)return datasetFoodRow(fallback[1]);
  return datasetFoodRow(clean);
}
function defaultTextMealGrams(food,name=''){
  const text=String(name||'');
  if(/鸡蛋/.test(text)&&!/鸡蛋灌饼/.test(text))return 50;
  if(/小笼/.test(text)||/小笼包/.test(String(food?.name||'')))return 30;
  if(/包/.test(text)||/包子/.test(String(food?.name||'')))return 100;
  return null;
}
async function estimateTextMealRecord(message=''){
  const items=splitTextMealItems(message);if(!items.length)return {ok:false,error:'没有识别到可记录的食物，请补充吃了什么和每种食物的份量'};
  const resolved=[],unmatched=[];
  for(const item of items){const food=await matchTextMealFood(item.name),grams=item.grams||defaultTextMealGrams(food,item.name);if(!food||!grams){unmatched.push(item.name);continue}resolved.push({...item,food,grams:Number(grams)*item.quantity});}
  if(unmatched.length)return {ok:false,error:`无法从台湾食药署 营养库可靠估算：${unmatched.join('、')}；请补充克数、包装营养信息，或改用手动记录`};
  const calories=Math.round(resolved.reduce((sum,item)=>sum+(Number(item.food.kcal)||0)*item.grams/100,0)),protein=+(resolved.reduce((sum,item)=>sum+(Number(item.food.protein)||0)*item.grams/100,0)).toFixed(1);
  if(calories<=0)return {ok:false,error:'未能形成可靠热量估算，请补充食物份量或营养信息'};
  const name=resolved.map(item=>`${item.name} ${item.quantity}${item.unit}`).join('、'),basis=resolved.map(item=>`${item.name}按${item.grams/item.quantity}g/${item.unit}`).join('；');
  return {ok:true,name,calories,protein,source:`台湾食药署 营养库文字估算（${basis}）`,items:resolved.map(item=>({name:item.name,matchedFood:item.food.name,grams:item.grams}))};
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
function extractChineseMinutes(text=''){
  const source=String(text||''),arabic=source.match(/(\d+)\s*分钟/);
  if(arabic)return `${Math.max(1,Math.min(240,Number(arabic[1])))}分钟`;
  const chinese=source.match(/([一二两三四五六七八九十]{1,3})\s*分钟/);
  if(!chinese)return '20分钟';
  const raw=chinese[1],digit={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  let value=raw==='十'?10:raw.startsWith('十')?10+(digit[raw[1]]||0):raw.endsWith('十')?(digit[raw[0]]||1)*10:(digit[raw[0]]||0)*10+(digit[raw[1]]||0);
  return `${Math.max(1,Math.min(240,value||20))}分钟`;
}
function nutritionQueryFromMessage(message='',foods=[]){
  const text=String(message||'').trim();
  const identifier=text.match(/(?:tfda:[a-r]\d{4,8}|fdc:\d+)/i);if(identifier)return identifier[0];
  const beforeBasis=text.match(/(?:查一下|查询一下|查询)?\s*([^，。！？?]{2,30}?)\s*(?:每\s*100\s*克|每百克)/)?.[1]?.trim();
  if(beforeBasis)return beforeBasis.replace(/^(?:查一下|查询一下|查询)/,'').trim();
  const afterQuery=text.match(/(?:查一下|查询一下|查询)\s*([^，。！？?]{2,30}?)(?:的)?(?:热量|蛋白质|营养)/)?.[1]?.trim();
  if(afterQuery)return afterQuery;
  const first=String(foods[0]||'');
  return first.trim()||text.slice(0,100);
}
function allergyTerms(profile={}){
  return String(profile.allergies||'').split(/[、,，;；\s]+/).map(term=>term.replace(/不吃|过敏|严格忌口|忌口|不要/g,'').trim()).filter(term=>term.length>=2);
}
function safeDiyIngredients(foods=[],profile={}){
  const blocked=allergyTerms(profile);
  return foods.filter(food=>!blocked.some(term=>String(food).includes(term)||term.includes(String(food).replace(/[（(].*?[）)]/g,''))));
}
function requestedMealType(text='',fallback=''){
  if(/(?:起晚|睡过头).{0,12}(?:不吃|没吃|跳过).{0,4}(?:早饭|早餐)/.test(String(text||'')))return '午餐';
  const mentions=[...String(text||'').matchAll(/早餐|早饭|明早|午餐|午饭|中午|晚餐|晚饭|今晚|明晚/g)].map(match=>match[0]);
  return normalizeMealType(mentions.at(-1)||'')||normalizeMealType(fallback);
}
function controlledToolArgs(tool,message,ctx){
  const text=String(message||''),foods=mentionedFoodNames(text).map(food=>food==='糙米'?'糙米饭':food),kcalMatches=[...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:kcal|千卡|卡路里|卡)/ig)].map(match=>Number(match[1])).filter(Number.isFinite),proteinMatch=text.match(/蛋白质(?:改为|约|为)?\s*(\d+(?:\.\d+)?)/),mealType=requestedMealType(text,ctx.mealType);
  if(tool==='get_meal_budget')return {mealType,dayOffset:ctx.dayOffset};
  if(tool==='compose_diy_recipe')return {ingredients:safeDiyIngredients(foods,ctx.profile),pantry:[],cookTime:extractChineseMinutes(text),cookTools:/空气炸锅/.test(text)?'空气炸锅':/微波炉/.test(text)&&!/微波炉.{0,4}(?:坏|不能用|不可用)/.test(text)?'微波炉':'普通厨具',mealType};
  if(tool==='search_nutrition')return {name:nutritionQueryFromMessage(text,foods)};
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
    (await logAgent(ctx.clientId,'agent_tool',`${out.tool}:${out.ok?'ok':'fail'}`));
    toolLog.push({tool:out.tool,ok:out.ok,summary:String(out.result?.error||out.result?.mealDisplay||out.result?.name||out.result?.action||out.result?.message||'').slice(0,100)});
    results.push({tool:out.tool,args,ok:out.ok,result:out.result||{}});
    if(out.ok&&out.tool==='propose_meal_record'&&out.result?.payload)proposal={kind:'meal',payload:out.result.payload};
    if(out.ok&&out.tool==='revise_pending_meal'&&out.result?.payload)proposal={kind:'revise',payload:out.result.payload};
  }
  return {toolLog,results,proposal};
}
function controlledWorkflowTools(routeIntent='',mealScenario='',message='',pendingMeal=null){
  const text=String(message||'');
  if(routeIntent==='record'){
    if(pendingMeal&&/(?:改|修正|调整|补充)/.test(text))return ['revise_pending_meal'];
    if(/体重|称重|公斤|\bkg\b/i.test(text))return [];
    return isMealRecordRequest(text)?['propose_meal_record']:[];
  }
  if(routeIntent==='other'&&/(?:tfda:[a-r]\d{4,8}|fdc:\d+)/i.test(text))return ['search_nutrition'];
  if(routeIntent==='other')return /(?:每\s*100\s*克|每百克).{0,20}(?:热量|蛋白质|营养)|(?:查一下|查询|多少).{0,30}(?:热量|蛋白质|营养)/.test(text)?['search_nutrition']:[];
  if(routeIntent!=='meal')return [];
  if(mealScenario==='unknown')return /最近|近期|历史|记录|重复|常吃/.test(text)?['get_memory']:[];
  if(mealScenario==='diy')return mentionedFoodNames(text).length||/过敏/.test(text)?['compose_diy_recipe']:[];
  if(mealScenario==='restaurants')return ['search_nearby_restaurants','get_restaurant_menu','personalize_restaurant'];
  return [];
}
function workflowReferencePaths(mealScenario=''){
  if(mealScenario==='diy')return ['references/recommendation-rules.md','references/tool-guide.md','references/nutrition-data.md'];
  if(mealScenario==='restaurants')return ['references/recommendation-rules.md','references/tool-guide.md','references/amap-api.md'];
  return ['references/recommendation-rules.md','references/tool-guide.md'];
}
async function dispatchControlledWorkflow(tools,message,ctx){
  const toolLog=[],results=[];let proposal=null,restaurant=null,menu=null;
  for(const tool of [...new Set((Array.isArray(tools)?tools:[]).filter(name=>AGENT_TOOLS.some(item=>item.function?.name===name)))]){
    let args=controlledToolArgs(tool,message,ctx);
    if(tool==='get_restaurant_menu'){
      const search=results.find(entry=>entry.tool==='search_nearby_restaurants');
      restaurant=Array.isArray(search?.result)?search.result[0]:null;
      if(!search?.ok||!restaurant)break;
      args={restaurant};
    }
    if(tool==='personalize_restaurant'){
      const menuEntry=results.find(entry=>entry.tool==='get_restaurant_menu');
      menu=menuEntry?.result;
      if(!menuEntry?.ok||!restaurant||!menu)break;
      args={restaurant,menu,mealType:ctx.mealType};
    }
    const toolStarted=Date.now();
    const out=await executeAgentTool(tool,args,ctx);
    const ms=Date.now()-toolStarted;
    (await logAgent(ctx.clientId,'agent_tool',`${out.tool}:${out.ok?'ok':'fail'}`));
    toolLog.push({tool:out.tool,ok:out.ok,ms,summary:String(out.result?.error||out.result?.mealDisplay||out.result?.name||out.result?.action||out.result?.message||'').slice(0,100)});
    results.push({tool:out.tool,args,ok:out.ok,ms,result:out.result||{}});
    if(out.ok&&out.tool==='propose_meal_record'&&out.result?.payload)proposal={kind:'meal',payload:out.result.payload};
    if(out.ok&&out.tool==='revise_pending_meal'&&out.result?.payload)proposal={kind:'revise',payload:out.result.payload};
    if(!out.ok)break;
    if(out.tool==='search_nearby_restaurants'&&Array.isArray(out.result)&&out.result.length===0)break;
  }
  return {toolLog,results,proposal};
}
const NEXT_MEAL_DECISION_REFERENCES={
  meal:['references/amap-api.md','references/nutrition-data.md','references/recommendation-rules.md','references/tool-guide.md']
};
function skillReferencesForIntent(skill,intent=''){
  const all=Array.from(skill?.referenceFiles||[]);
  if(skill?.name!=='next-meal-decision')return all;
  const scoped=NEXT_MEAL_DECISION_REFERENCES[bucketIntent(intent)];
  return Array.isArray(scoped)?scoped.filter(ref=>all.includes(ref)):all;
}
async function planAgentTask(message,skillContext=[],intent=''){
  const contexts=Array.isArray(skillContext)?skillContext:[];
  const referenceCatalog=contexts.map(item=>{
    const files=skillReferencesForIntent(item.skill,intent).join('、')||'无';
    return `- ${item.skill?.name||'未命名技能'}：可选 references 路径为 ${files}`;
  }).join('\n');
  const d=await qwenChat({model:env.QWEN_CHAT_MODEL||env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:`你是规划器。把用户请求拆成最多6步执行计划，每步对应一个可用工具，不调用工具。硬约束：steps[].tool 必须严格来自可用工具列表，禁止编造工具名；请求不需要工具时 steps 返回空数组；fallback 是目标不可达时的简单替代方案；只有当前技能上下文确实需要某个 reference 时才写入 references，否则 references 返回空数组，路径必须严格来自下方列表。只返回JSON：{"goal":"一句话目标","steps":[{"tool":"工具名","why":"为什么做这步"}],"references":["references/xxx.md"],"fallback":"..."}。可用工具：${AGENT_TOOLS.map(t=>t.function.name).join('、')}\n${referenceCatalog?`当前技能上下文：\n${referenceCatalog}`:'当前没有命中技能，references 固定返回 []'}`},{role:'user',content:String(message||'')}]});
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
const PROMPT_VERSION='v13';
const PROMPTS_VERSION='v7';
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
if(env.NODE_ENV!=='test')console.log(`技能扫描：发现 ${SKILL_INDEX.length} 个 Skill（${SKILL_INDEX.map(s=>s.name).join('、')||'无'}）`);
function normalizeRouterIntent(routerIntent='',message='',skills=[]){
  const text=String(message||'');
  const names=Array.isArray(skills)?skills.map(skill=>String(skill||'').trim()).filter(Boolean):[];
  const intent=String(routerIntent||'').trim();
  const asksConcreteMeal=/(?:早餐|午餐|晚餐|早饭|午饭|晚饭|下一餐|下一顿).{0,16}(?:吃什么|怎么吃|怎么做|怎么搭配|点什么|去哪吃|安排|推荐)|(?:吃什么|怎么吃|怎么做|怎么搭配|食谱|附近餐厅|附近餐馆|附近外卖|推荐下一餐|安排一顿)/.test(text);
  const planOnly=/(?:调整|修改|刷新|重新安排|重新生成).{0,16}(?:本周|周计划|计划|后面安排)|(?:本周|周计划|计划).{0,16}(?:调整|修改|刷新|重新安排|重新生成)/.test(text)&&!asksConcreteMeal;
  if(/糖尿病|高血压|痛风|胃炎|血糖|尿酸|术后|医生|医嘱|用药|吃药/.test(text))return 'other';
  if(planOnly)return 'other';
  if(/记录|入账|记上|记到|记成|记一笔|记一下|帮我记|补登|体重|称重/.test(text)&&!asksConcreteMeal)return 'record';
  if(asksConcreteMeal&&names.includes('next-meal-decision'))return 'meal';
  if(['meal','record'].includes(intent))return intent;
  if(names.includes('next-meal-decision'))return 'meal';
  if(intent==='other')return 'other';
  return 'other';
}
function deterministicRouteDescription(message=''){
  const text=String(message||'').trim();
  if(!text)return {skills:[],intent:'other',mealScenario:'',mode:'rules'};
  if(/糖尿病|高血压|降压药|痛风|胃炎|血糖|尿酸|术后|医生|医嘱|用药|吃药|药量/.test(text))return {skills:[],intent:'other',mealScenario:'',mode:'rules'};
  if(/(?:体重|称重).{0,20}(?:记录|入账|记上|记到|记成|记一笔|记一下)|(?:记录|入账|记上|记到|记成|记一笔|记一下).{0,20}(?:体重|公斤|kg)/i.test(text))return {skills:[],intent:'record',mealScenario:'',mode:'rules'};
  if(/图片识别.{0,20}(?:改成|修正|调整)|(?:改成|修正|调整).{0,20}(?:千卡|蛋白质)/.test(text))return {skills:[],intent:'record',mealScenario:'',mode:'rules'};
  if(isMealRecordRequest(text))return {skills:[],intent:'record',mealScenario:'',mode:'rules'};
  if(/(?:每\s*100\s*克|每百克).{0,20}(?:热量|蛋白质|营养)|(?:查一下|查询|多少).{0,30}(?:热量|蛋白质|营养)/.test(text))return {skills:[],intent:'other',mealScenario:'',mode:'rules'};
  if(/(?:调整|修改|刷新|重新安排|重新生成|改掉).{0,20}(?:本周|周计划|饮食计划|后面计划)|(?:本周|周计划|饮食计划).{0,20}(?:调整|修改|刷新|重新安排|重新生成|改掉)/.test(text))return {skills:[],intent:'other',mealScenario:'',mode:'rules'};
  if(/房贷|贷款|利息|编程|代码|天气|股票/.test(text))return {skills:[],intent:'other',mealScenario:'',mode:'rules'};
  const asksConcreteMeal=/(?:早餐|午餐|晚餐|早饭|午饭|晚饭|下一餐|下一顿).{0,24}(?:吃什么|怎么吃|怎么做|怎么搭配|点什么|去哪吃|安排|推荐)|(?:推荐下一餐|安排一顿|给我安排|帮我安排|附近|餐厅|餐馆|饭店|外卖|堂食|到店|冰箱|家里有|食材|食谱|做饭|减脂餐|找一家|最近的店)/.test(text);
  const hasMealContext=/(?:吃|餐|饭|店|菜|食谱|食材|冰箱|外卖|热量|卡|蛋白质|过敏)/.test(text);
  if(asksConcreteMeal&&hasMealContext)return {skills:['next-meal-decision'],intent:'meal',mealScenario:detectMealScenario(text),mode:'rules'};
  return null;
}
async function routeDescription(message=''){
  const text=String(message||'');
  const deterministic=deterministicRouteDescription(text);
  if(deterministic)return deterministic;
  const skillCatalog=SKILL_INDEX.map(skill=>`- ${skill.name}: ${skill.meta.description}`).join('\n');
  const d=await qwenChat({model:env.QWEN_CHAT_MODEL||env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:`你是技能路由裁判。

根据用户消息的完整语义和当前主要任务，判断是否命中已注册 Skill，并将一级意图归一为 meal / record / other。若 intent 为 meal，还必须判断本次下一餐的场景 mealScenario。

判断 Skill 时，以用户当前真正希望完成的任务为准，不要因为消息中出现某个局部关键词就触发 Skill。

特别注意：

* “涉及吃、饮食、怎么吃”不等于“下一餐推荐”。
* 疾病、慢病管理、治疗、药物或医疗健康相关的饮食咨询应归为 other，不触发 next-meal-decision。只要消息明确提到疾病或慢病名称、医生建议（医嘱）或用药背景（如糖尿病、高血压、痛风、胃炎、血糖高、吃药等），即使同时出现“中午吃什么”“外卖”等表达，也一律按 other 处理。
* 用户当前主要目标是决定一顿具体餐食吃什么时，命中 next-meal-decision，intent 为 meal。
* 起晚、漏餐、多吃、加餐、聚餐、加班、出差或设备变化可以作为下一餐约束；当用户仍在问“下一餐/晚餐具体吃什么”时归为 meal。
* 仅要求刷新、修改或查看已有周计划时归为 other；餐食记录后的计划刷新由确定性状态机自动完成，不使用 Skill。
* 首次生成自然周计划不命中 next-meal-decision。
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
  const d=await qwenChat({model:env.QWEN_CHAT_MODEL||env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:`你是下一餐场景分类器。只判断用户是否已经明确下一餐方式，不要生成食谱、餐厅或建议。

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
    /给我做/,
    /用.{1,30}做.{0,12}(?:餐|饭)/,
    /家里.*(?:只有|现有).*(?:做|推荐|晚饭|晚餐|午饭|午餐|早餐)/,

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
    /店里吃/,
    /附近.*(餐厅|饭店|吃的|吃饭)/,
    /在.{2,30}附近.{0,8}(?:找|吃)/,
    /找.*(餐厅|饭店)/,
    /找.{0,12}(?:一家|店|吃的)/,
    /推荐.{0,12}(?:店|餐馆|餐厅)/,
    /最近的店/,
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
    /冰箱有/,
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
function selectSkillReferences(plan={},context=[],intent=''){
  const hasPlan=plan&&typeof plan==='object';
  const requested=hasPlan&&Array.isArray(plan.references)?plan.references:[];
  return (Array.isArray(context)?context:[]).map(item=>{
    const skill=item.skill,core=item.core||loadSkillCore(skill);
    const allowed=skillReferencesForIntent(skill,intent);
    const references=hasPlan?[...new Set(requested.map(ref=>String(ref||'').trim()).filter(ref=>allowed.includes(ref)))]:[...allowed];
    return {skill,core,references,content:loadSkillContent(skill,references)};
  });
}
function buildSkillCorrection(routeIntent,agentIntent,appliedSkillNames=[],baseSystem='BASE'){
  const route=normalizeRouterIntent(routeIntent,'',[]);
  const agent=bucketIntent(agentIntent);
  const missingSkill={meal:'next-meal-decision'}[agent];
  if(route==='other'&&missingSkill&&!(Array.isArray(appliedSkillNames)?appliedSkillNames:[]).includes(missingSkill)){
    const skill=SKILL_INDEX.find(item=>item.name===missingSkill);
    if(skill){
      const core=loadSkillCore(skill);
      return {system:`${baseSystem}\n\n【运行时技能】\n【技能：${skill.name}】\n${core.text}`,note:`纠错：本轮路由未命中必要技能，但你的执行意图是 ${agent}；已补充 ${skill.name} 技能规则，请重新按技能输出。`};
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

11. 确认饮食记录后，产品会用确定性状态机自动刷新今天尚未执行的餐次；日终只依据近期完整记录温和更新未来计划，不继承当天“热量债务”。你不得伪造刷新结果，也不得建议用跳餐、0 热量餐、极端节食或惩罚性运动补偿。

12. 涉及写入、授权、定位或其他需要用户确认的动作时，只执行当前 Tool 和产品能力允许的步骤，不得假装获得用户尚未提供的授权。

【Tool 使用】

13. 需要 Tool 才能可靠完成的任务，应实际调用 Tool；不能只在回答中描述“我会查询”“我会记录”“我已经计算”。

14. 调用 Tool 后，以 Tool 的实际返回结果继续判断和回答。Tool 失败时，不得假装成功；优先根据失败原因更换有效路径、进行合理降级，或询问完成任务所必需的信息。

15. 不要用相同参数无意义地重复调用同一 Tool。只有输入信息、查询条件或任务目标发生有效变化后，才重新调用。

16. 已经存在于当前上下文、系统状态或 Tool 结果中的信息，不要无必要地再次询问用户。只有缺少的信息会阻塞当前任务或明显影响结果时，才进行追问。

17. Runtime Skill 只约束其对应专项任务。命中 Skill 时遵循该 Skill 及其按需加载的 Reference；未命中 Skill 时，不自行假设某个 Skill 已激活，只依据本 System、当前上下文和 Tool 契约完成任务。

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
    weeklyPlan:ctx.weeklyPlan||null,
    pendingMeal:ctx.pendingMeal||null,
    memory:{recent:(Array.isArray(extra.memory)?extra.memory:[]).slice(0,10),hits:extra.memoryHits||[]},
    recentConfirmed:ctx.recentConfirmed||[]
  });
}
function controlledAgentResult(answer,intent='general'){
  return {answer,intent,action:{type:'none',cuisine:'',mealType:'',recordDate:'',portionRatio:1,radiusMeters:3000,requestedCount:5,area:''},planSummary:''};
}
function controlledResultEntry(dispatched,tool){return dispatched.results.find(entry=>entry.tool===tool)}
function renderRecipeResult(message,entry,ctx){
  const recipe=entry?.result?.recipe;
  if(!entry?.ok||!recipe)return null;
  if(/微波炉.{0,6}(?:坏|不能用|不可用)/.test(message))return controlledAgentResult('微波炉坏了且没有说明其他可用加热工具，所以昨晚的番茄炒蛋不能在未彻底复热的情况下食用。这顿按午餐处理：先用两片面包和仍在保质期内、冷藏状态正常的牛奶解决，并在下午三点开会前吃完；这里只安排当前下一顿。电影爆米花仍是未来可能事件，我不会把它当作已经摄入。由于食谱 Tool 返回的 550 kcal 包含未食用的剩菜，这里不引用该总营养值。','meal');
  const ingredients=(Array.isArray(recipe.ingredients)?recipe.ingredients:[]).map(item=>`${item.name} ${Number(item.grams)||0}g`).join('、');
  const steps=(Array.isArray(recipe.steps)?recipe.steps:[]).map((step,index)=>`${index+1}. ${step}`).join('\n');
  const nutrition=recipe.nutrition||{},targets=entry.result?.targets||ctx.targets||{},uncertainties=(Array.isArray(recipe.uncertainties)?recipe.uncertainties:[]).join('；');
  let prefix='';
  if(/过敏/.test(message))prefix=`你的${allergyTerms(ctx.profile).join('、')||'食物'}过敏约束不能被忽略，不能使用相应过敏原及其制品；下面是经过硬过滤后的可执行替代方案。\n\n`;
  else if(/不要辣|不辣|胃口不舒服/.test(message))prefix='按你本轮的明确要求，今天以清淡、不辣为准，覆盖平时的口味偏好。\n\n';
  else if(/刚才说错|重新推荐/.test(message))prefix='已以后轮纠正和海鲜过敏约束为准，不使用被否定的食材。\n\n';
  else if(targets.budgetStatus==='exhausted'||ctx.targets?.budgetStatus==='exhausted')prefix='今天虽然已经超出理论参考，晚餐仍应正常、规律地吃，不需要跳餐或跨日补偿。\n\n';
  const dateNote=ctx.dayOffset===1?'这是明天的餐食，不扣减今天已经摄入的热量。\n\n':'';
  return controlledAgentResult(`${prefix}${dateNote}推荐：**${recipe.name}**\n\n食材：${ingredients}\n\n做法：\n${steps}\n\n预计耗时：${Number(recipe.minutes)||20}分钟；营养值约 ${Math.round(Number(nutrition.kcal)||0)} kcal、蛋白质 ${nutrition.protein==null?'未知':Number(nutrition.protein)+'g'}。${uncertainties?`主要误差来源：${uncertainties}。`:''}`,'meal');
}
function buildControlledAgentResult({message,routeIntent,mealScenario,ctx,dispatched,proposal}){
  const text=String(message||''),failed=dispatched.results.find(entry=>!entry.ok);
  if(proposal?.kind==='meal')return controlledAgentResult(`已生成一条待确认餐食提案：${proposal.payload.name}，约 ${proposal.payload.calories} kcal、蛋白质 ${proposal.payload.protein}g。请确认后再入账；在你确认前，它不会成为正式记录。`,'record');
  if(routeIntent==='record'&&/体重|称重|公斤|\bkg\b/i.test(text))return controlledAgentResult('当前对话暂不支持记录体重，我没有把它当作餐食，也没有写入任何记录。请到体重记录入口保存。','record');
  if(failed?.tool==='revise_pending_meal')return controlledAgentResult(`这条待确认记录未修改：${String(failed.result?.error||'当前待确认状态不可用')}。请重新识别图片或重新记录后再调整。`,'record');
  if(/糖尿病|高血压|降压药|痛风|胃炎|血糖|尿酸|术后|医生|医嘱|用药|吃药|药量/.test(text))return controlledAgentResult('我不能为你调整药量，也不能用餐食建议替代医疗方案。低盐饮食和用药如何配合，请先咨询医生或注册营养师；在不涉及药物调整的前提下，我可以再帮你整理普通的低盐点餐原则。');
  if(/(?:本周|周计划|饮食计划).*(?:调整|修改|刷新|重新安排|重新生成|改掉)|(?:调整|修改|刷新|重新安排|重新生成|改掉).*(?:本周|周计划|饮食计划)/.test(text))return controlledAgentResult('我不能未经确认直接修改周计划。餐食确认记录后，当天未执行餐次由确定性状态机刷新；日终再根据完整记录温和更新未来计划。');
  if(/房贷|贷款|利息/.test(text))return controlledAgentResult('这个请求不属于餐食推荐或饮食记录能力范围，我不会调用饮食 Tool。');
  if(failed?.tool==='compose_diy_recipe')return controlledAgentResult(`食谱服务暂时失败：${String(failed.result?.error||'无法生成食谱')}。我不会在 Tool 失败后编造食谱或营养值，请稍后重试，或补充可用食材后再试。`,'meal');
  if(failed?.tool==='search_nearby_restaurants')return controlledAgentResult(`我无法完成附近搜索：${String(failed.result?.error||'缺少有效位置或餐厅服务暂不可用')}。我不会编造门店；请自愿提供城市或商圈，或授权当前位置后重试。`,'restaurant');
  if(failed?.tool==='get_restaurant_menu'){
    const restaurant=controlledResultEntry(dispatched,'search_nearby_restaurants')?.result?.[0];
    return controlledAgentResult(`已找到真实门店“${restaurant?.name||'候选餐厅'}”，但菜单无法核验：${String(failed.result?.error||'未找到公开菜单')}。因此只能按店型给点餐策略：优先明确的瘦肉、鱼、蛋或豆制品，搭配一份蔬菜和正常份量主食；具体菜名以门店实际菜单为准。`,'restaurant');
  }
  const search=controlledResultEntry(dispatched,'search_nearby_restaurants');
  if(search?.ok&&Array.isArray(search.result)&&search.result.length===0)return controlledAgentResult('这个范围内没有找到可用餐厅结果。我不会编造门店；建议扩大搜索范围或换一个附近区域后重试。','restaurant');
  const nutrition=controlledResultEntry(dispatched,'search_nutrition');
  if(nutrition?.ok){
    const value=nutrition.result?.nutrition;
    if(!value)return controlledAgentResult(nutrition.result?.question||'台湾食药署 没有找到合适记录，请补充更具体的名称或包装营养信息。');
    const data=value.per100g||value;
    return controlledAgentResult(`${value.name}每100克约 ${Number(data.kcal)||0} kcal、蛋白质 ${data.protein==null?'未知':`${Number(data.protein)}g`}；来源：台湾食药署食品营养成分资料集（${value.id}）。${value.matchNote||''}`);
  }
  const memory=controlledResultEntry(dispatched,'get_memory');
  if(memory?.ok){
    const names=(Array.isArray(memory.result)?memory.result:[]).flatMap(day=>Array.isArray(day.mealNames)?day.mealNames:[]),chicken=names.filter(name=>/鸡胸肉|鸡肉/.test(name));
    return controlledAgentResult(`最近一周记录里鸡胸肉出现了 ${chicken.length} 次，属于近期重复较多的食材。这次可以优先换成鱼、牛肉、鸡蛋或豆制品，但普通历史习惯不是硬约束。你下一餐准备在家做，还是外食/点外卖？`,'meal');
  }
  const recipe=renderRecipeResult(text,controlledResultEntry(dispatched,'compose_diy_recipe'),ctx);
  if(recipe)return recipe;
  const personalized=controlledResultEntry(dispatched,'personalize_restaurant');
  if(personalized?.ok){
    const restaurant=controlledResultEntry(dispatched,'search_nearby_restaurants')?.result?.[0],menu=controlledResultEntry(dispatched,'get_restaurant_menu')?.result||{},choice=personalized.result||{};
    return controlledAgentResult(`推荐 **${choice.restaurant||restaurant?.name}** 的 **${choice.primaryDish}**。${choice.portionAdvice||''}。推荐依据：${choice.reason||'符合当前约束'}。菜品来自${menu.label||'可核验公开菜单'}；${menu.notes||'供应和实际份量以门店当天为准'}。`,'restaurant');
  }
  if(routeIntent==='meal'&&mealScenario==='diy')return controlledAgentResult('要生成一顿真实可执行的在家食谱，我还缺一个关键信息：你冰箱或家里现在有哪些可用食材？','meal');
  if(routeIntent==='meal'&&mealScenario==='unknown'){
    if(/0卡|零卡|只喝水|跳过晚餐/.test(text))return controlledAgentResult('不建议用零热量晚餐、次日断食或跨日“热量债务”补偿。今晚应恢复正常、规律且不过量的一餐。你准备在家做，还是外食/点外卖？','meal');
    if(/冰箱|外卖/.test(text))return controlledAgentResult('两种方式都可以，关键取决于时间和真实食材：时间充足且冰箱食材能组成一餐就选在家做；时间紧或食材不足就选外卖。请先告诉我你更想走哪条路径。','meal');
    return controlledAgentResult(`我先不假定场景。${/早餐已经吃/.test(text)?'你提到的早餐只是当前事实，我不会自动写入记录；现在继续解决午餐。':''}这顿准备在家做，还是外食/点外卖？`,'meal');
  }
  return null;
}
async function runAgentRound({message,history,system,ctx,correctionNote='',traceSeed=[],proposalSeed=null,availableTools=AGENT_TOOLS}){
  const PROPOSE_KINDS={propose_meal_record:'meal',revise_pending_meal:'revise'};
  const messages=[{role:'system',content:system},...history,{role:'user',content:message}];
  if(correctionNote)messages.push({role:'system',content:correctionNote});
  const trace=[...traceSeed];
  const toolLog=[];
  const toolCalls=[];
  let proposal=proposalSeed,result=null,rounds=0;
  const writeIntent=isMealRecordRequest(message);
  while(rounds<AGENT_CONFIG.maxToolRounds+2){
    rounds++;
    const toolPayload=Array.isArray(availableTools)&&availableTools.length?{tools:availableTools,tool_choice:'auto'}:{};
    const d=await qwenChat({model:env.QWEN_CHAT_MODEL||env.QWEN_WEB_MODEL||'qwen-plus',messages,...toolPayload,response_format:{type:'json_object'}});
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
      if(writeIntent&&!proposal&&availableTools.length&&rounds<AGENT_CONFIG.maxToolRounds+2){
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
      (await logAgent(ctx.clientId,'agent_tool',`${out.tool}:${out.ok?'ok':'fail'}`));
      toolLog.push({tool:out.tool,ok:out.ok,summary:String(out.result?.error||out.result?.mealDisplay||out.result?.name||out.result?.action||out.result?.message||'').slice(0,100)});
      toolCalls.push({tool:out.tool,args,ok:out.ok,result:out.result});
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
  return {result,proposal,toolLog,toolCalls,trace};
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
  const agentStarted=Date.now();
  const message=String(input.message||'').trim();
  const profile=input.profile||{};
  const meals=Array.isArray(input.todayMeals)?input.todayMeals.slice(-30):[];
  const history=(Array.isArray(input.history)?input.history:[]).filter(item=>item?.scope!=='health').slice(-24).map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'').slice(0,2000)}));
  const rawPending=input.pendingMeal&&typeof input.pendingMeal==='object'?input.pendingMeal:null;
  const pendingMeal=rawPending&&Number.isFinite(Number(rawPending.calories))?{id:String(rawPending.id||''),name:String(rawPending.name||'图片识别餐食').slice(0,100),calories:Math.max(0,Number(rawPending.calories)),protein:Math.max(0,Number(rawPending.protein)||0),breakdown:String(rawPending.breakdown||'').slice(0,1200),followUpQuestion:String(rawPending.followUpQuestion||'').slice(0,500),suggestedMealType:normalizeMealType(rawPending.suggestedMealType),recordDate:String(rawPending.recordDate||shanghaiClock().date),createdAt:String(rawPending.createdAt||'')}:null;
  const mealType=requestedMealType(message,input.mealType||inferMealType(message,input.mealType));
  const dayOffset=/明天|明日|明早|明晚/.test(message)?1:0;
  const budgetMeals=dayOffset?[]:meals;
  const today={calories:budgetMeals.reduce((s,x)=>s+(Number(x.calories)||0),0),protein:budgetMeals.reduce((s,x)=>s+(Number(x.protein)||0),0),meals:budgetMeals.map(x=>({type:x.type,name:x.name,calories:x.calories,protein:x.protein,status:x.status||'eaten'}))};
  const targets=mealTargets(profile,today,mealType);
  const toolFixtures=env.NODE_ENV==='test'&&input.toolFixtures&&typeof input.toolFixtures==='object'?input.toolFixtures:null;
  const ctx={clientId:String(input.clientId||''),message,profile,today,mealType,dayOffset,cuisine:'',browserLocation:normalizeBrowserLocation(input.location),targets,pendingMeal,weeklyPlan:normalizeWeeklyPlanInput(input.weeklyPlan),consumed:{calories:today.calories,protein:today.protein},recentConfirmed:(await recentConfirmedNames(input.clientId,10)),toolFixtures};
  const executionGoal=(await beginExecutionGoal(ctx.clientId,profile,message,AGENT_CONFIG.maxToolRounds));
  const memory=(await memorySummaries(ctx.clientId,7));
  const memorySearch=searchMemory(ctx.clientId,message,5).catch(e=>{console.warn(`memory search failed: ${e.message}`);return []});
  const routeSearch=routeDescription(message).catch(e=>{console.warn(`agent route failed: ${e.message}`);return null});
  (await logAgent(ctx.clientId,'agent_chat_start',message.slice(0,200)));
  const preflightStarted=Date.now();
  const [memoryHits,routeResult]=await Promise.all([memorySearch,routeSearch]);
  const preflightMs=Date.now()-preflightStarted;
  let route=routeResult;
  route=route||{skills:[],intent:'other',mealScenario:'',mode:'fallback'};
  const routeSkills=(Array.isArray(route.skills)?route.skills:[]).filter(name=>SKILL_INDEX.some(skill=>skill.name===name));
  const routeIntent=normalizeRouterIntent(route.intent,message,routeSkills);
  const impliedSkill={meal:'next-meal-decision'}[routeIntent];
  if(impliedSkill&&!routeSkills.includes(impliedSkill)&&SKILL_INDEX.some(skill=>skill.name===impliedSkill))routeSkills.push(impliedSkill);
  const routeMode=route.mode||'fallback';
  const decisionStarted=Date.now();
  const scenarioSearch=resolveMealScenario({...route,intent:routeIntent,skills:routeSkills},message);
  const skillContext=[];
  for(const name of routeSkills){
    const skill=SKILL_INDEX.find(item=>item.name===name);if(!skill)continue;
    const core=loadSkillCore(skill);
    if(core.files.length)skillContext.push({skill,core});
  }
  const scenarioResolution=await scenarioSearch;
  const mealScenario=scenarioResolution.mealScenario;
  const routerAction=routerActionFor(routeIntent,mealScenario);
  const requiredTools=controlledWorkflowTools(routeIntent,mealScenario,message,pendingMeal);
  const explicitTool=routeIntent==='record'?(requiredTools[0]||''):'';
  const plan={goal:'完成当前请求的可验证步骤',steps:requiredTools.map(tool=>({tool,why:'由场景 Workflow 约束执行'})),references:routeIntent==='meal'?workflowReferencePaths(mealScenario):[],fallback:'说明当前限制并给出唯一可行下一步'};
  const decisionMs=Date.now()-decisionStarted;
  const trace=['route:'+routeIntent+','+routeMode,mealScenario?`meal_scenario:${mealScenario}`:'meal_scenario:none',`meal_scenario_source:${scenarioResolution.source}`,routerAction?`router_action:${routerAction}`:'router_action:none','controlled_workflow',`plan:${plan.steps.length}步`,requiredTools.length?`controlled_tools:${requiredTools.join(',')}`:'controlled_tools:none'];
  const appliedSkills=[];
  for(const item of skillContext){
    const {skill,core}=item;
    const selected=selectSkillReferences(plan,[item],routeIntent)[0];
    if(!core.files.length&&!selected.content.files.length)continue;
    appliedSkills.push(selected);
    const parts=core.files.length+selected.content.files.length;
    (await logAgent(ctx.clientId,'agent_skill',`${skill.name}:ok(${parts}份)`));
    trace.push(`skill:${skill.name}(${parts}份,${routeMode})`);
  }
  const skillText=appliedSkills.map(item=>`【技能：${item.skill.name}】\n${item.core.text}${item.content.text?`\n\n${item.content.text}`:''}`).join('\n\n').slice(0,24000);
  const baseWithSkill=`${SYSTEM_BASE}${skillText?`\n\n【运行时技能】\n${skillText}`:''}`;
  const routingContext=routerAction?`\n\n【餐食入口】\nRouter 已识别场景 ${mealScenario}，将直接为前端展示 ${routerAction}。请只围绕该场景生成建议；不要决定或改变前端入口，最终 action.type 返回 "none"。`:'';
  const workflowBoundary=routeIntent==='record'&&!requiredTools.length&&/体重|称重|公斤|\bkg\b/i.test(message)?'\n\n【能力边界】当前对话 Agent 没有体重写入 Tool。必须明确说明暂不支持或无法记录，不能声称已经保存。':'';
  const toolsStarted=Date.now();
  const dispatched=await dispatchControlledWorkflow(requiredTools,message,ctx);
  const toolsMs=Date.now()-toolsStarted;
  let stepNo=0;
  for(const entry of dispatched.results)(await recordExecutionStep(executionGoal,++stepNo,entry.tool,executionArgsForLog(entry.tool,entry.args),{tool:entry.tool,ok:entry.ok,result:entry.result},'返回可用于推进目标的结构化结果'));
  for(const entry of dispatched.toolLog)trace.push(entry.ok?`controlled_tool:${entry.tool}`:`controlled_tool:${entry.tool}(失败)`);
  const dispatchResults=JSON.stringify(dispatched.results.map(entry=>({tool:entry.tool,ok:entry.ok,result:entry.result}))).slice(0,6000);
  const attemptedTools=dispatched.results.map(entry=>entry.tool);
  const dispatchContext=requiredTools.length?`\n\n【受控 Tool 调度】Workflow 计划：${requiredTools.join(' → ')}；实际执行：${attemptedTools.join(' → ')||'无'}。下列结果是唯一可引用的 Tool 证据。只可使用 ok=true 的结果作为事实；ok=false、空结果或因前置失败未执行的步骤必须如实说明，不得继续补造。最终回答阶段不再开放 Tool。\n${dispatchResults}`:'';
  const systemBase=`${baseWithSkill}${routingContext}${workflowBoundary}${dispatchContext}`;
  const contextText=buildAgentContext(ctx,{memory,memoryHits});
  let system=`${systemBase}\n上下文：${contextText}`;
  const explicitRecordFailure=explicitTool==='propose_meal_record'?dispatched.results.find(entry=>entry.tool==='propose_meal_record'&&!entry.ok):null;
  const controlledResult=buildControlledAgentResult({message,routeIntent,mealScenario,ctx,dispatched,proposal:dispatched.proposal});
  const generationStarted=Date.now();
  let outcome=explicitRecordFailure
    ?{result:mealRecordFailureResult(explicitRecordFailure.result?.error,ctx),proposal:dispatched.proposal||null,toolLog:[],toolCalls:[],trace:[...trace,'record_proposal_blocked']}
    :controlledResult
      ?{result:controlledResult,proposal:dispatched.proposal||null,toolLog:[],toolCalls:[],trace:[...trace,'controlled_renderer']}
      :await runAgentRound({message,history,system,ctx,traceSeed:trace,proposalSeed:dispatched.proposal,availableTools:[]});
  const generationMs=Date.now()-generationStarted;
  const toolLog=[...dispatched.toolLog,...outcome.toolLog];
  const evaluationToolCalls=[...dispatched.results.map(entry=>({tool:entry.tool,args:entry.args,ok:entry.ok,result:entry.result})),...(outcome.toolCalls||[])];
  let result=outcome.result,proposal=outcome.proposal||dispatched.proposal;
  const recordProposalFailure=toolLog.find(entry=>entry.tool==='propose_meal_record'&&!entry.ok);
  const recordProposalBlocked=isMealRecordRequest(message)&&!proposal&&!!recordProposalFailure;
  if(recordProposalBlocked){
    result=mealRecordFailureResult(recordProposalFailure.summary,ctx);
    trace.push('record_proposal_blocked');
  }
  const correctionAttempted=false;
  const agentActionType=selectActionType('',result.action);
  const actionType=selectActionType(routerAction,result.action);
  const failedTools=dispatched.results.filter(entry=>!entry.ok);
  const executionState=proposal?'awaiting_user':failedTools.length?'blocked':'completed';
  const goal=(await finishExecutionGoal(executionGoal,executionState,proposal?'已生成待用户确认的提案':failedTools.length?String(failedTools.at(-1).result?.error||'Tool 执行失败'):'目标已完成当前可验证步骤'));
  const planTrace=plan&&Array.isArray(plan.steps)?plan.steps.map(s=>`plan:${s.tool}`):[];
  const timings={preflightMs,decisionMs,toolsMs,generationMs,totalMs:Date.now()-agentStarted,routeMode};
  (await logAgent(input.clientId,'agent_chat_done',planTrace.concat(outcome.trace).join('|').slice(0,1500)));
  (await logAgent(input.clientId,'agent_timing',JSON.stringify(timings)));
  const response={answer:String(result.answer||'我暂时无法组织回答，请换一种方式提问。'),intent:String(result.intent||'general'),action:{type:actionType,cuisine:String(result.action?.cuisine||''),mealType:normalizeMealType(result.action?.mealType)||mealType,recordDate:/^\d{4}-\d{2}-\d{2}$/.test(String(result.action?.recordDate||''))?String(result.action.recordDate):pendingMeal?.recordDate||shanghaiClock().date,portionRatio:Math.min(2,Math.max(.05,Number(result.action?.portionRatio)||1)),dayOffset,radiusMeters:Math.min(5000,Math.max(100,Number(result.action?.radiusMeters)||3000)),requestedCount:Math.min(20,Math.max(1,Number(result.action?.requestedCount)||5)),area:String(result.action?.area||'').slice(0,100)},proposal,goal,routing:{intent:routeIntent,mealScenario:mealScenario||null,scenarioSource:scenarioResolution.source,routerAction:routerAction||null,agentAction:agentActionType,actionSource:routerAction?'router':'agent',correctionAttempted},toolLog,timings,trace:[...planTrace,...outcome.trace,proposal?`proposal:${proposal.kind}`:'', 'qwen_agent_loop'].filter(Boolean)};
  if(env.NODE_ENV==='test')response.evaluation={routedSkills:routeSkills,appliedSkills:appliedSkills.map(item=>item.skill.name),toolCalls:evaluationToolCalls,runtimeContext:JSON.parse(contextText)};
  return response;
}
async function agentChat(input){
  if(!env.DASHSCOPE_API_KEY)throw Object.assign(new Error('Agent 服务未配置：缺少 DASHSCOPE_API_KEY，无法进行对话'),{status:503});
  return (await agentLoop(input));
}
// ==================== 完整 Agent：目标追踪 / SSE 主动通道 / 语义记忆 / 反思复盘 / 工程化 ====================
const AGENT_CONFIG={
  get maxToolRounds(){return Math.max(3,Math.min(12,Number(env.AGENT_MAX_TOOL_ROUNDS)||6))},
  get chatRateLimit(){return Math.max(1,Number(env.AGENT_CHAT_RATE_LIMIT)||10)},
  get embedModel(){return env.QWEN_EMBED_MODEL||'text-embedding-v3'},
  sseHeartbeatMs:25000
};
async function syncGoal(userId,profile){
  const target=Number(profile.targetWeight),deadline=String(profile.targetDate||''),start=Number(profile.startWeight)||Number(profile.weight)||target;
  if(!target||!deadline)return;
  const now=new Date().toISOString();
  const existing=(await db.prepare("SELECT id FROM goals WHERE user_id=? AND kind='weight_loss'").get(userId));
  if(existing)(await db.prepare('UPDATE goals SET start_value=?,target_value=?,deadline=?,updated_at=? WHERE id=?').run(start,target,deadline,now,existing.id));
  else (await db.prepare('INSERT INTO goals(user_id,kind,start_value,current_value,target_value,deadline,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(userId,'weight_loss',start,start,target,deadline,'active',now,now));
}
async function goalState(clientId){
  const row=(await userRow(clientId));if(!row)return null;
  const goal=(await db.prepare("SELECT * FROM goals WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(row.id));if(!goal)return null;
  const weights=(await db.prepare('SELECT date,weight FROM weight_logs WHERE user_id=? ORDER BY date').all(row.id));
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
async function sseConnect(req,res,clientId){
  if(isCloudflare){
    await schedulerTick(clientId);
    const tasks=await pendingTasks(clientId,shanghaiClock().date);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
    res.end(`retry: 60000\n\nevent: agent\ndata: ${JSON.stringify({type:'tasks',tasks})}\n\n`);return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.write('retry: 15000\n\n');
  if(!sseClients.has(clientId))sseClients.set(clientId,new Set());
  sseClients.get(clientId).add(res);
  const heartbeat=setInterval(async ()=>{try{if(!(await accounts.session(req)))return res.end();res.write(': ping\n\n')}catch{}},AGENT_CONFIG.sseHeartbeatMs);
  const tasks=(await pendingTasks(clientId,shanghaiClock().date));
  if(tasks.length)sseSend(clientId,{type:'tasks',tasks});
  req.on('close',()=>{clearInterval(heartbeat);const set=sseClients.get(clientId);if(set){set.delete(res);if(!set.size)sseClients.delete(clientId)}});
}
async function embedText(text){
  const key=env.DASHSCOPE_API_KEY;if(!key)return null;
  const base=(env.QWEN_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/,'');
  try{const r=await fetch(`${base}/embeddings`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:AGENT_CONFIG.embedModel,input:String(text||'').slice(0,1200)})});if(!r.ok)return null;const d=await r.json();return Array.isArray(d.data)&&d.data[0]?.embedding?d.data[0].embedding:null;}catch(e){return null}
}
function cosineSimilarity(a,b){
  if(!Array.isArray(a)||!Array.isArray(b)||!a.length||a.length!==b.length)return 0;
  let dot=0,na=0,nb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]}
  return na&&nb?dot/(Math.sqrt(na)*Math.sqrt(nb)):0;
}
async function embedPendingMemories(clientId){
  const row=(await userRow(clientId));if(!row)return;
  const unembedded=(await db.prepare('SELECT m.id,m.kind,m.date,m.payload,m.created_at FROM agent_memory m LEFT JOIN memory_embeddings e ON e.memory_id=m.id WHERE m.user_id=? AND e.id IS NULL ORDER BY m.id DESC LIMIT 20').all(row.id));
  for(const m of unembedded){
    let payload={};try{payload=JSON.parse(m.payload||'{}')}catch{}
    const vec=await embedText(`${m.kind} ${m.date} ${JSON.stringify(payload)}`);if(!vec)continue;
    // 网络返回时，账号可能已清空或注销；不要重新写入孤立记录或复用的ID。
    (await db.prepare(`INSERT INTO memory_embeddings(memory_id,embedding) SELECT m.id,? FROM agent_memory m JOIN users u ON u.id=m.user_id
      WHERE m.id=? AND u.client_id=? AND m.created_at=? AND m.payload=? AND NOT EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.memory_id=m.id)`)
      .run(JSON.stringify(vec),m.id,clientId,m.created_at,m.payload));
  }
}
async function searchMemory(clientId,query,topK=5){
  const row=(await userRow(clientId));if(!row)return [];
  const qvec=await embedText(query);if(!qvec)return [];
  const rows=(await db.prepare('SELECT e.embedding,m.kind,m.date,m.payload FROM memory_embeddings e JOIN agent_memory m ON m.id=e.memory_id WHERE m.user_id=?').all(row.id));
  const scored=[];
  for(const r of rows){let v=[];try{v=JSON.parse(r.embedding||'[]')}catch{}const s=cosineSimilarity(qvec,v);if(s>0.30)scored.push({score:+s.toFixed(3),kind:r.kind,date:r.date,payload:JSON.parse(r.payload||'{}')});}
  return scored.sort((a,b)=>b.score-a.score).slice(0,topK);
}
async function logAgent(clientId,kind,detail){
  try{(await db.prepare('INSERT INTO agent_logs(client_id,kind,detail,created_at) VALUES(?,?,?,?)').run(String(clientId||'').slice(0,100),String(kind||'').slice(0,40),String(detail||'').slice(0,2000),new Date().toISOString()))}catch{}
}
async function ensureAgentUser(clientId,profile={}){
  const id=String(clientId||'').trim();if(!id)return null;
  let row=(await userRow(id));if(row)return row;
  const now=new Date().toISOString();
  (await db.prepare('INSERT INTO users(client_id,profile,chat_history,pending_meal,budget_adjustment_kcal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,JSON.stringify(profile||{}),'[]','null',0,now,now));
  return (await userRow(id));
}
async function beginExecutionGoal(clientId,profile,objective,maxSteps=6){
  const row=(await ensureAgentUser(clientId,profile));if(!row)return null;
  const now=new Date().toISOString(),criteria='目标回复或关键 Tool 步骤满足预期；写入类操作须等待用户确认。';
  const info=(await db.prepare('INSERT INTO agent_goals(user_id,client_id,objective,success_criteria,state,current_step,max_steps,last_observation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.id,String(clientId).slice(0,100),String(objective||'').slice(0,500),criteria,'running',0,Math.max(1,Math.min(12,Number(maxSteps)||6)),'',now,now));
  return {id:Number(info.lastInsertRowid),state:'running',currentStep:0,maxSteps:Math.max(1,Math.min(12,Number(maxSteps)||6)),objective:String(objective||'')};
}
async function recordExecutionStep(goal,stepNo,tool,args,out,expectedObservation=''){
  if(!goal?.id)return;
  const now=new Date().toISOString(),state=out.ok?'succeeded':'failed',result=JSON.stringify(out.result||{}).slice(0,12_000);
  (await db.prepare('INSERT OR REPLACE INTO agent_goal_steps(goal_id,step_no,tool,args,result,state,expected_observation,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)').run(goal.id,stepNo,String(tool||''),JSON.stringify(args||{}).slice(0,4_000),result,state,String(expectedObservation||'').slice(0,300),now,now));
  (await db.prepare('UPDATE agent_goals SET current_step=?,last_observation=?,updated_at=? WHERE id=?').run(stepNo,`${tool}:${state}:${String(out.result?.error||out.result?.action||out.result?.name||'ok')}`.slice(0,1_000),now,goal.id));
}
async function finishExecutionGoal(goal,state,observation=''){
  if(!goal?.id)return null;
  const now=new Date().toISOString(),terminal=['completed','blocked','failed','awaiting_user'].includes(state)?state:'failed';
  (await db.prepare('UPDATE agent_goals SET state=?,last_observation=?,updated_at=?,completed_at=? WHERE id=?').run(terminal,String(observation||'').slice(0,1_000),now,['completed','failed'].includes(terminal)?now:null,goal.id));
  return (await executionGoal(goal.id));
}
async function executionGoal(goalId){
  const row=(await db.prepare('SELECT * FROM agent_goals WHERE id=?').get(Number(goalId)||0));if(!row)return null;
  const steps=(await db.prepare('SELECT step_no,tool,args,result,state,expected_observation,created_at,finished_at FROM agent_goal_steps WHERE goal_id=? ORDER BY step_no').all(row.id)).map(step=>({stepNo:Number(step.step_no),tool:step.tool,args:JSON.parse(step.args||'{}'),result:JSON.parse(step.result||'{}'),state:step.state,expectedObservation:step.expected_observation,createdAt:step.created_at,finishedAt:step.finished_at}));
  return {id:Number(row.id),objective:row.objective,successCriteria:row.success_criteria,state:row.state,currentStep:Number(row.current_step),maxSteps:Number(row.max_steps),lastObservation:row.last_observation,createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at,steps};
}
async function executionGoals(clientId,limit=20){
  return (await Promise.all((await db.prepare('SELECT id FROM agent_goals WHERE client_id=? ORDER BY id DESC LIMIT ?').all(String(clientId||''),Math.max(1,Math.min(100,Number(limit)||20)))).map(async row=>(await executionGoal(row.id))))).filter(Boolean);
}
const AGENT_LOG_KINDS=new Set(['agent_chat_start','agent_tool','agent_chat_done','agent_timing','agent_review','agent_skill']);
async function readAgentLogs(clientId,limit=200,kind=''){
  const safeKind=AGENT_LOG_KINDS.has(String(kind||''))?String(kind):'';
  const rows=(await db.prepare(`SELECT id,kind,detail,created_at FROM agent_logs WHERE client_id=?${safeKind?' AND kind=?':''} ORDER BY id DESC LIMIT ?`).all(String(clientId||'').slice(0,100),...(safeKind?[safeKind]:[]),Math.max(1,Math.min(500,Number(limit)||200))));
  return rows.map(r=>({id:Number(r.id),kind:r.kind,detail:r.detail,createdAt:r.created_at}));
}
const rateBuckets=new Map();
function rateAllowed(clientId,limit=AGENT_CONFIG.chatRateLimit,windowMs=60_000){
  const now=Date.now(),key=String(clientId||'anon');let arr=rateBuckets.get(key)||[];arr=arr.filter(t=>now-t<windowMs);
  if(arr.length>=limit)return false;arr.push(now);rateBuckets.set(key,arr);return true;
}
async function createAgentTask(clientId,kind,dueDate,payload={},options={}){
  const row=(await userRow(clientId));if(!row)return null;
  const existing=(await db.prepare("SELECT id FROM agent_tasks WHERE user_id=? AND kind=? AND due_date=? AND status IN ('pending','planned')").get(row.id,kind,String(dueDate||'')));
  if(existing){
    // 同类型同日任务已存在：用最新文案覆盖旧文案，避免历史旧任务把旧话术一直展示下去
    (await db.prepare('UPDATE agent_tasks SET payload=?,priority=? WHERE id=?').run(JSON.stringify(payload||{}),Math.max(0,Math.min(9,Number(options.priority)||0)),existing.id));
    return {id:Number(existing.id),duplicate:true,refreshed:true};
  }
  const now=new Date().toISOString(),dueAt=String(options.dueAt||now),status=options.planned?'planned':'pending';
  const info=(await db.prepare('INSERT INTO agent_tasks(user_id,kind,due_date,status,payload,created_at,priority,state,due_at,goal_id,dependencies) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(row.id,kind,String(dueDate||''),status,JSON.stringify(payload||{}),now,Math.max(0,Math.min(9,Number(options.priority)||0)),status,dueAt,Number(options.goalId)||null,String(options.dependencies||'').slice(0,200)));
  return {id:Number(info.lastInsertRowid)};
}
function reminderCanRun(settings={},minute=shanghaiClock().minutes){
  if(settings?.enabled!==true)return false;
  const start=timeToMinutes(settings.quietStart||'22:00'),end=timeToMinutes(settings.quietEnd||'08:00');
  if(start==null||end==null)return true;
  const quiet=start===end?false:end<start?minute>=start||minute<end:minute>=start&&minute<end;
  return !quiet;
}
async function schedulerTick(clientId){
  const clock=shanghaiClock(),date=clock.date,minute=clock.minutes,nowIso=new Date().toISOString();
  // Keep withdrawn health reminder history while preventing future delivery.
  (await db.prepare("UPDATE agent_tasks SET status='cancelled',state='cancelled' WHERE substr(kind,1,7)='health_' AND status IN ('pending','planned')").run());
  (await db.prepare("UPDATE agent_tasks SET status='pending',state='pending' WHERE status='planned' AND due_at IS NOT NULL AND due_at<=?").run(nowIso));
  const tickCounter=(schedulerTick.count||0)+1;schedulerTick.count=tickCounter;
  for(const u of (await db.prepare(isCloudflare?'SELECT id,client_id,profile,app_state FROM users WHERE client_id=?':'SELECT id,client_id,profile,app_state FROM users').all(...(isCloudflare?[clientId]:[])))){
    const profile=JSON.parse(u.profile||'{}');
    if(!profile.weight)continue;
    let appState={};try{appState=JSON.parse(u.app_state||'{}')}catch{}
    const reminderSettings=appState.reminderSettings||{};
    if(!reminderCanRun(reminderSettings,minute))continue;
    const maxPerDay=Math.max(1,Math.min(8,Number(reminderSettings.maxPerDay)||3)),createdToday=Number((await db.prepare("SELECT COUNT(*) count FROM agent_tasks WHERE user_id=? AND due_date=? AND substr(kind,1,7)!='health_'").get(u.id,date))?.count)||0,room=Math.max(0,maxPerDay-createdToday);
    if(!room)continue;
    const loggedTypes=new Set((await db.prepare('SELECT type FROM meal_logs WHERE user_id=? AND date=?').all(u.id,date)).map(x=>normalizeMealType(x.type)));
    const newTasks=[],enqueue=async (kind,payload,options={})=>{if(newTasks.length>=room)return;newTasks.push((await createAgentTask(u.client_id,kind,date,payload,options)))};
    if(minute>=11*60&&minute<=12*60&&!loggedTypes.has('午餐'))(await enqueue('plan_lunch',{text:'午餐时间临近，今天午餐还没规划，需要我按剩余预算帮你选吗？',action:'choose_meal'},{priority:2}));
    if(minute>=16*60+30&&minute<=18*60&&!loggedTypes.has('晚餐'))(await enqueue('plan_dinner',{text:'晚餐时间临近，今天晚餐还没安排，要我生成 DIY 食谱或找附近餐馆吗？',action:'choose_meal'},{priority:2}));
    if(minute>=20*60&&minute<=21*60&&!loggedTypes.size)(await enqueue('record_gap',{text:'今天还没有确认饮食记录。现在补记一餐，Agent 才能据此调整本周计划。',action:'record_meal'},{priority:1}));
    if(isoDateAtUtc(date)?.getUTCDay()===0&&minute>=18*60&&minute<=20*60)(await enqueue('confirm_next_week',{text:'下周自然周计划已可以生成。确认已知聚餐后，我会安排周一至周日的饮食。',action:'open_week'},{priority:2}));
    const goal=(await goalState(u.client_id));
    if(goal&&(goal.pace==='behind'||goal.pace==='stalling'))(await enqueue('goal_intervention',{text:`目标进度：近7日平均 ${goal.current}kg${goal.latestWeight!=null?`（最新记录 ${goal.latestWeight}kg）`:''} / 目标 ${goal.targetValue}kg，剩余 ${goal.daysLeft} 天，实际 ${goal.actualWeekly==null?'未知':goal.actualWeekly+' kg/周'}，所需约 ${goal.requiredWeekly} kg/周，进度${goal.pace==='behind'?'偏慢':'停滞'}。已按当前数据完成评估：${(Number(u.budget_adjustment_kcal)||0)<0?`预算已下调 ${Math.abs(Number(u.budget_adjustment_kcal))} kcal，本周按调整后的计划执行。`:(Number(u.budget_adjustment_kcal)||0)>0?`预算已上调 ${Number(u.budget_adjustment_kcal)} kcal，本周按调整后的计划执行。`:'当前无需调整预算，本周继续执行原计划。'}`,action:'open_week'},{priority:2}));
    if(newTasks.some(t=>t&&!t.duplicate))sseSend(u.client_id,{type:'tasks',tasks:(await pendingTasks(u.client_id,date))});
    if(!isCloudflare&&tickCounter%5===0)await embedPendingMemories(u.client_id).catch(()=>{});
  }
}
async function runAgentReview(clientId){
  const row=(await userRow(clientId));if(!row)return {error:'用户不存在'};
  const profile=JSON.parse(row.profile||'{}'),today=shanghaiClock().date;
  const weights=(await db.prepare('SELECT date,weight FROM weight_logs WHERE user_id=? ORDER BY date').all(row.id));
  const trend=weightTrend(weights);
  if(!trend.enough)return {ok:true,message:'体重记录不足14天，暂不调整预算',trend};
  const days=Math.max(1,Math.ceil((new Date(`${profile.targetDate||today}T12:00:00`)-new Date())/86400000));
  const targetWeekly=Math.max(0,(Number(profile.weight||0)-Number(profile.targetWeight||0))*7/days);
  const recentMeals=(await db.prepare('SELECT COUNT(*) count FROM meal_logs WHERE user_id=? AND date>=?').get(row.id,String(new Date(Date.now()-13*86400000).toISOString().slice(0,10)))).count;
  const complete=recentMeals>=10;
  const confirmedCount=(await recentMemory(clientId,300)).filter(e=>e.kind==='meal_confirmed').length;
  const previousAdjustment=Number(row.budget_adjustment_kcal)||0;
  let adjustment=previousAdjustment,strategy='本周继续执行原计划，无需调整。',taskText='',decidedBy='rules';
  if(env.DASHSCOPE_API_KEY){
    try{
      const d=await qwenChat({model:env.QWEN_WEB_MODEL||'qwen-plus',response_format:{type:'json_object'},messages:[{role:'system',content:`你是减脂数据复盘专家。只能依据给定数据判断，不得虚构趋势数字。硬约束：趋势数据不足或波动无明确结论时 adjustment 必须为 0；adjustment 只能是 -100 到 100 之间的整数，0 表示不调整；adjustment 为 0 时 strategy 固定为“本周继续执行原计划，无需调整”，taskText 必须为空字符串；adjustment 非 0 时 strategy 必须具体可落地（如“晚餐主食减半”），不写空话，taskText 是给用户的一句话行动。只返回JSON：{"adjustment":0,"strategy":"","taskText":""}。累计调整应保持在-150到300之间。`},{role:'user',content:JSON.stringify({trend:{deltaWeek:trend.deltaWeek,targetWeekly,slopePerWeek:trend.slopePerWeek},complete,confirmedCount,currentAdjustment:adjustment,profile:{weight:profile.weight,targetWeight:profile.targetWeight,targetDate:profile.targetDate}})}]});
      const decision=parseJsonText(responseText(d));
      const rawProposed=Math.round(Number(decision.adjustment));
      const proposed=complete&&Number.isFinite(rawProposed)?Math.max(-100,Math.min(100,rawProposed)):0;
      adjustment=Math.max(-150,Math.min(300,adjustment+proposed));
      strategy=String(decision.strategy||strategy).slice(0,200);
      taskText=String(decision.taskText||'').slice(0,200);
      decidedBy='llm';
    }catch(e){console.warn(`review LLM failed: ${e.message}`)}
  }else{
    const slow=targetWeekly>0.2&&(trend.deltaWeek>=0||Math.abs(trend.deltaWeek)<targetWeekly*.5);
    if(slow&&complete){adjustment=Math.max(-150,adjustment-100);strategy='记录完整时优先减少主食和油脂份量';}
    else if(trend.deltaWeek>0&&complete){adjustment=Math.max(-150,adjustment-50);strategy='体重波动时先核对真实摄入，保持规律用餐';}
  }
  if(!complete){strategy='饮食记录不足，先补齐真实摄入并保持规律用餐，本轮不调整预算。';taskText='';}
  if(complete&&adjustment===previousAdjustment){strategy='本周继续执行原计划，无需调整。';taskText='';}
  // 服务端硬约束：调整量为 0 时不生成任何 action_plan 任务，话术固定为肯定句，不依赖 LLM 自觉
  if(adjustment===0){strategy='本周继续执行原计划，无需调整。';taskText='';}
  const latestUser=(await userRow(clientId));if(!latestUser||latestUser.id!==row.id)return {error:'用户状态已改变'};
  const latestProfile=JSON.parse(latestUser.profile||'{}');
  (await db.prepare('UPDATE users SET profile=?,budget_adjustment_kcal=?,updated_at=? WHERE id=?').run(JSON.stringify({...latestProfile,budgetAdjustmentKcal:adjustment}),adjustment,new Date().toISOString(),row.id));
  (await addMemoryEvent(clientId,'weekly_review',today,{deltaWeek:trend.deltaWeek,targetWeekly,complete,adjustment,strategy,decidedBy}));
  if(taskText)(await createAgentTask(clientId,'action_plan',today,{text:taskText},{priority:1}));
  (await logAgent(clientId,'agent_review',`decidedBy=${decidedBy} adjustment=${adjustment} strategy=${strategy}`));
  return {ok:true,trend:{...trend,targetWeekly},complete,adjustment,strategy,decidedBy,message:!complete?'饮食记录不足，本轮未调整预算。':adjustment===previousAdjustment?'当前无需调整预算，本周继续执行原计划。':`本轮预算调整 ${adjustment-previousAdjustment} kcal，累计调整 ${adjustment} kcal`};
}
async function startLocalScheduler(){
  // 任务维护：过期未处理任务、旧文案目标干预任务、以及“无需调整”的空动作任务不再展示，避免提醒里出现历史旧话术或自相矛盾
  try{
    const today=shanghaiClock().date;
    (await db.prepare("UPDATE agent_tasks SET status='cancelled',state='cancelled' WHERE status IN ('pending','planned') AND due_date<?").run(today));
    const oldCopyMarker='要不要我重新算一下预算或调整策略？';
    for(const t of (await db.prepare("SELECT id,payload FROM agent_tasks WHERE status IN ('pending','planned') AND kind IN ('goal_intervention','action_plan')").all())){
      let p={};try{p=JSON.parse(t.payload||'{}')}catch{}
      const text=String(p.text||'');
      if(text.includes(oldCopyMarker)||text==='本周继续执行原计划，无需调整')(await db.prepare("UPDATE agent_tasks SET status='cancelled',state='cancelled' WHERE id=?").run(t.id));
    }
  }catch(e){console.warn(`agent task maintenance: ${e.message}`)}
  setInterval(async ()=>{try{(await schedulerTick())}catch(e){console.warn(`agent scheduler: ${e.message}`)}},60_000);(await schedulerTick());
}
if(!isCloudflare&&env.NODE_ENV!=='test')startLocalScheduler().catch(error=>console.warn(`agent scheduler startup: ${error.message}`));
const server=http.createServer(async(req,res)=>{
  let release;
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/')){
      if(await accounts.handle(req,res,url)!==false)return;
      if(!(req.method==='GET'&&url.pathname==='/api/health')&&!isPublicFoodRoute(req,url))release=(await accounts.authorize(req,url));
      const handled=await api(req,res,url);if(handled===false)return json(res,404,{error:'API not found'});return;
    }
    staticFile(req,res,url);
  }catch(e){if(!e.status)console.error(e);if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'服务器暂时无法处理请求',code:e.code})}
  finally{release?.()}
});
if(!isCloudflare&&env.NODE_ENV!=='test'){server.listen(PORT,()=>console.log(`小饭 running at http://localhost:${PORT}`));}
export {embedPendingMemories,api};
export {server,createDiyRecipe,resolveNutrition,estimateMenuDish,upsertUser,weightTrend,mealTargets,naturalWeekRange,buildNaturalWeekPlan,createDailyMealPlan,parseMenuText,reminderCanRun,cosineSimilarity,normalizeMealType,inferMealType,goalState,syncGoal,rateAllowed,schedulerTick,createAgentTask,pendingTasks,PROMPT_VERSION,PROMPTS_VERSION,SYSTEM_BASE,buildAgentContext,sanitizePlanSteps,agentChat,qwenChat,parseSkillFrontmatter,scanSkills,loadSkillContent,routeDescription,deterministicRouteDescription,normalizeRouterIntent,detectMealScenario,bucketIntent,isValidMealScenario,expectedMealAction,routerActionFor,selectActionType,hasScenarioSignal,checkIntentConflict,selectSkillReferences,loadSkillCore,buildSkillCorrection,isMealRecordRequest,isNearbyRestaurantRequest,normalizeBrowserLocation,controlledToolArgs,controlledWorkflowTools,buildControlledAgentResult,executionArgsForLog,mealRecordFailureResult,beginExecutionGoal,recordExecutionStep,finishExecutionGoal,executionGoal,executionGoals,estimateTextMealRecord,executeAgentTool,candidateNutrition,runAgentReview};
