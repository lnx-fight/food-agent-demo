const state = {
  currentView: 'today',
  calories: 688,
  protein: 42,
  tasks: { breakfast: true, lunch: false, walk: false },
  mealRequest: '',
  activeMealType: '',
  activeMealDayOffset: 0,
  restaurantRadius: 3000,
  restaurantArea: '',
  restaurantRequestedCount: 5,
  mealHistoryDate: '',
  dailyMealPlanKey: '',
  dailyMealPlanRequest: 0,
  weights: [47,46.9,47.1,47,46.8,47.1,47,46.9,47.2,47,46.9,47.1,47,47],
  target: [47,46.8,46.6,46.4,46.2,46,45.8,45.6,45.4,45.2,45,44.8,44.6,44.4],
  ingredients: ['鸡胸肉','番茄','鸡蛋','米饭']
};

// GitHub Pages 无法运行 Node.js 服务端。部署到 github.io（或本地带 ?demo=1 预览）时，
// 仅使用明确标注的预置演示响应，真实服务端部署保持原有 API 行为。
const DEMO_MODE=location.hostname.endsWith('.github.io')||new URLSearchParams(location.search).has('demo');

const STORAGE_KEY = 'fitpilot_user_v3';
let userData = null;
let onboardingStep = 1;

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const formatNumber=(value,maxDecimals=2)=>{const number=Number(value);if(!Number.isFinite(number))return '0';return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:Math.min(2,Math.max(0,maxDecimals)),useGrouping:false}).format(number)};
function nutritionLevelShort(level='low'){
  return ({high:'来源可靠',medium:'近似匹配',low:'待核验估算'})[level]||'待核验估算';
}
function nutritionLevelNote(level='low'){
  return ({high:'本地库匹配到该菜的营养数据；份量仍按常见外食估算，误差较小',medium:'热量按本地近似菜和常见外食份量估算，用油、酱汁和实际食用量可能造成偏差',low:'本地库和公开菜单未查到这道菜的可靠营养数据，按同类菜估算，实际以实物为准'})[level]||'热量为估算，实际以实物为准';
}
function normalizeDisplayedDecimals(root=document.body){if(!root)return;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);for(const node of nodes){if(['SCRIPT','STYLE'].includes(node.parentElement?.tagName))continue;const next=node.nodeValue.replace(/-?\d+\.\d{3,}/g,value=>formatNumber(value));if(next!==node.nodeValue)node.nodeValue=next}}
new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>normalizeDisplayedDecimals(node.nodeType===Node.TEXT_NODE?node.parentElement:node)))).observe(document.body,{childList:true,subtree:true});document.addEventListener('change',event=>{if(event.target.matches('input[type="number"]')&&event.target.value!==''){const value=Number(event.target.value);if(Number.isFinite(value))event.target.value=formatNumber(value)}});

function showToast(text,duration=2600,icon='✓',extraClass=''){
  const toast=$('#toast');toast.className='toast'+(extraClass?` ${extraClass}`:'');toast.querySelector('p').textContent=text;toast.querySelector('span').textContent=icon;
  toast.onclick=()=>{toast.classList.remove('show');clearTimeout(showToast.timer)};
  requestAnimationFrame(()=>toast.classList.add('show'));
  clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.classList.remove('show'),duration);
}

function switchView(view){
  state.currentView=view;
  $$('.view').forEach(v=>v.classList.remove('active'));
  $(`#${view}View`).classList.add('active');
  $$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===view));
  const titles={today:'今日计划',agent:'Agent 对话',trend:'体重',meals:'饮食与食谱'};
  $('#pageTitle').textContent=titles[view];
  $('.sidebar').classList.remove('open'); window.scrollTo({top:0,behavior:'smooth'});
}

$$('.nav-item').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
$$('[data-view-jump]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.viewJump)));
$('#openAgentBtn').addEventListener('click',()=>switchView('agent'));
$('#mobileMenu').addEventListener('click',()=>$('.sidebar').classList.toggle('open'));

function svgChart(values, target=null, compact=false){
  const normalize=(v)=>Number.isFinite(v)?v:(v&&v.weight!=null?Number(v.weight):NaN);
  const w=compact?300:900,h=compact?60:250,p=compact?2:28,timelineLength=Math.max(values.length,target?.length||0,1);
  const all=[...values.map(normalize),...(target||[])].filter(Number.isFinite),rawMin=Math.min(...all),rawMax=Math.max(...all),min=rawMin-.15,max=rawMax+.15;
  const point=(v,i)=>`${p+i*(w-p*2)/Math.max(1,timelineLength-1)},${p+(max-v)*(h-p*2)/(max-min)}`;
  const actualPoints=values.map((v,i)=>{const value=normalize(v);return Number.isFinite(value)?{v:value,i,date:v?.date||''}:null}).filter(Boolean),actual=actualPoints.map(x=>point(x.v,x.i)).join(' ');
  const targetPoints=(target||[]).map((v,i)=>Number.isFinite(v)?{v,i}:null).filter(Boolean),targetPts=targetPoints.map(x=>point(x.v,x.i)).join(' ');
  const grid=compact?'':Array.from({length:4},(_,i)=>`<line x1="${p}" y1="${p+i*(h-p*2)/3}" x2="${w-p}" y2="${p+i*(h-p*2)/3}" stroke="#e9eee9" stroke-width="1"/>`).join('');
  const labels=compact?'':Array.from({length:timelineLength},(_,i)=>i%Math.max(1,Math.ceil(timelineLength/7))===0?`<text x="${p+i*(w-p*2)/Math.max(1,timelineLength-1)}" y="${h-4}" text-anchor="middle" font-size="9" fill="#8b9b96">${values[i]?.date?String(values[i].date).slice(5):`第${i+1}天`}</text>`:'').join('');
  const pointLabels=actualPoints.map(x=>{const [cx,cy]=point(x.v,x.i).split(','),label=x.date?`${String(x.date).slice(5)} ${x.v.toFixed(1)}kg`:`${x.v.toFixed(1)}kg`;return `<circle cx="${cx}" cy="${cy}" r="${compact?2:3}" fill="#fff" stroke="#1d6b55" stroke-width="2"/>${compact?'':`<text x="${cx}" y="${Number(cy)-9}" text-anchor="middle" font-size="8" font-weight="600" fill="#1d6b55">${label}</text>`}`}).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}${targetPoints.length>1?`<polyline points="${targetPts}" fill="none" stroke="#ed8f70" stroke-width="2" stroke-dasharray="7 7"/>`:''}${actualPoints.length>1?`<polyline points="${actual}" fill="none" stroke="#1d6b55" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`:''}${pointLabels}${labels}</svg>`;
}
$('#mainChart').innerHTML=svgChart(state.weights,state.target,false);

function openModal(id){
  $$('.modal-backdrop').forEach(m=>m.classList.remove('open'));
  if(id==='manualMealModal')prepareMealRecordForm();
  if(id==='weightModal'&&!$('#weightDate').value)prepareWeightRecordForm(localDateKey());
  const m=$(`#${id}`);m.classList.add('open');m.setAttribute('aria-hidden','false');
}
function closeModals(){ $$('.modal-backdrop').forEach(m=>{m.classList.remove('open');m.setAttribute('aria-hidden','true')}) }
$$('[data-close-modal]').forEach(b=>b.addEventListener('click',closeModals));
$$('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModals()}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModals()});

['#lunchBtn','#mealRecommendBtn'].map(id=>$(id)).filter(Boolean).forEach(button=>button.addEventListener('click',()=>{setActiveMealType(mealTypeByTime());openModal('mealChoiceModal')}));
$$('[data-meal-mode]').forEach(b=>b.addEventListener('click',()=>openMealMode(b.dataset.mealMode)));
$$('[data-choice]').forEach(b=>b.addEventListener('click',()=>openMealMode(b.dataset.choice)));
function openMealMode(mode){refreshMealModalTitles();mode==='diy'?openModal('diyModal'):startRestaurantSearch(state.mealRequest,state.activeMealType); }

$('#ingredientInput').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.value.trim()){e.preventDefault();state.ingredients.push(e.target.value.trim());renderIngredients();e.target.value=''}
});
function renderIngredients(){ $('#ingredientTags').innerHTML=state.ingredients.map((x,i)=>`<span data-i="${i}">${x} ×</span>`).join(''); $$('#ingredientTags span').forEach(s=>s.onclick=()=>{state.ingredients.splice(+s.dataset.i,1);renderIngredients()}); }
renderIngredients();

const diyCustomFoods=new Map();
$('#generateRecipeBtn').addEventListener('click',async()=>{
  const btn=$('#generateRecipeBtn'),out=$('#recipeResult');btn.disabled=true;btn.textContent='Agent 正在调用工具…';
  out.innerHTML=`<div class="agent-working"><span class="loader"></span><div><strong>正在规划一份可执行食谱</strong><p>读取营养缺口 → 匹配食材 → 校验热量</p></div></div>`;
  addToolEvent('lookup_nutrition',`查询${state.ingredients.length}种现有食材`);
  try{
    const mealType=suggestedMealType(),futureDay=state.activeMealDayOffset===1,pantry=$$('input[name="diyPantry"]:checked').map(input=>input.value),d=await apiFetch('/api/recipes/diy',{method:'POST',body:JSON.stringify({ingredients:state.ingredients,pantry,customFoods:[...diyCustomFoods.values()],cookTime:$('#cookTime').value,cookTools:$('#cookTools').value,mealType,dayOffset:futureDay?1:0,profile:userData?.profile||{},today:futureDay?{calories:0,protein:0,meals:[]}:{calories:state.calories,protein:state.protein,meals:todayMeals()}})}),r=d.result.recipe,n=r.nutrition,targets=d.result.targets,source=DEMO_MODE?'预置演示方案':d.result.generatedBy==='qwen'?'千问规划＋数据库校验':'规则规划＋数据库校验';
    addToolEvent('compose_home_recipe',`${source} · 匹配${d.result.matched.length}种食材`);addToolEvent('calculate_recipe_nutrition',`${n.kcal} kcal`);
    const ingredients=(r.ingredients||[]).map(x=>`<li>${escapeHtml(x.name)} ${x.grams}g <small>· ${x.kcal} kcal</small></li>`).join(''),steps=(r.steps||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('');
    out.innerHTML=`<div class="lookup-status success">${mealDayLabel()}${escapeHtml(targets.mealType)}动态预算约 ${targets.mealKcal} kcal<span class="api-source">全天 ${targets.dailyTarget} kcal · 已摄入 ${targets.consumedKcal} kcal · 为${targets.futureMeals.join('、')||'后续'}预留 ${targets.reservedKcal} kcal</span></div><div class="recipe-result"><div class="recipe-cover"><div><small>真实食材匹配 · ${escapeHtml(source)}</small><h3>${escapeHtml(r.name)}</h3><p>使用现有食材 · 预计${Number(r.minutes)||20}分钟</p></div><span>约 ${n.kcal} kcal</span></div><div class="recipe-body"><div class="recipe-macros"><span>蛋白质 ${n.protein}g</span><span>碳水 ${n.carbs}g</span><span>脂肪 ${n.fat}g</span></div><div class="recipe-columns"><div><h4>食材与克数</h4><ul>${ingredients}</ul></div><div><h4>烹饪步骤</h4><ol>${steps}</ol></div></div><div class="confirm-row"><strong>加入${mealDayLabel()}${escapeHtml(targets.mealType)}</strong><button id="acceptRecipe">采用这份食谱</button></div></div></div>`;
    $('#acceptRecipe').onclick=()=>acceptMeal(r.name,n.kcal,n.protein,'DIY真实食谱',targets.mealType);
  }catch(e){const missing=e.data?.unmatched||[];if(missing.length){out.innerHTML=`<div class="lookup-status warning">${escapeHtml(e.message)}</div><form id="manualDiyNutrition"><p>请填写包装标签或可靠来源中的每100g营养值：</p>${missing.map((name,i)=>`<fieldset><legend>${escapeHtml(name)}</legend><div class="form-row"><label>热量 kcal<input type="number" name="kcal_${i}" min="0" max="1000" step="0.1" required></label><label>蛋白质 g<input type="number" name="protein_${i}" min="0" max="100" step="0.1" required></label></div><div class="form-row"><label>脂肪 g<input type="number" name="fat_${i}" min="0" max="100" step="0.1" required></label><label>碳水 g<input type="number" name="carbs_${i}" min="0" max="100" step="0.1" required></label></div></fieldset>`).join('')}<button class="primary-btn full" type="submit">使用这些数据重新生成</button><small>仅用于本次食谱，不会写入正式营养数据库。</small></form>`;$('#manualDiyNutrition').onsubmit=event=>{event.preventDefault();const formData=new FormData(event.currentTarget);missing.forEach((name,i)=>diyCustomFoods.set(name,{name,kcal:+formData.get(`kcal_${i}`),protein:+formData.get(`protein_${i}`),fat:+formData.get(`fat_${i}`),carbs:+formData.get(`carbs_${i}`)}));btn.click()}}else out.innerHTML=`<div class="lookup-status error">食谱生成失败：${escapeHtml(e.message)}</div>`}
  finally{btn.disabled=false;btn.textContent='✦ 重新规划'}
});

function acceptMeal(name,cal,protein,source,mealType=suggestedMealType()){
  if(userData){const recordDate=state.activeMealDayOffset===1?localDateKey(new Date(Date.now()+86400000)):localDateKey();userData.mealLogs.push({id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),date:recordDate,type:mealType,name,calories:cal,protein,source,createdAt:new Date().toISOString()});saveUser();rememberAgent('meal_confirmed',{name,calories:cal,protein,mealType,source})}
  else{state.calories+=cal;state.protein+=protein}
  if(mealType==='午餐'&&state.activeMealDayOffset===0)state.tasks.lunch=true;state.mealRequest='';state.activeMealType='';state.activeMealDayOffset=0;closeModals();if(userData)hydrateApp();else updateDashboard();
  const empty=$('.meal-row.empty');if(empty){empty.classList.remove('empty');empty.innerHTML=`<span class="meal-emoji lunch">◐</span><div><strong>${mealType}</strong><p>${name} · ${source}</p></div><span><strong>${cal}</strong><small>kcal</small></span><button>›</button>`}
  addTrace('✓',`记录${mealType}并更新饮食结构`,'update_nutrition_log',`今日已记录 ${state.calories} kcal`);showToast(`${mealType}已加入，Agent已更新今日饮食记录`);
}

function updateDashboard(){
  const energyTarget=Number.isFinite(state.theoreticalTarget)?state.theoreticalTarget:state.energyTarget||1600,progressBase=Math.max(1,energyTarget),proteinTarget=state.proteinTarget||70,caloriePercent=Math.min(100,Math.round(state.calories/progressBase*100)),proteinPercent=Math.min(100,Math.round(state.protein/proteinTarget*100)),remaining=Math.max(0,energyTarget-state.calories);
  $('#calConsumed').textContent=state.calories;$('#proteinConsumed').textContent=state.protein;
  if($('#calorieTargetSummary')){$('#calorieTargetSummary').textContent=`理论建议 ${Math.round(energyTarget)} kcal/天${(userData?.profile?.budgetAdjustmentKcal||0)?`（预算已调整 ${userData.profile.budgetAdjustmentKcal} kcal）`:''}`;$('#calorieRemainingSummary').textContent=state.calories>energyTarget?`已超过理论值 ${Math.round(state.calories-energyTarget)} kcal`:`距理论值约 ${Math.round(remaining)} kcal`;$('#calorieProgressSummary').textContent=`${caloriePercent}%`}
  if($('#theoreticalCalorieSummary'))$('#theoreticalCalorieSummary').textContent=`理论建议：为了在指定日期达到目标，理论上每天摄入约 ${Math.round(energyTarget)} kcal（所需缺口 ${Math.round(state.requiredDeficit||0)} kcal/天）`;
  $('.calorie-ring').style.setProperty('--p',caloriePercent);
  $('.blue-track span').style.width=proteinPercent+'%';
  if($('#mealCalorieText')){$('#mealCalorieText').textContent=`${state.calories} / ${energyTarget} kcal`;$('#mealCalorieProgress').style.width=caloriePercent+'%';$('#mealCalorieRemaining').textContent=state.calories>energyTarget?`超过每日参考 ${state.calories-energyTarget} kcal`:`今日还可安排约 ${remaining} kcal`;$('#mealProteinText').textContent=`${state.protein} / ${proteinTarget} g`;$('#mealProteinProgress').style.width=proteinPercent+'%';$('#nutritionProgressStatus').textContent=state.calories?state.calories>energyTarget?'超过参考':'已同步今日记录':'尚未记录'}
  $$('[data-task]').forEach(c=>c.classList.toggle('done',!!state.tasks[c.dataset.task]));
  $('#taskDoneCount').textContent=Object.values(state.tasks).filter(Boolean).length;
}

$$('.task-card .check').forEach(b=>b.addEventListener('click',()=>{const card=b.closest('[data-task]'),key=card.dataset.task;state.tasks[key]=!state.tasks[key];updateDashboard();showToast(state.tasks[key]?'任务已完成':'已取消完成状态')}));

function addToolEvent(name,result){
  const box=$('#toolEvents');const row=document.createElement('div');row.innerHTML=`<span class="tool-ok">✓</span><p><strong>${name}</strong><small>${result} · ${Math.floor(Math.random()*60+15)}ms</small></p>`;box.appendChild(row);box.scrollTop=box.scrollHeight;
}
function addTrace(icon,title,tool,detail){
  const list=$('#traceList'),item=document.createElement('div');item.className='trace-item';item.innerHTML=`<span class="trace-icon">${icon}</span><div><strong>${title}</strong><p>${detail}</p><small>刚刚 · Agent已更新今日建议</small></div><b>已更新</b>`;list.prepend(item);while(list.children.length>3)list.lastElementChild.remove();addToolEvent(tool,detail);
}

['#quickLogBtn','#addMealBtn'].forEach(id=>{const button=$(id);if(button)button.addEventListener('click',()=>openMealRecord(localDateKey(),mealTypeByTime()))});
$('#uploadInChat').addEventListener('click',()=>$('#chatMealImage').click());
$('#chatMealImage').addEventListener('change',e=>{const file=e.target.files[0],attachment=$('#chatImageAttachment');if(!file){attachment.hidden=true;return}$('#chatImageThumb').src=URL.createObjectURL(file);$('#chatImageName').textContent=file.name;attachment.hidden=false;$('#chatInput').focus()});
$('#removeChatImage').addEventListener('click',()=>{const input=$('#chatMealImage');input.value='';$('#chatImageAttachment').hidden=true;$('#chatImageThumb').removeAttribute('src')});

$('#logWeightBtn').addEventListener('click',()=>prepareWeightRecordForm(localDateKey(),true));

function addMessage(text,user=false,meta='刚刚'){
  const safeText=escapeHtml(text),safeMeta=escapeHtml(meta),wrap=document.createElement('div');wrap.className=`message ${user?'user-message':'agent-message'}`;wrap.innerHTML=user?`<div><p>${safeText}</p><small>${safeMeta}</small></div>`:`<span class="agent-orb tiny"></span><div><p>${safeText}</p><small>${safeMeta}</small></div>`;$('#chatMessages').appendChild(wrap);$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;
  return wrap;
}
function addInlineMealChoices(message,action={}){const body=message?.querySelector(':scope > div');if(!body)return;const applyContext=()=>{if(action.mealType)setActiveMealType(action.mealType,action.dayOffset);state.mealRequest=action.cuisine||state.mealRequest;state.restaurantRadius=Math.min(5000,Math.max(100,Number(action.radiusMeters)||state.restaurantRadius||3000));state.restaurantArea=String(action.area||'').trim();state.restaurantRequestedCount=Math.min(20,Math.max(1,Number(action.requestedCount)||state.restaurantRequestedCount||5))},actions=document.createElement('div');actions.className='inline-meal-actions';actions.innerHTML='<button type="button" data-inline-meal="diy"><span>⌂</span><strong>在家 DIY</strong><small>根据现有食材生成食谱</small></button><button type="button" data-inline-meal="outside"><span>⌖</span><strong>附近餐厅</strong><small>搜索附近餐馆和餐食</small></button>';body.appendChild(actions);actions.querySelector('[data-inline-meal="diy"]').onclick=()=>{applyContext();refreshMealModalTitles();openModal('diyModal')};actions.querySelector('[data-inline-meal="outside"]').onclick=()=>{applyContext();startRestaurantSearch(state.mealRequest,suggestedMealType(),state.activeMealDayOffset,state.restaurantRadius,state.restaurantArea,state.restaurantRequestedCount)};$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight}
function addInlineToolEntry(message,action={}){
  const body=message?.querySelector(':scope > div');if(!body)return;
  const specs={open_diy:['⌂','打开 DIY 食谱工具','用家里现有食材生成下一餐食谱'],open_restaurants:['⌖','查看附近餐食推荐','搜索附近餐馆和推荐餐食'],open_manual_log:['✎','打开手动记录','补记今天已吃的餐食和热量']}[action.type];if(!specs)return;
  const applyContext=()=>{if(action.mealType)setActiveMealType(action.mealType,action.dayOffset);state.mealRequest=String(action.cuisine||'');state.restaurantRadius=Math.min(5000,Math.max(100,Number(action.radiusMeters)||3000));state.restaurantArea=String(action.area||'').trim();state.restaurantRequestedCount=Math.min(20,Math.max(1,Number(action.requestedCount)||5))};
  const entry=document.createElement('div');entry.className='inline-tool-entry';
  entry.innerHTML=`<button type="button"><span>${specs[0]}</span><div><strong>${specs[1]}</strong><small>${specs[2]}</small></div><b>打开 →</b></button>`;
  entry.querySelector('button').onclick=()=>{applyContext();if(action.type==='open_diy'){refreshMealModalTitles();openModal('diyModal')}else if(action.type==='open_restaurants'){startRestaurantSearch(state.mealRequest,suggestedMealType(),state.activeMealDayOffset,state.restaurantRadius,state.restaurantArea,state.restaurantRequestedCount)}else if(action.type==='open_manual_log'){openMealRecord(localDateKey(),suggestedMealType())}};
  body.appendChild(entry);$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;
}
$('#chatForm').addEventListener('submit',e=>{e.preventDefault();const input=$('#chatInput'),text=input.value.trim(),file=$('#chatMealImage').files[0];if(file){input.value='';handleChatMealImage(file,text);return}if(text){input.value='';handleAgentPrompt(text)}});
$$('.suggestion-chips button').forEach(b=>b.onclick=()=>handleAgentPrompt(b.textContent));
$('#clearChat').onclick=()=>{$('#chatMessages').innerHTML='';showToast('对话已清空，长期健康记忆仍保留')};

$('#notificationBtn').onclick=()=>showToast('下次提醒：11:30 午餐规划');
$('#profileBtn').onclick=()=>showToast('测试档案：22岁女性 · 157.5cm · 47kg');

updateDashboard();

// ==== 服务器端 Agent 同步：clientId / 状态同步 / 主动提醒 / 经历记忆 ====
const CLIENT_ID=(()=>{let id=localStorage.getItem('fitpilot_client_id');if(!id){id=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2));localStorage.setItem('fitpilot_client_id',id)}return id})();
let serverSyncTimer=null;
function scheduleServerSync(){clearTimeout(serverSyncTimer);serverSyncTimer=setTimeout(()=>syncUserToServer(),500)}
async function syncUserToServer(){if(!userData)return;try{await apiFetch('/api/user/state',{method:'PUT',body:JSON.stringify({clientId:CLIENT_ID,profile:userData.profile,mealLogs:userData.mealLogs||[],weightLogs:userData.weightLogs||[],chatHistory:userData.chatHistory||[],pendingMealEstimate:userData.pendingMealEstimate||null})})}catch(e){console.warn('服务器同步失败：',e.message)}}
function adoptServerState(state){
  if(!state)return;
  userData={profile:state.profile||{},weightLogs:Array.isArray(state.weightLogs)?state.weightLogs:[],mealLogs:Array.isArray(state.mealLogs)?state.mealLogs:[],chatHistory:Array.isArray(state.chatHistory)?state.chatHistory:[],pendingMealEstimate:state.pendingMealEstimate||null,createdAt:state.createdAt||new Date().toISOString()};
  localStorage.setItem(STORAGE_KEY,JSON.stringify(userData));
  $('#onboarding')?.classList.add('hidden');hydrateApp();restoreAgentConversation();
}
async function loadServerUser(){try{const d=await apiFetch(`/api/user/state?clientId=${encodeURIComponent(CLIENT_ID)}`);if(d.ok&&d.state){if(!userData)adoptServerState(d.state);else scheduleServerSync()}}catch(e){}}
function rememberAgent(kind,payload={}){if(!userData)return;apiFetch('/api/agent/memory',{method:'POST',body:JSON.stringify({clientId:CLIENT_ID,kind,date:localDateKey(),payload})}).catch(()=>{})}
async function pollAgent(){
  if(!userData)return;
  try{
    const d=await apiFetch(`/api/agent/check?clientId=${encodeURIComponent(CLIENT_ID)}`);
    if(Number.isFinite(Number(d.adjustment))){userData.profile.budgetAdjustmentKcal=Number(d.adjustment);updateDashboard()}
    if(d.tasks?.length)showAgentReminder(d.tasks);
  }catch(e){}
}
async function runDailyReview(){
  if(!userData||localStorage.getItem('fitpilot_reviewed_'+localDateKey()))return;
  try{const d=await apiFetch('/api/agent/review',{method:'POST',body:JSON.stringify({clientId:CLIENT_ID})});if(d.result?.adjustment!=null){userData.profile.budgetAdjustmentKcal=d.result.adjustment;updateDashboard()}localStorage.setItem('fitpilot_reviewed_'+localDateKey(),'1')}catch(e){}
}
function connectAgentEvents(){
  if(DEMO_MODE||!userData||typeof EventSource==='undefined')return;
  try{
    const es=new EventSource(`/api/agent/events?clientId=${encodeURIComponent(CLIENT_ID)}`);
    es.addEventListener('agent',e=>{
      try{const d=JSON.parse(e.data);if(d.type==='tasks'&&Array.isArray(d.tasks)&&d.tasks.length)showAgentReminder(d.tasks)}catch(_){}
    });
    es.onerror=()=>{es.close();setTimeout(connectAgentEvents,30000)};
  }catch(_){}
}
setInterval(pollAgent,60_000);
const seenAgentTaskIds=new Set();
function showAgentReminder(tasks){
  const fresh=(Array.isArray(tasks)?tasks:[]).filter(t=>t&&t.id&&!seenAgentTaskIds.has(String(t.id)));
  if(!fresh.length)return;
  fresh.forEach(t=>seenAgentTaskIds.add(String(t.id)));
  const lines=fresh.map(t=>String(t.payload?.text||t.kind||'有新的建议')).filter(Boolean);
  showToast(`Agent提醒：${lines.join('；')}`,8000,'✦','agent');
  addToolEvent('agent_proactive',lines[0]);
}
let agentLogFilter='';
async function loadAgentLogs(){
  const list=$('#agentLogsList');if(!list)return;
  list.innerHTML='<p class="hint">正在加载日志…</p>';
  try{
    const d=await apiFetch(`/api/agent/logs?clientId=${encodeURIComponent(CLIENT_ID)}&limit=300${agentLogFilter?`&kind=${encodeURIComponent(agentLogFilter)}`:''}`);
    const logs=Array.isArray(d.logs)?d.logs:[];
    if(!logs.length){list.innerHTML='<p class="hint">暂无日志记录。使用 Agent 对话或工具后会自动记录。</p>';return}
    list.innerHTML=logs.map(log=>{
      const ok=log.kind==='agent_tool'&&/^[a-z_]+:ok$/i.test(String(log.detail||''));
      const icon=log.kind==='agent_tool'?(ok?'✓':'✕'):log.kind==='agent_skill'?'✧':log.kind==='agent_review'?'↻':log.kind==='agent_chat_done'?'⌁':log.kind==='agent_chat_start'?'◒':'·';
      const title=log.kind==='agent_tool'?(ok?'工具调用成功':'工具调用失败'):log.kind==='agent_skill'?'技能命中':log.kind==='agent_chat_start'?'对话开始':log.kind==='agent_chat_done'?'执行轨迹':log.kind==='agent_review'?'预算复盘':'日志';
      const time=log.createdAt?new Date(log.createdAt).toLocaleString('zh-CN',{hour12:false}):'';
      return `<div class="log-item ${log.kind==='agent_tool'&&!ok?'log-fail':''}"><span class="log-icon">${icon}</span><div><strong>${title}</strong><code>${escapeHtml(log.detail||'')}</code></div><small>${time}</small></div>`;
    }).join('');
  }catch(e){list.innerHTML=`<p class="hint">加载失败：${escapeHtml(e.message)}</p>`}
}
$('#openAgentLogs')?.addEventListener('click',()=>{openModal('agentLogsModal');loadAgentLogs()});
$('#refreshAgentLogs')?.addEventListener('click',loadAgentLogs);
$$('#logsFilter button').forEach(b=>b.addEventListener('click',()=>{agentLogFilter=b.dataset.kind||'';$$('#logsFilter button').forEach(x=>x.classList.toggle('active',x===b));loadAgentLogs()}));
// --- Usable web app layer: onboarding, persistence and real user state ---

function localDateKey(date=new Date()){
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function relativeDateKey(offset){const date=new Date();date.setDate(date.getDate()+offset);return localDateKey(date)}
function dateDisplay(date){return date===localDateKey()?'今天':date===relativeDateKey(-1)?'昨日':date}
function shiftDateKey(dateKey,offset){const [year,month,day]=String(dateKey).split('-').map(Number),date=new Date(year,month-1,day,12);date.setDate(date.getDate()+offset);return localDateKey(date)}
function recentWeightWindow(days=14){
  const byDate=new Map((userData?.weightLogs||[]).map(x=>[x.date,Number(x.weight)]));
  const today=localDateKey();
  return Array.from({length:days},(_,i)=>{const date=shiftDateKey(today,i-(days-1));return {date,weight:byDate.has(date)?byDate.get(date):null}});
}
function prepareWeightRecordForm(date=localDateKey(),shouldOpen=false){
  const input=$('#weightDate'),existing=userData?.weightLogs?.find(x=>x.date===date),latest=userData?.weightLogs?.slice().sort((a,b)=>a.date.localeCompare(b.date)).at(-1);
  input.max=localDateKey();input.value=date;$('#weightInput').value=existing?.weight??latest?.weight??userData?.profile?.weight??'';
  $('#weightRecordHint').textContent=date===localDateKey()?'建议在起床、如厕后和进食前称重。':'这是历史补登；系统会保存数据所属日期和实际补登时间。';
  if(shouldOpen)openModal('weightModal');
}
function prepareMealRecordForm(date=''){
  const input=$('#manualMealForm').elements.date,today=localDateKey();input.max=today;if(!date)date=input.value&&input.value<=today?input.value:today;input.value=date;
}
function openMealRecord(date=localDateKey(),type=mealTypeByTime()){
  setActiveMealType(type);const form=$('#manualMealForm');form.reset();delete form.dataset.editingId;clearMealNutritionState(form);form.elements.type.value=type;prepareMealRecordForm(date);form.querySelector('[type="submit"]').textContent='保存并让Agent更新计划';openModal('manualMealModal');
}
function clearMealNutritionState(form){for(const key of ['kcalPer100','proteinPer100','nutritionBasis','nutritionSource','matchedReference'])delete form.dataset[key]}
function daysBetween(a,b){ return Math.max(1,Math.ceil((new Date(b)-new Date(a))/86400000)); }
function calculateProfile(profile){
  const h=profile.height/100;
  const bmi=profile.weight/(h*h), targetBmi=profile.targetWeight/(h*h);
  const days=daysBetween(localDateKey(),profile.targetDate);
  const weekly=Math.max(0,(profile.weight-profile.targetWeight)/days*7);
  const base=10*profile.weight+6.25*profile.height-5*profile.age+(profile.sex==='male'?5:-161);
  const factors={sedentary:1.2,light:1.375,moderate:1.55,active:1.725};
  const tdee=Math.round(base*(factors[profile.activity]||1.2));
  const requiredDeficit=Math.max(0,Math.round((profile.weight-profile.targetWeight)*7700/days)),theoreticalTarget=tdee-requiredDeficit,dailyTarget=Math.max(0,theoreticalTarget+(Number(profile.budgetAdjustmentKcal)||0)),actualDeficit=Math.max(0,tdee-dailyTarget),loss=Math.max(0,profile.weight-profile.targetWeight),estimatedDays=loss===0?0:actualDeficit>0?Math.ceil(loss*7700/actualDeficit):null,estimatedDate=estimatedDays==null?null:localDateKey(new Date(Date.now()+estimatedDays*86400000));
  return {bmi,targetBmi,days,weekly,tdee,requiredDeficit,theoreticalTarget,dailyTarget,actualDeficit,estimatedDays,estimatedDate,protein:Math.round(profile.weight*1.3)};
}
function saveUser(){ if(userData)localStorage.setItem(STORAGE_KEY,JSON.stringify(userData)); scheduleServerSync(); }
function loadUser(){ try{return JSON.parse(localStorage.getItem(STORAGE_KEY))}catch{return null} }
function todayMeals(){ return (userData?.mealLogs||[]).filter(x=>x.date===localDateKey()); }
function mealTypeByTime(){const h=new Date().getHours();return h<10?'早餐':h<16?'午餐':'晚餐'}
function normalizeClientMealType(value=''){const text=String(value);if(/早/.test(text))return '早餐';if(/午|中午/.test(text))return '午餐';if(/晚餐|晚饭|晚上|今晚|明晚/.test(text))return '晚餐';if(/其他摄入|加餐|零食|夜宵|饮料/.test(text))return '其他摄入';return ''}
function suggestedMealType(){return normalizeClientMealType(state.activeMealType)||mealTypeByTime()}
function setActiveMealType(value,dayOffset=state.activeMealDayOffset){state.activeMealType=normalizeClientMealType(value)||mealTypeByTime();state.activeMealDayOffset=Number(dayOffset)===1?1:0;refreshMealModalTitles()}
function mealDayLabel(){return state.activeMealDayOffset===1?'明天':'今天'}
function refreshMealModalTitles(){const type=suggestedMealType(),day=mealDayLabel(),diy=$('#diyModal .modal-head h2'),outside=$('#outsideModal .modal-head h2');if(diy)diy.textContent=`用家里的食材做${day}${type}`;if(outside)outside.textContent=`附近适合你的${day}${type}`}
function removeTastePreferenceClauses(value=''){return String(value).split(/[、,，;；。\n]+/).map(x=>x.trim()).filter(x=>x&&!/(?:不吃辣|不能吃辣|怕辣|爱吃辣|喜欢吃辣|喜欢辣|偏好辣味|不辣|微辣|中辣|重辣|特辣)/.test(x)).join('、')}
function habitWithoutOldTaste(value=''){return String(value).split(/[、,，;；。\n]+/).map(x=>x.trim()).filter(x=>x&&!/^(?:我)?(?:平时)?(?:不吃辣|不能吃辣|怕辣|爱吃辣|喜欢吃辣|喜欢辣|偏好辣味|不辣|微辣|中辣|重辣|特辣)$/.test(x)).join('、')}
function migrateTasteProfile(profile){if(!profile)return false;let changed=false;if(!profile.tastePreference){const old=String(profile.preferences||'');profile.tastePreference=/重辣|特辣/.test(old)?'重辣':/中辣|爱吃辣|喜欢吃辣|喜欢辣/.test(old)?'中辣':/微辣/.test(old)?'微辣':'不辣';changed=true}const cleaned=removeTastePreferenceClauses(profile.preferences);if(cleaned!==String(profile.preferences||'')){profile.preferences=cleaned;changed=true}return changed}

function initOnboarding(){
  const date=new Date();date.setDate(date.getDate()+30);
  const dateInput=$('[name="targetDate"]');dateInput.min=localDateKey(new Date(Date.now()+86400000));dateInput.value=localDateKey(date);
  renderOnboardingStep();
}
function validateStep(step){
  const fields=$$(`.form-step[data-step="${step}"] input, .form-step[data-step="${step}"] select, .form-step[data-step="${step}"] textarea`);
  for(const field of fields){if(!field.checkValidity()){field.reportValidity();return false}}
  return true;
}
function renderOnboardingStep(){
  $$('.form-step').forEach(s=>s.classList.toggle('active',+s.dataset.step===onboardingStep));
  $$('.steps i').forEach((s,i)=>s.classList.toggle('active',i<onboardingStep));
  $('#prevStep').disabled=onboardingStep===1;$('#nextStep').style.display=onboardingStep===3?'none':'inline-block';$('#finishOnboarding').style.display=onboardingStep===3?'inline-block':'none';
  if(onboardingStep===3)renderFinalEvaluation();
}
function onboardingValues(){
  const f=new FormData($('#onboardingForm'));
  return {name:f.get('name'),age:+f.get('age'),sex:f.get('sex'),height:+f.get('height'),weight:+f.get('weight'),targetWeight:+f.get('targetWeight'),targetDate:f.get('targetDate'),activity:f.get('activity'),mealMode:f.get('mealMode'),habit:f.get('habit')||'',preferences:f.get('preferences')||'',startDate:localDateKey()};
}
function renderFinalEvaluation(){
  const p=onboardingValues(),m=calculateProfile(p),box=$('#finalEvaluation');
  box.className='final-evaluation';
  box.innerHTML=`<strong>理论计划已计算</strong><br>当前BMI ${m.bmi.toFixed(2)}，目标BMI ${m.targetBmi.toFixed(2)}，理论目标速度约 ${m.weekly.toFixed(2)} kg/周，每日理论摄入约 ${m.theoreticalTarget} kcal。`;
}
$('#nextStep').addEventListener('click',()=>{if(validateStep(onboardingStep)){onboardingStep++;renderOnboardingStep()}});
$('#prevStep').addEventListener('click',()=>{onboardingStep=Math.max(1,onboardingStep-1);renderOnboardingStep()});
$('#onboardingForm').addEventListener('submit',e=>{
  e.preventDefault();if(!validateStep(3))return;
  const profile=onboardingValues();
  userData={profile,weightLogs:[{date:localDateKey(),weight:profile.weight,createdAt:new Date().toISOString()}],mealLogs:[],chatHistory:[],createdAt:new Date().toISOString()};
  saveUser();$('#onboarding').classList.add('hidden');hydrateApp();showToast('建档完成，Agent已生成你的第一份计划');
});

function hydrateApp(){
  if(!userData)return;
  const p=userData.profile,m=calculateProfile(p),weights=userData.weightLogs||[],latest=weights.length?weights[weights.length-1].weight:p.weight;
  if(migrateTasteProfile(p))saveUser();
  p.weight=latest;
  const meals=todayMeals();state.calories=meals.reduce((a,x)=>a+x.calories,0);state.protein=meals.reduce((a,x)=>a+x.protein,0);
  state.energyTarget=m.dailyTarget;state.proteinTarget=m.protein;state.theoreticalTarget=m.theoreticalTarget;state.requiredDeficit=m.requiredDeficit;state.estimatedDate=m.estimatedDate;
  state.weights=recentWeightWindow(14);
  const planLength=Math.min(366,Math.max(2,m.days+1)),startWeight=latest,totalLoss=startWeight-p.targetWeight,slope=planLength>1?totalLoss/(planLength-1):0;state.target=Array.from({length:state.weights.length},(_,i)=>+(startWeight+slope*(state.weights.length-1-i)).toFixed(2));
  $('.profile-row .avatar').textContent=(p.name||'我').slice(0,1);$('.profile-row strong').textContent=p.name;$('.profile-row small').textContent=`${p.age}岁${p.sex==='female'?'女性':'男性'} · ${p.height} cm`;
  $('.brief-top h1').textContent=`你好，${p.name}`;$('.brief-top .status-pill').textContent='理论计划运行中';
  $('#currentWeight').textContent=latest.toFixed(1);$('.goal-main small').textContent=`当前 BMI ${(latest/((p.height/100)**2)).toFixed(2)}`;
  const goalStart=weights[0]?.weight||p.weight,goalPct=goalStart>p.targetWeight?Math.max(0,Math.min(100,(goalStart-latest)/(goalStart-p.targetWeight)*100)):0;
  $('.goal-card .card-heading small').textContent=`还剩 ${m.days} 天 · 进度 ${Math.round(goalPct)}%`;$('.goal-card .progress-track span').style.width=Math.round(goalPct)+'%';$('.goal-labels').innerHTML=`<span>起始 ${goalStart.toFixed(1)} kg</span><span>当前 ${latest.toFixed(1)} kg</span><span>目标 ${p.targetWeight.toFixed(1)} kg</span>`;
  $('.metric-head small').textContent=`理论目标 ${m.dailyTarget} kcal`;
  const proteinHead=$('.metric-card:nth-child(2) .metric-head small');if(proteinHead)proteinHead.textContent=`参考目标 ${m.protein}g`;
  $('.protein-row small').textContent=`还需约 ${Math.max(0,m.protein-state.protein)}g`;
  $('#agentBrief').innerHTML=`你的理论目标速度约为每周 <strong>${m.weekly.toFixed(2)} kg</strong>，理论每日摄入约 <strong>${m.theoreticalTarget} kcal</strong>。`;
  $('#briefReason').textContent=`按当前体重、活动水平和剩余 ${m.days} 天计算`;
  $('.agent-state').innerHTML=`<h3>当前目标</h3><div class="state-row"><span>档案</span><strong>${p.age}岁${p.sex==='female'?'女性':'男性'} · ${p.height}cm</strong></div><div class="state-row"><span>目标</span><strong>${latest} → ${p.targetWeight} kg / ${m.days}天</strong></div><div class="state-row"><span>策略</span><strong>理论热量计划</strong></div>`;
  const currentMemory=[p.activity==='sedentary'?'久坐':p.activity==='light'?'轻度活动':p.activity==='moderate'?'中度活动':p.activity==='active'?'活跃':p.activity,habitWithoutOldTaste(p.habit),p.tastePreference,p.preferences,p.dislikedFoods&&`不喜欢：${p.dislikedFoods}`,p.allergies&&`忌口：${p.allergies}`,p.mealMode==='home'?'主要在家做':p.mealMode==='outside'?'主要外食':'混合饮食'];
  $('.memory-tags').innerHTML=currentMemory.filter(Boolean).map(x=>`<span>${escapeHtml(x)}</span>`).join('');
  $('.memory-title small').textContent=`${$('.memory-tags').children.length}项`;
  $('#mainChart').innerHTML=svgChart(state.weights,state.target,false);
  $('.trend-summary').innerHTML=`<article><small>当前体重</small><strong>${latest.toFixed(1)} <i>kg</i></strong><span>当前BMI ${(latest/((p.height/100)**2)).toFixed(2)}</span></article><article><small>记录次数</small><strong>${weights.length}</strong><span>${weights.length<7?'积累7条后分析趋势':'可分析7日趋势'}</span></article><article><small>理论目标速度</small><strong>${m.weekly.toFixed(2)} <i>kg/周</i></strong><span>按剩余日期反推</span></article><article><small>目标BMI</small><strong>${m.targetBmi.toFixed(2)}</strong><span>由目标体重计算</span></article>`;
  renderRecordStatus();
  $('.date-block small').textContent=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());
  renderMealLogs();renderMealHistory();renderDailyMealPlan();updateDashboard();
}
function escapeHtml(v){const d=document.createElement('div');d.textContent=String(v);return d.innerHTML}
function extractCuisinePreference(text){return ['中餐','东北菜','川菜','湘菜','粤菜','火锅','烧烤','日料','日本料理','韩餐','西餐','面食','轻食'].find(type=>String(text).includes(type))||''}

function renderRecordStatus(){
  const panel=$('#recordStatusPanel');if(!panel||!userData)return;const date=relativeDateKey(-1),weight=userData.weightLogs?.find(x=>x.date===date),meals=(userData.mealLogs||[]).filter(x=>x.date===date),mealCalories=meals.reduce((sum,x)=>sum+(Number(x.calories)||0),0),missing=Number(!weight)+Number(!meals.length);
  panel.querySelector('.status-pill').textContent=missing?`${missing}项未记录`:'均已记录';
  panel.querySelector('.record-status-grid').innerHTML=`<div class="record-status-item ${weight?'recorded':''}"><span>↘</span><div><strong>昨日体重</strong><small>${weight?`${Number(weight.weight).toFixed(1)} kg${weight.source==='manual_backfill'?' · 已补登':''}`:'未记录（不会按 0 kg 计算）'}</small></div><button type="button" data-backfill-weight>${weight?'修改':'补登'}</button></div><div class="record-status-item ${meals.length?'recorded':''}"><span>◒</span><div><strong>昨日饮食</strong><small>${meals.length?`已记录 ${meals.length} 餐 · ${mealCalories} kcal${meals.some(x=>x.source==='manual_backfill')?' · 含补登':''}`:'未记录（不会按 0 kcal 计算）'}</small></div><button type="button" data-backfill-meal>${meals.length?'查看':'补登'}</button></div>`;
  panel.querySelector('[data-backfill-weight]').onclick=()=>prepareWeightRecordForm(date,true);
  panel.querySelector('[data-backfill-meal]').onclick=()=>{if(!meals.length)return openMealRecord(date);state.mealHistoryDate=date;switchView('meals');renderMealHistory()};
}

async function renderDailyMealPlanLegacy(force=false){
  if(!userData||!$('#dailyMealPlanGrid'))return;const meals=todayMeals(),key=JSON.stringify({date:localDateKey(),weight:userData.profile.weight,targetWeight:userData.profile.targetWeight,targetDate:userData.profile.targetDate,activity:userData.profile.activity,preferences:userData.profile.preferences,dislikedFoods:userData.profile.dislikedFoods,allergies:userData.profile.allergies,meals:meals.map(x=>[x.id,x.type,x.name,x.calories,x.protein])});if(!force&&state.dailyMealPlanKey===key&&$('#dailyMealPlanGrid').children.length)return;state.dailyMealPlanKey=key;const request=++state.dailyMealPlanRequest;$('#dailyMealPlanStatus').textContent='正在生成';$('#dailyMealPlanSummary').textContent='正在根据今日理论目标和已记录饮食分配早餐、午餐和晚餐…';$('#dailyMealPlanGrid').innerHTML='<div class="agent-working"><span class="loader"></span><div><strong>生成今日三餐</strong><p>计算动态预算并生成餐食概览</p></div></div>';
  try{const data=await apiFetch('/api/plans/daily-meals',{method:'POST',body:JSON.stringify({profile:userData.profile,today:{calories:meals.reduce((sum,x)=>sum+(Number(x.calories)||0),0),protein:meals.reduce((sum,x)=>sum+(Number(x.protein)||0),0),meals}})});if(request!==state.dailyMealPlanRequest)return;const plan=data.result;$('#dailyMealPlanStatus').textContent=plan.generatedBy==='qwen'?'Agent已生成':'规则建议';$('#dailyMealPlanSummary').textContent=`今日理论目标 ${plan.dailyTarget} kcal · 已记录 ${plan.consumedKcal} kcal · 剩余 ${plan.remainingKcal} kcal${plan.otherConsumedKcal?` · 其他摄入已扣除 ${plan.otherConsumedKcal} kcal`:''}`;$('#dailyMealPlanGrid').innerHTML=plan.meals.map(meal=>{const icon=meal.type==='早餐'?'☀':meal.type==='午餐'?'◐':'☾',completed=meal.status==='recorded'||meal.status==='skipped',actions=completed?'':`<div class="daily-meal-actions"><button type="button" data-plan-diy="${meal.type}">在家 DIY</button><button type="button" data-plan-outside="${meal.type}">附近外食</button></div>`;return `<div class="daily-meal-card ${completed?'recorded':''}"><div class="daily-meal-card-head"><span>${icon}</span><strong>${meal.type}</strong><small>${meal.status==='skipped'?'未吃':completed?'已记录':`建议约 ${meal.mealKcal} kcal`}</small></div><h3>${escapeHtml(meal.name)}</h3><p>${escapeHtml(meal.description)}</p>${actions}</div>`}).join('');$$('[data-plan-diy]').forEach(button=>button.onclick=()=>{setActiveMealType(button.dataset.planDiy,0);refreshMealModalTitles();openModal('diyModal')});$$('[data-plan-outside]').forEach(button=>button.onclick=()=>{setActiveMealType(button.dataset.planOutside,0);startRestaurantSearch('',button.dataset.planOutside,0,state.restaurantRadius,'',state.restaurantRequestedCount)})}catch(error){if(request!==state.dailyMealPlanRequest)return;state.dailyMealPlanKey='';$('#dailyMealPlanStatus').textContent='生成失败';$('#dailyMealPlanSummary').textContent=`暂时无法生成今日三餐：${error.message}`;$('#dailyMealPlanGrid').innerHTML='<button type="button" class="secondary-btn" id="retryDailyMealPlan">重新生成</button>';$('#retryDailyMealPlan').onclick=()=>renderDailyMealPlan(true)}
}

async function loadDailyNearbyRecommendations(plan,meals,request){
  const slots=$$('[data-daily-nearby]');if(!slots.length)return;try{slots.forEach(slot=>slot.innerHTML='<small>正在请求定位并搜索附近餐馆…</small>');const pos=await requestGeolocation(),nearby=await apiFetch(`/api/restaurants/nearby?lat=${pos.latitude}&lng=${pos.longitude}&radius=${state.restaurantRadius}`);if(request!==state.dailyMealPlanRequest)return;await Promise.all(plan.meals.filter(meal=>meal.status==='planned').map(async meal=>{const slot=$(`[data-daily-nearby="${meal.type}"]`);if(!slot)return;try{const data=await apiFetch('/api/restaurants/recommendations',{method:'POST',body:JSON.stringify({restaurants:nearby.results,requestedCount:1,cuisine:'',mealType:meal.type,dayOffset:0,profile:userData.profile,today:{calories:meals.reduce((sum,x)=>sum+(Number(x.calories)||0),0),protein:meals.reduce((sum,x)=>sum+(Number(x.protein)||0),0),meals}})}),restaurant=data.results?.[0];if(!restaurant)throw new Error('附近没有找到该餐次营业的合适门店');const rec=restaurant.recommendation,p=rec.personalization||{},dish=p.mealDisplay||rec.mealStructure||(rec.dishes||[])[0]||'到店查看可选餐食';slot.innerHTML=`<strong>${escapeHtml(restaurant.name)}</strong><span>${Number.isFinite(restaurant.distance)?`${formatNumber(restaurant.distance)}m · `:''}${escapeHtml(restaurant.address||'位置来自高德POI')}</span><p>${escapeHtml(dish)}</p><button type="button" data-more-nearby="${meal.type}">查看更多附近选择</button>`;slot.querySelector('button').onclick=()=>startRestaurantSearch('',meal.type,0,state.restaurantRadius,'',state.restaurantRequestedCount)}catch(error){slot.innerHTML=`<small>${escapeHtml(error.message)}</small><button type="button" data-more-nearby="${meal.type}">手动搜索附近外食</button>`;slot.querySelector('button').onclick=()=>startRestaurantSearch('',meal.type,0,state.restaurantRadius,'',state.restaurantRequestedCount)}}))}catch(error){slots.forEach(slot=>{const type=slot.dataset.dailyNearby;slot.innerHTML=`<small>无法生成附近推荐：${escapeHtml(error.message)}</small><button type="button">授权定位并搜索</button>`;slot.querySelector('button').onclick=()=>startRestaurantSearch('',type,0,state.restaurantRadius,'',1)})}
}

async function renderDailyMealPlan(force=false){
  if(!userData||!$('#dailyMealPlanGrid'))return;const meals=todayMeals(),key=JSON.stringify({date:localDateKey(),weight:userData.profile.weight,targetWeight:userData.profile.targetWeight,targetDate:userData.profile.targetDate,activity:userData.profile.activity,preferences:userData.profile.preferences,dislikedFoods:userData.profile.dislikedFoods,allergies:userData.profile.allergies,meals:meals.map(x=>[x.id,x.type,x.name,x.calories,x.protein,x.status])});if(!force&&state.dailyMealPlanKey===key&&$('#dailyMealPlanGrid').children.length)return;state.dailyMealPlanKey=key;const request=++state.dailyMealPlanRequest;$('#dailyMealPlanStatus').textContent='正在生成';$('#dailyMealPlanSummary').textContent='正在生成DIY菜谱，并准备根据定位匹配附近外食…';$('#dailyMealPlanGrid').innerHTML='<div class="agent-working"><span class="loader"></span><div><strong>生成今日三餐</strong><p>动态预算 → DIY菜谱 → 附近门店与餐食</p></div></div>';
  try{const data=await apiFetch('/api/plans/daily-meals',{method:'POST',body:JSON.stringify({profile:userData.profile,today:{calories:meals.reduce((sum,x)=>sum+(Number(x.calories)||0),0),protein:meals.reduce((sum,x)=>sum+(Number(x.protein)||0),0),meals}})});if(request!==state.dailyMealPlanRequest)return;const plan=data.result;$('#dailyMealPlanStatus').textContent=plan.generatedBy==='qwen'?'Agent已生成':'规则建议';$('#dailyMealPlanSummary').textContent=`今日理论目标 ${formatNumber(plan.dailyTarget)} kcal · 已记录 ${formatNumber(plan.consumedKcal)} kcal · 剩余 ${formatNumber(plan.remainingKcal)} kcal${plan.otherConsumedKcal?` · 其他摄入已扣除 ${formatNumber(plan.otherConsumedKcal)} kcal`:''}`;$('#dailyMealPlanGrid').innerHTML=plan.meals.map(meal=>{const icon=meal.type==='早餐'?'☀':meal.type==='午餐'?'◐':'☾',completed=meal.status==='recorded'||meal.status==='skipped';if(completed)return `<div class="daily-meal-card recorded"><div class="daily-meal-card-head"><span>${icon}</span><strong>${meal.type}</strong><small>${meal.status==='skipped'?'未吃':'已记录'}</small></div><h3>${escapeHtml(meal.name)}</h3><p>${escapeHtml(meal.description)}</p></div>`;const diy=meal.diy||{},ingredients=(diy.ingredients||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join(''),steps=(diy.steps||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('');return `<div class="daily-meal-card"><div class="daily-meal-card-head"><span>${icon}</span><strong>${meal.type}</strong><small>建议约 ${formatNumber(meal.mealKcal)} kcal</small></div><section class="daily-option diy-option"><b>在家 DIY</b><h3>${escapeHtml(diy.name||meal.name)}</h3><div class="daily-recipe"><div><small>食材</small><ul>${ingredients}</ul></div><div><small>步骤</small><ol>${steps}</ol></div></div><button type="button" data-plan-diy="${meal.type}">用现有食材重新规划</button></section><section class="daily-option outside-option"><b>附近外食</b><div data-daily-nearby="${meal.type}"><small>等待定位…</small></div></section></div>`}).join('');$$('[data-plan-diy]').forEach(button=>button.onclick=()=>{setActiveMealType(button.dataset.planDiy,0);refreshMealModalTitles();openModal('diyModal')});loadDailyNearbyRecommendations(plan,meals,request)}catch(error){if(request!==state.dailyMealPlanRequest)return;state.dailyMealPlanKey='';$('#dailyMealPlanStatus').textContent='生成失败';$('#dailyMealPlanSummary').textContent=`暂时无法生成今日三餐：${error.message}`;$('#dailyMealPlanGrid').innerHTML='<button type="button" class="secondary-btn" id="retryDailyMealPlan">重新生成</button>';$('#retryDailyMealPlan').onclick=()=>renderDailyMealPlan(true)}
}

function renderMealHistory(){
  if(!userData||!$('#mealHistoryList'))return;const today=localDateKey();if(!state.mealHistoryDate||state.mealHistoryDate>today)state.mealHistoryDate=today;const date=state.mealHistoryDate,input=$('#mealHistoryDate');input.max=today;input.value=date;$('#mealHistoryNext').disabled=date>=today;
  const meals=(userData.mealLogs||[]).filter(x=>x.date===date),calories=meals.reduce((sum,x)=>sum+(Number(x.calories)||0),0),protein=meals.reduce((sum,x)=>sum+(Number(x.protein)||0),0),label=dateDisplay(date);
  const eaten=meals.filter(x=>x.status!=='skipped'),skipped=meals.filter(x=>x.status==='skipped');$('#mealHistorySummary').textContent=meals.length?`${label}已记录 ${eaten.length} 餐${skipped.length?` · ${skipped.length} 餐未吃`:''} · ${Math.round(calories)} kcal · 蛋白质 ${protein.toFixed(1)}g`:`${label}未记录饮食；未记录不等于摄入 0 kcal。`;
  const rows=[];for(const type of ['早餐','午餐','晚餐']){const records=meals.filter(x=>normalizeClientMealType(x.type)===type);if(!records.length)rows.push(mealHistoryEmptyRow(type));else rows.push(...records.map(mealHistoryRecordRow))}const other=meals.filter(x=>normalizeClientMealType(x.type)==='其他摄入');if(other.length)rows.push(...other.map(mealHistoryRecordRow));$('#mealHistoryList').innerHTML=rows.join('');
  $$('[data-edit-history-meal]').forEach(button=>button.onclick=()=>editMealRecord(button.dataset.editHistoryMeal));
  $$('[data-delete-history-meal]').forEach(button=>button.onclick=()=>{userData.mealLogs=userData.mealLogs.filter(x=>x.id!==button.dataset.deleteHistoryMeal);saveUser();hydrateApp();showToast('饮食记录已删除')});
  $$('[data-add-history-type]').forEach(button=>button.onclick=()=>openMealRecord(date,button.dataset.addHistoryType));
  $$('[data-skip-history-type]').forEach(button=>button.onclick=()=>markMealSkipped(date,button.dataset.skipHistoryType));
}
function mealHistoryEmptyRow(type){return `<div class="meal-row empty"><span class="meal-emoji ${type==='早餐'?'breakfast':type==='午餐'?'lunch':'dinner'}">${type==='早餐'?'☀':type==='午餐'?'◐':'☾'}</span><div><strong>${type}</strong><p>未记录</p></div><div class="meal-history-actions"><button type="button" data-add-history-type="${type}">补登</button><button type="button" data-skip-history-type="${type}">未吃</button></div></div>`}
function mealHistoryRecordRow(x){const type=normalizeClientMealType(x.type)||x.type;if(x.status==='skipped')return `<div class="meal-row empty skipped"><span class="meal-emoji ${type==='早餐'?'breakfast':type==='午餐'?'lunch':'dinner'}">${type==='早餐'?'☀':type==='午餐'?'◐':'☾'}</span><div><strong>${escapeHtml(type)}</strong><p>本餐未吃 · 已确认</p></div><div class="meal-history-actions"><button type="button" data-delete-history-meal="${x.id}">撤销</button></div></div>`;return `<div class="meal-row"><span class="meal-emoji ${type==='早餐'?'breakfast':type==='午餐'?'lunch':type==='晚餐'?'dinner':'snack'}">${type==='早餐'?'☀':type==='午餐'?'◐':type==='晚餐'?'☾':'◇'}</span><div><strong>${escapeHtml(type)}</strong><p>${escapeHtml(x.name)}${x.amount?` · ${x.amount}${escapeHtml(x.unit||'g')}`:''}${x.source==='manual_backfill'?' · 补登':''}</p></div><span><strong>${Number(x.calories)||0}</strong><small>kcal · ${Number(x.protein)||0}g蛋白质</small></span><div class="meal-history-actions"><button type="button" data-edit-history-meal="${x.id}">修改</button><button type="button" data-delete-history-meal="${x.id}">删除</button></div></div>`}
function markMealSkipped(date,type){
  if(!userData||!['早餐','午餐','晚餐'].includes(type)||date>localDateKey())return;const existing=(userData.mealLogs||[]).some(x=>x.date===date&&normalizeClientMealType(x.type)===type);if(existing)return showToast(`${dateDisplay(date)}${type}已有记录，请先修改或删除原记录`);const now=new Date().toISOString();userData.mealLogs.push({id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),date,type,name:'本餐未吃',calories:0,protein:0,status:'skipped',source:date<localDateKey()?'meal_skipped_backfill':'meal_skipped',recordedAt:now,createdAt:now});state.mealHistoryDate=date;saveUser();hydrateApp();addTrace('✓',`标记${dateDisplay(date)}${type}未吃`,'skip_meal',`${date} · ${type}`);showToast(`已标记${dateDisplay(date)}${type}未吃`)
}
function editMealRecord(id){
  const log=userData?.mealLogs?.find(x=>x.id===id);if(!log)return;const form=$('#manualMealForm');form.reset();clearMealNutritionState(form);form.dataset.editingId=id;form.elements.date.value=log.date;form.elements.type.value=normalizeClientMealType(log.type)||'其他摄入';form.elements.name.value=log.name;form.elements.grams.value=log.amount||100;if(form.elements.unit)form.elements.unit.value=log.unit||'g';form.elements.calories.value=log.calories;form.elements.protein.value=log.protein||0;prepareMealRecordForm(log.date);form.querySelector('[type="submit"]').textContent='保存修改';openModal('manualMealModal');
}

$('#mealHistoryPrev').onclick=()=>{state.mealHistoryDate=shiftDateKey(state.mealHistoryDate||localDateKey(),-1);renderMealHistory()};
$('#mealHistoryNext').onclick=()=>{state.mealHistoryDate=shiftDateKey(state.mealHistoryDate||localDateKey(),1);renderMealHistory()};
$('#mealHistoryToday').onclick=()=>{state.mealHistoryDate=localDateKey();renderMealHistory()};
$('#mealHistoryDate').onchange=e=>{state.mealHistoryDate=e.target.value||localDateKey();renderMealHistory()};
$('#mealHistoryAdd').onclick=()=>openMealRecord(state.mealHistoryDate||localDateKey());

function renderMealLogs(){
  if(!userData)return;const meals=todayMeals(),list=$('#mealList');
  const rows=[];for(const type of ['早餐','午餐','晚餐']){const records=meals.filter(x=>normalizeClientMealType(x.type)===type);if(!records.length)rows.push(`<div class="meal-row empty"><span class="meal-emoji ${type==='早餐'?'breakfast':type==='午餐'?'lunch':'dinner'}">${type==='早餐'?'☀':type==='午餐'?'◐':'☾'}</span><div><strong>${type}</strong><p>未记录</p></div><div class="meal-history-actions"><button data-add-today-type="${type}">记录</button><button data-skip-today-type="${type}">未吃</button></div></div>`);else rows.push(...records.map(x=>x.status==='skipped'?`<div class="meal-row empty skipped"><span class="meal-emoji ${type==='早餐'?'breakfast':type==='午餐'?'lunch':'dinner'}">${type==='早餐'?'☀':type==='午餐'?'◐':'☾'}</span><div><strong>${type}</strong><p>本餐未吃 · 已确认</p></div><button data-delete-meal="${x.id}">撤销</button></div>`:`<div class="meal-row"><span class="meal-emoji ${type==='早餐'?'breakfast':type==='午餐'?'lunch':'dinner'}">${type==='早餐'?'☀':type==='午餐'?'◐':'☾'}</span><div><strong>${type}</strong><p>${escapeHtml(x.name)}${x.amount?` · ${x.amount}${escapeHtml(x.unit||'g')}`:''}</p></div><span><strong>${x.calories}</strong><small>kcal · ${x.protein}g蛋白质</small></span><button data-delete-meal="${x.id}">×</button></div>`))}const other=meals.filter(x=>normalizeClientMealType(x.type)==='其他摄入');rows.push(...other.map(x=>`<div class="meal-row"><span class="meal-emoji snack">◇</span><div><strong>其他摄入</strong><p>${escapeHtml(x.name)}${x.amount?` · ${x.amount}${escapeHtml(x.unit||'g')}`:''}</p></div><span><strong>${x.calories}</strong><small>kcal · ${x.protein}g蛋白质</small></span><button data-delete-meal="${x.id}">×</button></div>`));list.innerHTML=rows.join('');
  $$('[data-add-today-type]').forEach(button=>button.onclick=()=>openMealRecord(localDateKey(),button.dataset.addTodayType));
  $$('[data-skip-today-type]').forEach(button=>button.onclick=()=>markMealSkipped(localDateKey(),button.dataset.skipTodayType));
  $$('[data-delete-meal]').forEach(b=>b.onclick=()=>{userData.mealLogs=userData.mealLogs.filter(x=>x.id!==b.dataset.deleteMeal);saveUser();hydrateApp();showToast('这条饮食记录已删除')});
}

// Replace showcase-only record buttons with usable manual logging.
function replaceButton(id,handler){const old=$(id);if(!old)return;const fresh=old.cloneNode(true);old.replaceWith(fresh);fresh.addEventListener('click',handler)}
replaceButton('#quickLogBtn',()=>openMealRecord());
replaceButton('#addMealBtn',()=>openMealRecord());
$('#manualMealForm').addEventListener('submit',e=>{
  e.preventDefault();const f=new FormData(e.target),date=String(f.get('date')||localDateKey()),recordedAt=new Date().toISOString(),isBackfill=date<localDateKey(),editingId=e.target.dataset.editingId,existing=editingId?userData.mealLogs.find(x=>x.id===editingId):null,log={id:editingId||(crypto.randomUUID?crypto.randomUUID():String(Date.now())),date,type:f.get('type'),name:f.get('name'),amount:+f.get('grams')||null,unit:f.get('unit')||'g',calories:+f.get('calories'),protein:+f.get('protein')||0,source:isBackfill?'manual_backfill':'manual',recordedAt,createdAt:existing?.createdAt||recordedAt};
  if(existing)Object.assign(existing,log);else userData.mealLogs.push(log);state.mealHistoryDate=date;saveUser();rememberAgent('meal_confirmed',{name:log.name,calories:log.calories,protein:log.protein,mealType:log.type,source:log.source});e.target.reset();delete e.target.dataset.editingId;clearMealNutritionState(e.target);e.target.querySelector('[type="submit"]').textContent='保存并让Agent更新计划';state.activeMealType='';state.activeMealDayOffset=0;closeModals();hydrateApp();addTrace('✓',`${editingId?'修改':isBackfill?'补登':'记录'}${dateDisplay(date)}饮食`,'save_meal_log',`${log.name} · ${log.amount||'?'}${log.unit} · ${log.calories} kcal`);showToast(`${dateDisplay(date)}饮食已${editingId?'修改':'保存'}${isBackfill&&!editingId?'（补登）':''}`);
});

// Persist weight entries made through the existing weight dialog.
$('#saveWeightBtn').addEventListener('click',()=>{
  if(!userData)return;const value=+$('#weightInput').value,date=$('#weightDate').value||localDateKey();if(!value||date>localDateKey())return;
  const recordedAt=new Date().toISOString(),isBackfill=date<localDateKey(),existing=userData.weightLogs.find(x=>x.date===date),entry={date,weight:value,source:isBackfill?'manual_backfill':'manual',recordedAt,createdAt:recordedAt};
  if(existing)Object.assign(existing,entry);else userData.weightLogs.push(entry);userData.weightLogs.sort((a,b)=>a.date.localeCompare(b.date));
  const latest=userData.weightLogs.at(-1);userData.profile.weight=latest.weight;saveUser();rememberAgent('weight_recorded',{weight:value,date});closeModals();hydrateApp();addTrace('↗',`${isBackfill?'补登':'记录'}体重`,'analyze_weight_trend',`${dateDisplay(date)} ${value.toFixed(1)} kg`);showToast(`${dateDisplay(date)}体重已保存${isBackfill?'（补登）':''}`);
});
function saveWeightFromAgent({weight=null,recordDate=''}={}){
  if(!userData)return {error:'请先完成建档'};
  const value=Number(weight);if(!Number.isFinite(value)||value<20||value>300)return {error:'体重数值无效，请提供20–300kg之间的数字'};
  const date=/^\d{4}-\d{2}-\d{2}$/.test(String(recordDate||''))?String(recordDate):localDateKey();if(date>localDateKey())return {error:'不能把体重记录到未来日期'};
  const recordedAt=new Date().toISOString(),isBackfill=date<localDateKey(),existing=userData.weightLogs.find(x=>x.date===date),entry={date,weight:Math.round(value*10)/10,source:isBackfill?'agent_backfill':'agent',recordedAt,createdAt:recordedAt};
  if(existing)Object.assign(existing,entry);else userData.weightLogs.push(entry);
  userData.weightLogs.sort((a,b)=>a.date.localeCompare(b.date));
  const latest=userData.weightLogs.at(-1);userData.profile.weight=latest.weight;saveUser();rememberAgent('weight_recorded',{weight:entry.weight,date});hydrateApp();addTrace('↗',`${isBackfill?'补登':'记录'}体重`,'analyze_weight_trend',`${dateDisplay(date)} ${entry.weight.toFixed(1)} kg`);showToast(`${dateDisplay(date)}体重已保存${isBackfill?'（补登）':''}`);
  return {entry,date,weight:entry.weight,isBackfill};
}

$('#restartBtn').addEventListener('click',()=>{
  if(confirm('这会清除当前浏览器里的档案、体重和饮食记录。确定重新开始吗？')){localStorage.removeItem(STORAGE_KEY);location.reload()}
});
const preferencesForm=$('#preferencesForm');
$('#profileBtn').onclick=()=>{if(!userData)return showToast('尚未建档');const p=userData.profile,taste=p.tastePreference||(/重辣/.test(p.preferences)?'重辣':/中辣|爱吃辣|喜欢辣/.test(p.preferences)?'中辣':/微辣/.test(p.preferences)?'微辣':'不辣');preferencesForm.reset();for(const [name,value] of Object.entries({name:p.name||'',age:p.age||'',sex:p.sex||'female',height:p.height||'',activity:p.activity||'sedentary',mealMode:p.mealMode||'mixed',habit:p.habit||'',tastePreference:taste,preferences:p.preferences||'',dislikedFoods:p.dislikedFoods||'',allergies:p.allergies||''}))preferencesForm.elements[name].value=value;openModal('preferencesModal')};
preferencesForm.addEventListener('submit',e=>{e.preventDefault();if(!userData||!e.target.reportValidity())return;const form=new FormData(e.target),profile=userData.profile,next={name:String(form.get('name')||'').trim(),age:+form.get('age'),sex:String(form.get('sex')||'female'),height:+form.get('height'),activity:String(form.get('activity')||'sedentary'),mealMode:String(form.get('mealMode')||'mixed'),habit:String(form.get('habit')||'').trim(),tastePreference:String(form.get('tastePreference')||'不辣'),preferences:removeTastePreferenceClauses(String(form.get('preferences')||'')),dislikedFoods:String(form.get('dislikedFoods')||'').trim(),allergies:String(form.get('allergies')||'').trim()};for(const key of Object.keys(next))delete profile[key];Object.assign(profile,next,{profileUpdatedAt:new Date().toISOString(),preferencesUpdatedAt:new Date().toISOString()});delete profile.longTermMemory;agentConversation.length=0;userData.chatHistory=[];saveUser();$('#chatMessages').innerHTML='';closeModals();hydrateApp();addTrace('✓','当前个人信息已更新','replace_current_profile',[profile.activity,profile.mealMode,profile.habit,profile.tastePreference,profile.preferences,profile.dislikedFoods,profile.allergies].filter(Boolean).join(' · '));showToast('个人信息已覆盖更新，旧偏好相关对话已清理')});

// Real LLM conversation with controlled UI actions.
const agentConversation=[];
function persistAgentConversation(){if(!userData)return;userData.chatHistory=agentConversation.slice(-100);saveUser()}
function restoreAgentConversation(){agentConversation.length=0;const saved=(Array.isArray(userData?.chatHistory)?userData.chatHistory:[]).slice(-100);agentConversation.push(...saved);if(!saved.length)return;const box=$('#chatMessages');box.innerHTML='';for(const item of saved){const message=addMessage(item.content,item.role==='user',item.role==='assistant'?(item.meta||'历史对话'):(item.meta||new Date(item.createdAt||Date.now()).toLocaleString('zh-CN')));if(item.role==='assistant'&&item.action?.type==='open_meal_choice')addInlineMealChoices(message,item.action);if(item.role==='assistant'&&['open_diy','open_restaurants','open_manual_log'].includes(item.action?.type))addInlineToolEntry(message,item.action);if(item.role==='assistant'&&item.action?.type==='pending_meal_estimate'){const pending=currentPendingMeal();if(pending&&pending.id===item.action.pendingId)addPendingMealControls(message,pending)}if(item.role==='assistant'&&(item.action?.type==='proposal_meal'||item.action?.type==='proposal_weight'||item.action?.type==='proposal_revise'))addProposalControls(message,{kind:item.action.kind,payload:item.action.payload},item)}box.scrollTop=box.scrollHeight}
$('#clearChat').onclick=()=>{agentConversation.length=0;if(userData){userData.chatHistory=[];saveUser()}$('#chatMessages').innerHTML='';showToast('当前对话已清空，长期健康档案仍保留')};
function calculateVisionEstimate(result={}){
  let total=0,protein=0,known=0;const items=(result.foods||[]).map(food=>{const gramsMin=Math.max(1,Number(food.portionGramsMin)||Number(food.portionGrams)||0),gramsMax=Math.max(gramsMin,Number(food.portionGramsMax)||Number(food.portionGrams)||gramsMin),gramsEstimate=Math.round((gramsMin+gramsMax)/2),nutrition=food.nutrition;if(!nutrition)return {...food,gramsEstimate,kcalText:'营养数据未匹配'};const n=nutrition.per100g,kcalPer100=n.kcal||0,kcalEstimate=Math.round(kcalPer100*gramsEstimate/100);total+=kcalEstimate;protein+=(n.protein||0)*gramsEstimate/100;known++;return {...food,gramsEstimate,kcalEstimate,kcalText:`约 ${kcalEstimate} kcal`}});return {items,total,protein,known}
}
function cleanDishName(value=''){return String(value).replace(/[（(]?疑似[）)]?[。.]?/g,'').replace(/\s{2,}/g,' ').trim()}
function visionAnswer(result,estimate){
  const dishName=cleanDishName(result.dishName),title=dishName?`识别结果：${dishName}`:'图片餐食分析结果',lines=estimate.items.map(item=>`${item.name}：约${item.gramsEstimate}g，${item.kcalText}`),total=estimate.known?`估算总热量约 ${estimate.total} kcal（按常见份量估算）`:'暂未匹配到可用营养数据',uncertainties=(result.uncertainties||[]).join('；')||'实际热量可能受用油、酱汁和食用比例影响';return `${title}。${lines.join('；')}。${total}。说明：${uncertainties}。${result.followUpQuestion||'如果你能补充实际重量，结果会更准确。'}`
}
function currentPendingMeal(){const pending=userData?.pendingMealEstimate;if(!pending)return null;const age=Date.now()-new Date(pending.createdAt||0).getTime();if(!Number.isFinite(age)||age>86400000){delete userData.pendingMealEstimate;saveUser();return null}return pending}
function commitPendingMeal({pendingId='',mealType='',recordDate='',portionRatio=1}={},controls=null){
  const pending=currentPendingMeal();if(!pending||pendingId&&pending.id!==pendingId)return {error:'没有找到尚未记录的图片分析结果'};const type=normalizeClientMealType(mealType||pending.suggestedMealType),today=localDateKey(),date=/^\d{4}-\d{2}-\d{2}$/.test(recordDate)?recordDate:pending.recordDate||today,ratio=Math.min(2,Math.max(.05,Number(portionRatio)||1));if(!type)return {error:'请先选择要记录到早餐、午餐、晚餐还是其他摄入'};if(date>today)return {error:'不能把已摄入餐食记录到未来日期'};const calories=Math.round(Number(pending.calories)*ratio),protein=+(Number(pending.protein||0)*ratio).toFixed(1),log={id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),date,type,name:pending.name,calories,protein,source:'图片经验份量估算',recordedAt:new Date().toISOString(),createdAt:new Date().toISOString()};userData.mealLogs.push(log);delete userData.pendingMealEstimate;saveUser();rememberAgent('meal_confirmed',{name:log.name,calories:log.calories,protein:log.protein,mealType:type,source:log.source});state.mealHistoryDate=date;hydrateApp();addTrace('✓',`记录${dateDisplay(date)}${type}`,'save_pending_meal',`${log.name} · ${calories} kcal`);if(controls){controls.querySelectorAll('select,input,button').forEach(element=>element.disabled=true);const button=controls.querySelector('button');if(button)button.textContent=`已记录到${dateDisplay(date)}${type}`;}showToast(`已记录到${dateDisplay(date)}${type} · ${calories} kcal`);return {log,type,date,calories}
}
function addPendingMealControls(message,pending){
  if(!message||!pending)return;const body=message.querySelector(':scope > div'),controls=document.createElement('div');controls.className='pending-meal-controls';controls.innerHTML=`<select aria-label="记录餐次"><option value="">选择餐次</option><option value="早餐">早餐</option><option value="午餐">午餐</option><option value="晚餐">晚餐</option><option value="其他摄入">其他摄入</option></select><input type="date" aria-label="记录日期" max="${localDateKey()}" value="${escapeHtml(pending.recordDate||localDateKey())}"><button type="button"></button>`;const select=controls.querySelector('select'),date=controls.querySelector('input'),button=controls.querySelector('button'),suggested=normalizeClientMealType(pending.suggestedMealType);if(suggested)select.value=suggested;const refresh=()=>{button.disabled=!select.value;button.textContent=select.value?`记录到${dateDisplay(date.value)}${select.value} · 约 ${pending.calories} kcal`:'选择餐次后记录'};select.onchange=refresh;date.onchange=refresh;button.onclick=()=>{const saved=commitPendingMeal({pendingId:pending.id,mealType:select.value,recordDate:date.value},controls);if(saved.error)showToast(saved.error)};refresh();body.appendChild(controls)
}
function addProposalControls(message,proposal={},item=null){
  if(!message||!proposal.kind||!proposal.payload)return;
  const body=message.querySelector(':scope > div'),kind=proposal.kind,p=proposal.payload;
  const controls=document.createElement('div');controls.className='pending-meal-controls proposal-controls';
  const done=()=>{controls.querySelectorAll('select,input,button').forEach(el=>el.disabled=true)};
  if(kind==='meal'){
    const type=normalizeClientMealType(p.mealType)||mealTypeByTime(),date=/^\d{4}-\d{2}-\d{2}$/.test(String(p.recordDate||''))?p.recordDate:localDateKey();
    controls.innerHTML=`<div class="proposal-text">确认把「${escapeHtml(p.name||'未命名餐食')}」按约 ${Math.round(Number(p.calories)||0)} kcal${Number(p.protein)?`、蛋白质约 ${+(Number(p.protein)).toFixed(1)}g`:''} 记到${dateDisplay(date)}${type}？</div><button type="button">确认记录</button>`;
    controls.querySelector('button').onclick=()=>{
      if(!userData)return showToast('请先完成建档');
      const name=String(p.name||'未命名餐食'),calories=Math.max(0,Math.round(Number(p.calories)||0)),protein=Math.max(0,+(Number(p.protein)||0).toFixed(1)),log={id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),date,type,name,calories,protein,source:String(p.source||'Agent确认提案'),recordedAt:new Date().toISOString(),createdAt:new Date().toISOString()};
      userData.mealLogs.push(log);if(userData.pendingMealEstimate&&cleanDishName(userData.pendingMealEstimate.name)===cleanDishName(name))delete userData.pendingMealEstimate;
      saveUser();rememberAgent('meal_confirmed',{name,calories,protein,mealType:type,source:log.source});state.mealHistoryDate=date;hydrateApp();addTrace('✓',`记录${dateDisplay(date)}${type}`,'confirm_meal_record',`${name} · ${calories} kcal`);showToast(`已记录到${dateDisplay(date)}${type} · ${calories} kcal`);done();if(item)item.action={type:'proposal_done'};persistAgentConversation();
    };
  }else if(kind==='weight'){
    const weight=Math.round(Number(p.weight)*10)/10,date=/^\d{4}-\d{2}-\d{2}$/.test(String(p.recordDate||''))?p.recordDate:localDateKey();
    controls.innerHTML=`<div class="proposal-text">确认记录体重 ${Number.isFinite(weight)?weight.toFixed(1):''} kg 到${dateDisplay(date)}？</div><button type="button">确认记录</button>`;
    controls.querySelector('button').onclick=()=>{
      const saved=saveWeightFromAgent({weight,recordDate:date});if(saved.error)return showToast(saved.error);
      done();if(item)item.action={type:'proposal_done'};persistAgentConversation();
    };
  }else if(kind==='revise'){
    if(userData?.pendingMealEstimate){const pending=userData.pendingMealEstimate;pending.name=cleanDishName(p.revisedName||pending.name);pending.calories=Math.max(0,Math.round(Number(p.calories)||pending.calories));pending.protein=Math.max(0,+(Number(p.protein)||pending.protein).toFixed(1));pending.breakdown=[pending.breakdown,p.revisionNote].filter(Boolean).join('；').slice(0,1600);pending.followUpQuestion='';pending.updatedAt=new Date().toISOString();saveUser()}
    controls.innerHTML=`<div class="proposal-text">估算已更新：${escapeHtml(p.revisedName||userData?.pendingMealEstimate?.name||'餐食')} 约 ${Math.round(Number(p.calories)||0)} kcal${Number(p.protein)?`、蛋白质约 ${+(Number(p.protein)).toFixed(1)}g`:''}。可以继续补充信息，或让 Agent 生成确认提案。</div><button type="button">知道了</button>`;
    controls.querySelector('button').onclick=()=>{done();if(item)item.action={type:'proposal_done'};persistAgentConversation()};
  }
  body.appendChild(controls)
}
async function handleChatMealImage(file,note=''){
  if(!userData)return showToast('请先完成建档');if(file.size>8*1024*1024)return showToast('图片不能超过8MB');const userText=note||'已上传1张图片',createdAt=new Date().toISOString();addMessage(userText,true);agentConversation.push({role:'user',content:userText,createdAt});persistAgentConversation();const typing=document.createElement('div');typing.className='message agent-message';typing.innerHTML='<span class="agent-orb tiny"></span><div><p>正在识别菜名、估算常见份量并查询营养数据库…</p></div>';$('#chatMessages').appendChild(typing);$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;addToolEvent('qwen_vision','正在分析用户图片和补充说明');
  try{const imageDataUrl=await fileToDataUrl(file),context=[note?`用户输入：${note}`:'用户未提供餐次或日期说明',userData.profile?.preferences&&`偏好：${userData.profile.preferences}`,userData.profile?.allergies&&`忌口：${userData.profile.allergies}`].filter(Boolean).join('；'),data=await apiFetch('/api/meals/analyze',{method:'POST',body:JSON.stringify({imageDataUrl,context})}),result=data.result,estimate=calculateVisionEstimate(result),answer=visionAnswer(result,estimate);typing.remove();for(const tool of data.trace||[])addToolEvent(tool,tool==='common_portion_fallback'?'已采用常见份量经验值':'图片分析完成');const message=addMessage(answer,false,'图片分析 · 经验估算＋营养数据库'),dishName=cleanDishName(result.dishName),pending=estimate.known?{id:crypto.randomUUID?crypto.randomUUID():String(Date.now()),name:dishName||`图片识别：${estimate.items.map(x=>x.name).join('、')}`,calories:estimate.total,protein:+estimate.protein.toFixed(1),breakdown:estimate.items.map(item=>`${item.name}约${item.gramsEstimate}g${item.kcalEstimate!=null?`、${item.kcalEstimate} kcal`:''}`).join('；'),followUpQuestion:String(result.followUpQuestion||''),suggestedMealType:normalizeClientMealType(result.suggestedMealType),recordDate:/^\d{4}-\d{2}-\d{2}$/.test(String(result.recordDate||''))?result.recordDate:localDateKey(),createdAt:new Date().toISOString()}:null;if(pending){userData.pendingMealEstimate=pending;saveUser();addPendingMealControls(message,pending)}agentConversation.push({role:'assistant',content:answer,action:pending?{type:'pending_meal_estimate',pendingId:pending.id}:null,meta:'图片分析 · 经验估算＋营养数据库',createdAt:new Date().toISOString()});persistAgentConversation()}catch(error){typing.remove();const answer=`图片分析失败：${error.message}`;addMessage(answer,false,'图片分析失败');agentConversation.push({role:'assistant',content:answer,meta:'图片分析失败',createdAt:new Date().toISOString()});persistAgentConversation()}finally{$('#chatMealImage').value='';$('#chatImageAttachment').hidden=true;$('#chatImageThumb').removeAttribute('src')}
}
handleAgentPrompt = async function(prompt){
  if(!userData)return showToast('请先完成建档');const historyForModel=agentConversation.slice(-24).map(({role,content})=>({role,content})),now=new Date().toISOString();addMessage(prompt,true);agentConversation.push({role:'user',content:prompt,createdAt:now});persistAgentConversation();const typing=document.createElement('div');typing.className='message agent-message';typing.innerHTML=`<span class="agent-orb tiny"></span><div><p>正在读取长期记忆、近期对话和真实记录…</p></div>`;$('#chatMessages').appendChild(typing);$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;
  try{
    const d=await apiFetch('/api/agent/chat',{method:'POST',body:JSON.stringify({message:prompt,history:historyForModel,profile:userData.profile,weightLogs:userData.weightLogs||[],todayMeals:todayMeals(),pendingMeal:currentPendingMeal(),clientId:CLIENT_ID})}),r=d.result;for(const tool of r.trace||[])addToolEvent(tool,tool==='qwen_chat'?'模型已生成回答':'已读取真实状态');typing.remove();const answer=r.answer;
    const proposal=r.proposal||null,meta=DEMO_MODE?`预置演示 · ${r.intent||'general'}`:`真实LLM · ${r.intent||'general'}`,responseMessage=addMessage(answer,false,meta);if(proposal)addProposalControls(responseMessage,proposal);agentConversation.push({role:'assistant',content:answer,action:proposal?{type:'proposal_'+proposal.kind,kind:proposal.kind,payload:proposal.payload}:r.action||null,meta,createdAt:new Date().toISOString()});if(agentConversation.length>100)agentConversation.splice(0,agentConversation.length-100);persistAgentConversation();const cuisine=r.action?.cuisine||'';if(cuisine)state.mealRequest=cuisine;if(r.action?.mealType)setActiveMealType(r.action.mealType,r.action.dayOffset);state.restaurantRadius=Math.min(5000,Math.max(100,Number(r.action?.radiusMeters)||3000));state.restaurantArea=String(r.action?.area||'').trim();state.restaurantRequestedCount=Math.min(20,Math.max(1,Number(r.action?.requestedCount)||5));if(r.action?.type==='open_meal_choice')addInlineMealChoices(responseMessage,r.action);else if(['open_diy','open_restaurants','open_manual_log'].includes(r.action?.type))addInlineToolEntry(responseMessage,r.action)
  }catch(e){typing.remove();const errorText=`真实模型调用失败：${e.message}`;addMessage(errorText,false,'服务错误');agentConversation.push({role:'assistant',content:errorText,meta:'服务错误',createdAt:new Date().toISOString()});persistAgentConversation()}
};

userData=loadUser();
if(DEMO_MODE){document.documentElement.dataset.demoMode='true';$('#demoModeBanner').hidden=false;}
if(userData){$('#onboarding').classList.add('hidden');hydrateApp();restoreAgentConversation()}else{initOnboarding()}
loadServerUser();pollAgent();runDailyReview();connectAgentEvents();
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});

const adjustGoalForm=$('#adjustGoalForm');
function dateAfterDays(days){const date=new Date();date.setHours(12,0,0,0);date.setDate(date.getDate()+Math.max(1,+days||1));return localDateKey(date)}
function updateAdjustGoalPreview(){if(!userData)return;const targetWeight=+adjustGoalForm.elements.targetWeight.value,targetDate=adjustGoalForm.elements.targetDate.value;if(!targetWeight||!targetDate)return;const m=calculateProfile({...userData.profile,targetWeight,targetDate}),box=$('#adjustGoalPreview');box.className='final-evaluation';box.innerHTML=`调整后还剩 <strong>${m.days} 天</strong>，理论目标速度约 <strong>${m.weekly.toFixed(2)} kg/周</strong>，目标 BMI 约 <strong>${m.targetBmi.toFixed(2)}</strong>。<br>为了在指定日期达到目标，理论上每天需摄入约 <strong>${m.theoreticalTarget} kcal</strong>（每日所需缺口 ${m.requiredDeficit} kcal）。`}
$('#adjustGoalBtn').addEventListener('click',()=>{if(!userData)return;const m=calculateProfile(userData.profile),tomorrow=dateAfterDays(1);adjustGoalForm.elements.targetWeight.value=userData.profile.targetWeight;adjustGoalForm.elements.planDays.value=m.days;adjustGoalForm.elements.targetDate.min=tomorrow;adjustGoalForm.elements.targetDate.value=userData.profile.targetDate<tomorrow?tomorrow:userData.profile.targetDate;updateAdjustGoalPreview();openModal('adjustGoalModal')});
adjustGoalForm.elements.planDays.addEventListener('input',()=>{adjustGoalForm.elements.targetDate.value=dateAfterDays(adjustGoalForm.elements.planDays.value);updateAdjustGoalPreview()});
adjustGoalForm.elements.targetDate.addEventListener('input',()=>{adjustGoalForm.elements.planDays.value=daysBetween(localDateKey(),adjustGoalForm.elements.targetDate.value);updateAdjustGoalPreview()});
adjustGoalForm.elements.targetWeight.addEventListener('input',updateAdjustGoalPreview);
adjustGoalForm.addEventListener('submit',e=>{e.preventDefault();if(!userData||!e.target.reportValidity())return;const old={targetWeight:userData.profile.targetWeight,targetDate:userData.profile.targetDate},targetWeight=+e.target.elements.targetWeight.value,targetDate=e.target.elements.targetDate.value;userData.goalHistory=userData.goalHistory||[];userData.goalHistory.push({...old,changedAt:new Date().toISOString()});userData.profile.targetWeight=targetWeight;userData.profile.targetDate=targetDate;saveUser();closeModals();hydrateApp();const days=daysBetween(localDateKey(),targetDate);addTrace('↻','目标计划已调整','replan_weight_goal',`目标 ${targetWeight.toFixed(1)} kg · 新周期 ${days} 天`);showToast(`目标已更新，Agent已按${days}天重新规划`)});

// --- Real backend integrations ---
let serviceStatus={qwen:false,usda:false,amap:false,openFoodFacts:true};
const portionForm=$('#manualMealForm'),portionInput=portionForm.elements.grams,portionLabel=portionInput.closest('label'),portionControl=document.createElement('div'),portionUnit=document.createElement('select');
portionUnit.name='unit';portionUnit.setAttribute('aria-label','份量单位');portionUnit.innerHTML='<option value="g">g</option><option value="ml">ml</option>';portionControl.className='portion-control';portionControl.style.cssText='display:grid;grid-template-columns:minmax(0,1fr) 82px;gap:8px;align-items:end';portionInput.replaceWith(portionControl);portionControl.append(portionInput,portionUnit);portionLabel.firstChild.textContent='大约份量';
$('#manualMealForm').elements.protein.step='0.1';
function demoPayload(options={}){try{return options.body?JSON.parse(options.body):{}}catch{return {}}}
function demoFood(name='鸡胸肉'){
  const key=String(name).trim(),catalog={
    '鸡胸肉':{kcal:133,protein:24.6,fat:2.8,carbs:0},'鸡蛋':{kcal:144,protein:13.3,fat:8.8,carbs:2.8},'番茄':{kcal:18,protein:.9,fat:.2,carbs:3.9},'米饭':{kcal:116,protein:2.6,fat:.3,carbs:25.9},'西兰花':{kcal:36,protein:4.1,fat:.6,carbs:4.3},'燕麦':{kcal:367,protein:15,fat:6.7,carbs:61.6},'三文鱼':{kcal:208,protein:20.4,fat:13.4,carbs:0},'豆腐':{kcal:81,protein:8.1,fat:4.2,carbs:2.0}
  },hit=catalog[key]||catalog['鸡胸肉'];
  return {name:key||'鸡胸肉',category:'演示食材',per100g:hit,source:{type:'预置演示营养数据',url:null},confidence:'medium'};
}
function demoTargets({profile={},today={},mealType='' }={}){
  const type=normalizeClientMealType(mealType)||mealTypeByTime(),dailyTarget=Math.max(1200,Math.round(Number(state.theoreticalTarget)||Number(state.energyTarget)||1500)),consumed=Math.max(0,Math.round(Number(today.calories)||0)),remaining=Math.max(0,dailyTarget-consumed),index=['早餐','午餐','晚餐'].indexOf(type),futureMeals=['早餐','午餐','晚餐'].slice(Math.max(0,index+1));
  return {mealType:type,dailyTarget,consumedKcal:consumed,remainingKcal:remaining,reservedKcal:Math.round(remaining*.45),mealKcal:Math.max(280,Math.round(remaining/(futureMeals.length+1))),futureMeals,budgetStatus:remaining<250?'low':'normal'};
}
function demoRecipe(payload={}){
  const names=(Array.isArray(payload.ingredients)?payload.ingredients:[]).map(x=>String(x).trim()).filter(Boolean).slice(0,4),selected=(names.length?names:['鸡胸肉','番茄','鸡蛋','米饭']).map((name,index)=>{const food=demoFood(name),grams=[120,140,55,100][index]||80;return {name:food.name,grams,kcal:Math.round(food.per100g.kcal*grams/100),protein:+(food.per100g.protein*grams/100).toFixed(1),fat:+(food.per100g.fat*grams/100).toFixed(1),carbs:+(food.per100g.carbs*grams/100).toFixed(1)}});
  const nutrition=selected.reduce((sum,item)=>({kcal:sum.kcal+item.kcal,protein:sum.protein+item.protein,fat:sum.fat+item.fat,carbs:sum.carbs+item.carbs}),{kcal:0,protein:0,fat:0,carbs:0});
  nutrition.protein=+nutrition.protein.toFixed(1);nutrition.fat=+nutrition.fat.toFixed(1);nutrition.carbs=+nutrition.carbs.toFixed(1);
  return {recipe:{name:`${selected[0].name}彩蔬能量碗`,minutes:20,ingredients:selected,steps:['将主食材切成适口大小，少油煎熟或焯熟。','加入蔬菜与主食材翻拌，按个人口味调味。','装盘后按实际食用量确认记录。']},nutrition,matched:selected.map(x=>x.name),targets:demoTargets({profile:payload.profile,today:payload.today,mealType:payload.mealType}),generatedBy:'demo'};
}
function demoDailyPlan(payload={}){
  const targets=demoTargets({profile:payload.profile,today:payload.today,mealType:'午餐'}),planned=[
    {type:'早餐',mealKcal:360,name:'燕麦鸡蛋酸奶碗',description:'优先补足蛋白质并控制精制糖。',diy:{name:'燕麦鸡蛋酸奶碗',ingredients:['燕麦 40g','鸡蛋 1 个','无糖酸奶 150g'],steps:['燕麦加热','搭配鸡蛋与酸奶']},status:'planned'},
    {type:'午餐',mealKcal:480,name:'鸡胸肉彩蔬饭',description:'以高蛋白主菜搭配蔬菜与适量主食。',diy:{name:'鸡胸肉彩蔬饭',ingredients:['鸡胸肉 120g','番茄 140g','米饭 100g'],steps:['煎熟鸡胸肉','翻炒番茄','与米饭搭配']},status:'planned'},
    {type:'晚餐',mealKcal:420,name:'豆腐西兰花拌饭',description:'晚餐保留蛋白质，减少额外油脂。',diy:{name:'豆腐西兰花拌饭',ingredients:['豆腐 150g','西兰花 150g','米饭 80g'],steps:['焯熟西兰花','煎豆腐','拌入米饭']},status:'planned'}
  ];
  return {dailyTarget:targets.dailyTarget,consumedKcal:targets.consumedKcal,remainingKcal:targets.remainingKcal,otherConsumedKcal:0,generatedBy:'demo',meals:planned};
}
function demoRestaurants(payload={}){
  const target=demoTargets({profile:payload.profile,today:payload.today,mealType:payload.mealType}),restaurants=[['轻食实验室','演示路 88 号',420,'香煎鸡胸肉藜麦沙拉',428,36],['谷物食堂','演示路 126 号',680,'番茄牛肉饭（少饭）',465,31],['暖碗餐吧','演示路 208 号',930,'豆腐菌菇荞麦面',392,24]];
  return {targets:target,results:restaurants.slice(0,Math.max(1,Math.min(Number(payload.requestedCount)||3,3))).map((item,index)=>({name:item[0],address:item[1],distance:item[2],location:'121.4737,31.2304',recommendation:{mode:'demo',label:'预置演示数据',mealStructure:item[3],dishes:[item[3]],reason:'按本餐预留热量、蛋白质优先和演示偏好排序。',personalization:{mealDisplay:item[3],kcal:item[4],protein:item[5],confidence:'medium',hours:{label:'演示营业时间 10:00–21:00'},score:96-index*3},sources:[]}}))};
}
function demoAgentReply(payload={}){
  const message=String(payload.message||''),mealType=mealTypeByTime(),outside=/外卖|餐馆|餐厅|附近|堂食/.test(message),diy=/做饭|食材|冰箱|家里|DIY/.test(message),action=outside?{type:'open_restaurants',mealType,radiusMeters:3000,requestedCount:3}:diy?{type:'open_diy',mealType}:{type:'open_meal_choice',mealType};
  const answer=outside?'这是预置演示响应：已根据今日可用热量和高蛋白优先级准备附近外食方案。你可以打开“附近外食”查看排序结果。':diy?'这是预置演示响应：已读取你当前的食材与本餐预算，可以打开“在家 DIY”查看可确认的食谱方案。':'这是预置演示响应：我会先读取档案、今日饮食和预算，再让你选择在家 DIY 或附近外食；页面中的 Tool 轨迹可查看该流程。';
  return {answer,intent:'meal_recommendation',action,trace:['read_user_state','get_meal_budget',outside?'rank_restaurants':'compose_home_recipe']};
}
async function demoApi(url,options={}){
  await new Promise(resolve=>setTimeout(resolve,120));
  const path=String(url).split('?')[0],payload=demoPayload(options),now=new Date().toISOString();
  if(path==='/api/health')return {ok:true,demo:true,services:{qwen:false,usda:false,amap:false,openFoodFacts:false}};
  if(path==='/api/user/state')return {ok:true,state:null};
  if(path==='/api/agent/memory')return {ok:true,demo:true};
  if(path==='/api/agent/check')return {ok:true,tasks:[]};
  if(path==='/api/agent/review')return {ok:true,result:{adjustment:0,decidedBy:'demo',message:'面试演示模式不修改预算'}};
  if(path==='/api/agent/logs')return {ok:true,logs:[{kind:'agent_skill',detail:'meal-recommendation:demo-hit',createdAt:now},{kind:'agent_tool',detail:'read_user_state:ok',createdAt:now},{kind:'agent_tool',detail:'get_meal_budget:ok',createdAt:now},{kind:'agent_tool',detail:'compose_home_recipe:ok',createdAt:now},{kind:'agent_chat_done',detail:'预置演示流程完成',createdAt:now}]};
  if(path==='/api/recipes/diy')return {ok:true,result:demoRecipe(payload)};
  if(path==='/api/plans/daily-meals')return {ok:true,result:demoDailyPlan(payload)};
  if(path==='/api/agent/chat')return {ok:true,result:demoAgentReply(payload)};
  if(path==='/api/meals/analyze')return {ok:true,trace:['demo_vision_response','demo_nutrition_match'],result:{dishName:'鸡胸肉藜麦沙拉（预置演示）',foods:[{name:'鸡胸肉',portionGrams:120,nutrition:demoFood('鸡胸肉')},{name:'番茄',portionGrams:100,nutrition:demoFood('番茄')},{name:'米饭',portionGrams:80,nutrition:demoFood('米饭')}],uncertainties:['图片未实际上传到服务端，结果为预置示例'],followUpQuestion:'演示模式下可继续确认记录，真实图片识别需连接服务端。',suggestedMealType:mealTypeByTime(),recordDate:localDateKey()}};
  if(path==='/api/nutrition/search'){const name=new URL(String(url),location.origin).searchParams.get('q')||'鸡胸肉',food=demoFood(name);return {ok:true,result:food,trace:['demo_local_nutrition']};}
  if(path.startsWith('/api/nutrition/barcode/'))return {ok:true,result:{name:'预置演示轻食餐',brand:'小饭 Demo',per100g:{kcal:128,protein:11.5,fat:4.2,carbs:12.8},basis:'100g',nutritionSource:'demo_data',matchedReference:'预置演示营养数据',servingSize:'220g'}};
  if(path==='/api/nutrition/web-search')return {ok:true,result:{name:payload.query||'预置演示餐食',kcal:320,protein:24,basis:'serving',confidence:'medium',sourceTitle:'预置演示数据（未发起网页检索）',sourceUrl:'',notes:['GitHub Pages 演示模式不访问外部网页或密钥服务']}};
  if(path==='/api/location/geocode')return {ok:true,result:{lat:31.2304,lng:121.4737,formattedAddress:`${new URL(String(url),location.origin).searchParams.get('address')||'演示地点'}（预置坐标）`}};
  if(path==='/api/restaurants/nearby')return {ok:true,results:[{name:'轻食实验室',address:'演示路 88 号',distance:420,location:'121.4737,31.2304'},{name:'谷物食堂',address:'演示路 126 号',distance:680,location:'121.4737,31.2304'},{name:'暖碗餐吧',address:'演示路 208 号',distance:930,location:'121.4737,31.2304'}]};
  if(path==='/api/restaurants/recommendations')return {ok:true,...demoRestaurants(payload)};
  return {ok:true,demo:true};
}
async function apiFetch(url,options={}){
  if(DEMO_MODE)return demoApi(url,options);
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const data=await response.json().catch(()=>({error:'服务返回了无效数据'}));if(!response.ok)throw Object.assign(new Error(data.error||`请求失败 ${response.status}`),{status:response.status,data});return data;
}
async function checkServices(){try{const d=await apiFetch('/api/health');serviceStatus=d.services;return d}catch{return null}}
checkServices();

$('#lookupNutritionBtn').addEventListener('click',async()=>{
  const form=$('#manualMealForm'),name=form.elements.name.value.trim(),grams=+form.elements.grams.value||100,status=$('#nutritionLookupStatus');if(!name){status.className='lookup-status error';status.textContent='请先填写食物名称';return}
  if(form.dataset.nutritionBasis){recalculateBarcodeNutrition();const hasEnergy=form.dataset.kcalPer100!=='',fallback=form.dataset.nutritionSource==='local_reference_fallback',local=form.dataset.nutritionSource==='local_database';status.className=hasEnergy?(fallback?'lookup-status warning':'lookup-status success'):'lookup-status warning';status.innerHTML=hasEnergy?`✓ 已按当前份量重新计算「${escapeHtml(name)}」的热量和蛋白质<span class="api-source">${fallback?`包装营养缺失，使用本地「${escapeHtml(form.dataset.matchedReference||'通用食品')}」参考值估算`:local?`来源：本地营养库 · 当前单位 ${escapeHtml(form.elements.unit.value)}`:`来源：Open Food Facts · ${form.dataset.nutritionBasis==='100ml'?'液体按毫升计算':'按克计算'}`}</span>`:`「${escapeHtml(name)}」的条码记录缺少营养信息，请对照包装标签手动填写。`;return}
  if(form.elements.barcode.value.trim()){$('#lookupBarcodeBtn').click();return}
  delete form.dataset.kcalPer100;delete form.dataset.proteinPer100;delete form.dataset.nutritionBasis;
  status.className='lookup-status loading';status.textContent='Agent工具：正在查询本地营养数据库…';addToolEvent('search_local_nutrition',name);
  try{
    const d=await apiFetch(`/api/nutrition/search?q=${encodeURIComponent(name)}`),n=d.result.per100g,ratio=grams/100;
    const kcalPer100=n.kcal||0;form.dataset.kcalPer100=kcalPer100;form.dataset.proteinPer100=n.protein||0;form.dataset.nutritionBasis='100g';form.dataset.nutritionSource='local_database';form.dataset.matchedReference=d.result.name;form.elements.calories.value=Math.round(kcalPer100*ratio);form.elements.protein.value=((n.protein||0)*ratio).toFixed(1);
    status.className='lookup-status success';status.innerHTML=`✓ 匹配到「${escapeHtml(d.result.name)}」：${n.kcal} kcal/100g <span class="api-source">来源：${escapeHtml(d.result.source.type)} · 路径：${d.trace.join(' → ')}</span>`;addToolEvent(d.trace.includes('usda_api')?'search_usda':'lookup_local_food',`${d.result.name} · ${nutritionLevelShort(d.result.confidence)}`);
  }catch(e){
    if(e.data?.canUseWeb){await runWebFoodSearch(name,grams,form,status)}else{status.className='lookup-status warning';status.innerHTML=`未在当前数据源中找到「${escapeHtml(name)}」。请手动填写营养信息，或配置USDA服务。`}
  }
});
$('#lookupBarcodeBtn').addEventListener('click',async()=>{
  const form=$('#manualMealForm'),code=form.elements.barcode.value.trim(),grams=+form.elements.grams.value||100,status=$('#nutritionLookupStatus');if(!code){status.className='lookup-status error';status.textContent='请填写包装上的商品条码';return}
  status.className='lookup-status loading';status.textContent='正在查询 Open Food Facts…';addToolEvent('lookup_product_barcode',code);
  try{const d=await apiFetch(`/api/nutrition/barcode/${encodeURIComponent(code)}`),r=d.result,n=r.per100g,fallback=r.nutritionSource==='local_reference_fallback',liquid=r.basis==='100ml'||/奶|饮料|果汁|咖啡|茶|水|酒/.test(r.name);form.elements.name.value=r.name;form.dataset.kcalPer100=n.kcal??'';form.dataset.proteinPer100=n.protein??'';form.dataset.nutritionBasis=r.basis||'100g';form.dataset.nutritionSource=r.nutritionSource||'open_food_facts';form.dataset.matchedReference=r.matchedReference||'';form.elements.unit.value=liquid?'ml':'g';recalculateBarcodeNutrition();status.className=n.kcal==null||fallback?'lookup-status warning':'lookup-status success';status.innerHTML=`✓ ${escapeHtml(r.brand?`${r.brand} · ${r.name}`:r.name)}${n.kcal==null?' · 营养数据不完整':''}<span class="api-source">${fallback?`Open Food Facts缺少营养值，已用本地「${escapeHtml(r.matchedReference)}」参考值估算`:`来源：Open Food Facts · 按${r.basis==='100ml'?'100ml':'100g'}计算${r.servingSize?` · 包装份量 ${escapeHtml(r.servingSize)}`:''} · 请与包装标签核对`}</span>`}catch(e){status.className='lookup-status error';status.textContent=`条码查询失败：${e.message}`}
});
function recalculateBarcodeNutrition(){const form=$('#manualMealForm'),amount=+form.elements.grams.value||0,kcal=Number(form.dataset.kcalPer100),protein=Number(form.dataset.proteinPer100);form.elements.calories.value=form.dataset.kcalPer100===''?'':Math.round(kcal*amount/100);form.elements.protein.value=form.dataset.proteinPer100===''?0:(protein*amount/100).toFixed(1)}
$('#manualMealForm').elements.grams.addEventListener('input',()=>{if($('#manualMealForm').dataset.nutritionBasis)recalculateBarcodeNutrition()});
$('#manualMealForm').elements.unit.addEventListener('change',()=>{if($('#manualMealForm').dataset.nutritionBasis)recalculateBarcodeNutrition()});
$('#manualMealForm').elements.name.addEventListener('input',e=>{if(e.isTrusted){const form=$('#manualMealForm');delete form.dataset.kcalPer100;delete form.dataset.proteinPer100;delete form.dataset.nutritionBasis;delete form.dataset.nutritionSource;delete form.dataset.matchedReference;form.elements.barcode.value=''}});
async function runWebFoodSearch(name,grams,form,status){
  status.className='lookup-status loading';status.textContent='Agent工具：仅检索政府数据库和品牌官方网站…';addToolEvent('search_official_web',name);
  try{const d=await apiFetch('/api/nutrition/web-search',{method:'POST',body:JSON.stringify({query:name})}),r=d.result,ratio=r.basis==='per100g'?grams/100:1;form.dataset.kcalPer100=r.kcal??'';form.dataset.proteinPer100=r.protein??0;form.dataset.nutritionBasis=r.basis==='per100g'?'100g':'serving';form.dataset.nutritionSource='official_web_candidate';form.dataset.matchedReference=r.name||name;if(r.kcal!=null)form.elements.calories.value=Math.round(r.kcal*ratio);if(r.protein!=null)form.elements.protein.value=(r.protein*ratio).toFixed(1);status.className=r.confidence==='low'?'lookup-status warning':'lookup-status success';const candidateUrl=/^https?:\/\//.test(String(r.sourceUrl||''))?String(r.sourceUrl):'',candidateSource=candidateUrl?`<a href="${escapeHtml(candidateUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.sourceTitle||'查看来源')}</a>`:escapeHtml(r.sourceTitle||'未验证来源'),rawNotes=(Array.isArray(r.notes)?r.notes:[]).filter(Boolean).join('；').trim(),candidateNotes=rawNotes.slice(0,500),noteSuffix=rawNotes.length>500?'…':'';status.innerHTML=`网页候选：${escapeHtml(r.name||name)} · ${r.kcal??'未知'} kcal/${r.basis==='per100g'?'100g':'份'}<span class="api-source">${candidateSource} · 已进入候选库，使用前请确认</span>${r.kcal==null?'<span class="api-source">未找到可靠官方数据：请手动填写热量与蛋白质，或换更具体的菜品名（如“赛百味金枪鱼三明治 6英寸”）再查询。</span>':''}${candidateNotes?`<span class="api-source">候选说明：${escapeHtml(candidateNotes)}${noteSuffix}</span>`:''}`}catch(e){status.className='lookup-status error';status.textContent=`网页检索失败：${e.message}`}
}

function fileToDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)})}


function requestGeolocation(){
  if(DEMO_MODE)return Promise.resolve({latitude:31.2304,longitude:121.4737,source:'demo'});
  return new Promise((resolve,reject)=>{
    if(!navigator.geolocation){reject(new Error('当前浏览器不支持定位，可直接输入所在城市/商圈搜索'));return}
    navigator.geolocation.getCurrentPosition(pos=>resolve({latitude:pos.coords.latitude,longitude:pos.coords.longitude}),err=>{
      const code=Number(err&&err.code);
      const reason=code===1?'定位权限被拒绝：请在浏览器网站设置中允许位置，并确认系统“隐私与安全性→定位服务”已勾选当前浏览器（改后需完全退出浏览器重开）':code===2?'无法获取当前位置：请检查系统定位服务和网络连接':'定位超时（15秒），可重试或直接输入所在商圈搜索';
      reject(new Error(reason+(code?('（错误码 '+code+'）'):'')));
    },{enableHighAccuracy:false,timeout:15000,maximumAge:120000});
  });
}

// 真实部署使用浏览器定位与高德 POI；GitHub Pages 演示模式使用明确标注的预置餐馆结果。
startRestaurantSearch = async function(cuisine='',mealType=suggestedMealType(),dayOffset=state.activeMealDayOffset,radius=state.restaurantRadius||3000,area='',requestedCount=state.restaurantRequestedCount||5){
  setActiveMealType(mealType,dayOffset);
  openModal('outsideModal');const fb0=$('#locationFallback');if(fb0)fb0.hidden=true;$('#restaurantResults').innerHTML='';$('#restaurantLoading').style.display='flex';$('#loadingText').textContent='等待位置授权…';addToolEvent('browser_geolocation','请求本次位置');
  try{radius=Math.min(5000,Math.max(100,Number(radius)||3000));let latitude,longitude;if(area){$('#loadingText').textContent=`正在解析“${area}”…`;const geo=await apiFetch(`/api/location/geocode?address=${encodeURIComponent(area)}`);latitude=geo.result.lat;longitude=geo.result.lng;addToolEvent('amap_geocode',geo.result.formattedAddress)}else{const pos=await requestGeolocation();latitude=pos.latitude;longitude=pos.longitude}$('#loadingText').textContent=`调用高德搜索${radius>=1000?`${+(radius/1000).toFixed(1)}公里`:`${radius}米`}内${cuisine||'餐馆'}…`;const d=await apiFetch(`/api/restaurants/nearby?lat=${latitude}&lng=${longitude}&radius=${radius}${cuisine?`&cuisine=${encodeURIComponent(cuisine)}`:''}`);addToolEvent('amap_place_around',`${radius}米内找到${d.results.length}家${cuisine||'餐馆'}`);
    if(!d.results.length){$('#restaurantLoading').style.display='none';$('#restaurantResults').innerHTML=`<div class="lookup-status warning">${radius}米内未找到符合条件的餐馆。你可以让Agent扩大搜索范围。</div>`;return}
    $('#loadingText').textContent='检索并核验公开菜单…';addToolEvent('search_public_menus','最多核验5家附近门店');
    const recommendationData=await apiFetch('/api/restaurants/recommendations',{method:'POST',body:JSON.stringify({restaurants:d.results,requestedCount,cuisine,mealType,dayOffset,profile:userData?.profile||{},today:{calories:state.calories,protein:state.protein,meals:todayMeals()}})}),results=recommendationData.results,targets=recommendationData.targets,amapDishCount=results.filter(x=>x.recommendation.mode==='amap_tag').length,webMenuCount=results.filter(x=>x.recommendation.mode==='verified_menu').length;addToolEvent('verify_menu_sources',`${amapDishCount}家有高德特色菜 · ${webMenuCount}家找到可靠公开菜单`);addToolEvent('rank_by_meal_gap',`${mealDayLabel()}${mealType}请求${requestedCount}家 · 实际符合${results.length}家`);$('#restaurantLoading').style.display='none';
    if(!results.length){$('#restaurantResults').innerHTML=`<div class="lookup-status warning">你要求推荐 ${requestedCount} 家，但当前范围内实际找到 0 家符合条件且在${mealDayLabel()}${escapeHtml(mealType)}时段营业的门店。请减少筛选条件、调整餐次或扩大搜索范围。<span class="api-source">营业时间来源：高德POI business；节假日和临时调整请以门店为准。</span></div>`;return}
    const dayLabel=dayOffset===1?'明天':'今天',countNotice=results.length<requestedCount?`<div class="lookup-status warning">你要求推荐 ${requestedCount} 家，当前实际找到 ${results.length} 家符合距离、营业时间和筛选条件的门店。<span class="api-source">未使用不营业或不符合条件的门店凑数；可以扩大范围或减少筛选条件。</span></div>`:'',budgetNotice=targets?.budgetStatus==='exhausted'?`${dayLabel}理论热量余额已经用完。以下仍可选择，但食用后会超过${dayLabel}理论目标；在没有其他要求时已优先低卡候选。`:targets?.budgetStatus==='low'?`${dayLabel}${targets.mealType}可用热量较少，已优先推荐低卡候选。`:`${dayLabel}${targets?.mealType||'本餐'}动态预算约 ${targets?.mealKcal||0} kcal。`,targetBanner=targets?`<div class="lookup-status ${targets.budgetStatus==='normal'?'success':'warning'}">${cuisine?`本餐偏好：${escapeHtml(cuisine)} · `:''}${escapeHtml(budgetNotice)}<span class="api-source">推荐阶段优先解决去哪吃、点什么；用餐后再通过拍照或手动输入确认实际摄入。${dayLabel}剩余 ${targets.remainingKcal} kcal，为${targets.futureMeals.join('、')||'后续'}预留 ${targets.reservedKcal} kcal</span></div>`:'';$('#restaurantResults').innerHTML=countNotice+targetBanner+results.map((r,i)=>{const rec=r.recommendation,p=rec.personalization||{},sources=(rec.sources||[]).map(s=>`<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a>`).join(' · '),sourceDetail=rec.mode==='amap_tag'?'菜名来源：高德POI business.tag':sources?`菜单来源：${sources}`:'实际供应以门店为准',isCombination=rec.mode==='type_fallback',dishText=p.mealDisplay||rec.mealStructure||((isCombination?(rec.dishes||[]).join(' ＋ '):`任选1项：${(rec.dishes||[]).join(' / ')}`)),kcal=p.kcal!=null?p.kcal:null,protein=p.protein!=null?p.protein:null,nutrition=kcal!=null?`<div class="dish">推荐阶段估算 ${kcal} kcal · 蛋白质 ${protein}g</div>`:'<div class="dish">可以推荐 · 实际能量待用餐后拍照或手动记录</div>',confidenceText=kcal!=null?nutritionLevelNote(p.confidence||'low'):'暂不提供未经核验的热量',hoursText=escapeHtml(p.hours?.label||'营业时间待确认');return `<div class="restaurant-card"><span class="restaurant-rank">${String(i+1).padStart(2,'0')}</span><div><h3>${escapeHtml(r.name)}</h3><p>${Number.isFinite(r.distance)?`${r.distance}m · `:''}${escapeHtml(r.address||'地址未提供')}</p><div class="dish">${escapeHtml(dishText)}</div>${nutrition}<p class="why">✦ ${escapeHtml(p.reason||rec.reason)}</p><span class="confidence">${hoursText} · 个性化匹配 ${p.score||0} · ${confidenceText} · ${escapeHtml(rec.label)} · ${sourceDetail}</span><div class="restaurant-record-actions"><button data-photo-after="${i}">用餐后拍照记录</button><button data-manual-after="${i}">手动记录</button></div></div><button data-map-restaurant="${i}">查看位置</button></div>`}).join('');
    $$('[data-map-restaurant]').forEach((b,i)=>b.onclick=()=>{const r=results[i],url=r.location?`https://uri.amap.com/marker?position=${encodeURIComponent(r.location)}&name=${encodeURIComponent(r.name)}&src=XiaoFan&coordinate=gaode&callnative=0`:`https://www.amap.com/search?query=${encodeURIComponent(`${r.name} ${r.address||''}`)}`;window.open(url,'_blank','noopener,noreferrer')});
    $$('[data-photo-after]').forEach(b=>b.onclick=()=>{switchView('agent');showToast('请在Agent对话框上传图片分析这顿餐食');$('#uploadInChat')?.focus()});
    $$('[data-manual-after]').forEach(b=>b.onclick=()=>openMealRecord(localDateKey(),mealType));
  }catch(e){$('#restaurantLoading').style.display='none';const fb=$('#locationFallback');if(fb)fb.hidden=false;$('#restaurantResults').innerHTML=`<div class="lookup-status error">附近餐馆查询失败：${escapeHtml(e.message)}<span class="api-source">可点击上方“用这个位置搜索”输入所在城市/商圈，由高德转成坐标后继续。</span></div>`}
};

$('#restaurantAreaBtn')?.addEventListener('click',()=>{const area=String($('#restaurantAreaInput')?.value||'').trim();if(!area){showToast('请输入所在城市或商圈');return}startRestaurantSearch(state.mealRequest,suggestedMealType(),state.activeMealDayOffset,state.restaurantRadius,area,state.restaurantRequestedCount)});
