// Public food browsing never creates a device or reads personal data.
window.XiaofanCatalog=(()=>{
  const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=value=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2,useGrouping:false}).format(value);
  let category='common',query='',page=1,listRequest=0,detailRequest=0,selected=null,pendingMeal=null,categories=null,detailFood=null,initialized=false;
  const foods=new Map();
  async function request(path){const response=await fetch(path,{credentials:'omit'}),data=await response.json();if(!response.ok)throw new Error(data.error||'暂时无法读取，请重试。');return data}
  function errorText(error){return error?.message||'暂时无法读取，请重试。'}
  function renderCategories(){
    if(!categories)return;
    el('foodCategories').innerHTML=categories.categories.map(item=>`<button type="button" data-food-category="${esc(item.id)}" aria-pressed="${item.id===category}"><span>${esc(item.name)}</span><small>${item.count}</small></button>`).join('');
    el('catalogTotal').textContent=`${fmt(categories.total)} 种食品`;
    el('catalogAttribution').textContent=categories.source.attribution;
  }
  async function loadCategories(){
    if(categories)return;categories=await request('/api/food-catalog/categories');renderCategories();
  }
  async function load(){
    const token=++listRequest;foods.clear();selected=null;
    el('foodResultStatus').textContent='正在读取食品…';el('foodResults').setAttribute('aria-busy','true');
    el('foodResults').innerHTML='<div class="food-empty">正在读取食品热量…</div>';el('foodPrevious').disabled=true;el('foodNext').disabled=true;
    renderCategories();
    try{
      const data=await request('/api/food-catalog?'+new URLSearchParams({q:query,category,page:String(page)}));if(token!==listRequest)return;
      initialized=true;page=data.page;data.foods.forEach(food=>foods.set(food.id,food));
      el('foodResultStatus').textContent=query?`“${query}” · 找到 ${data.total} 项食品`:`${categories?.categories.find(item=>item.id===category)?.name||'食品'} · 共 ${data.total} 项`;
      el('foodResults').innerHTML=data.foods.length?data.foods.map(food=>`<article class="food-row"><button class="food-row-main" type="button" data-food-detail="${esc(food.id)}" aria-label="查看${esc(food.displayName)}的营养详情"><span class="food-icon" aria-hidden="true">${esc(food.icon)}</span><span class="food-row-copy"><strong>${esc(food.displayName)}</strong><span class="food-calories"><b>${fmt(food.per100g.kcal)}</b> 千卡<span>/100克</span></span><small>${esc(food.name!==food.displayName?`样品：${food.name} · `:'')}${esc(food.matchNote||food.description||food.categoryLabel)}</small></span></button><button type="button" class="food-add" data-food-record="${esc(food.id)}" aria-label="记录${esc(food.displayName)}">＋</button></article>`).join(''):'<div class="food-empty"><span aria-hidden="true">⌕</span><h3>没有找到对应食品</h3><p>试试更具体的食品名、常见别名或 TFDA 编号。<br>当前数据库未收录的菜品不会用某个食材代替。</p><button type="button" data-food-reset>查看全部食品</button></div>';
      el('foodPageStatus').textContent=`第 ${page} / ${data.pages} 页`;el('foodPrevious').disabled=page<=1;el('foodNext').disabled=page>=data.pages;
    }catch(error){if(token===listRequest){el('foodResultStatus').textContent='读取失败';el('foodResults').innerHTML=`<div class="food-empty"><p>${esc(errorText(error))}</p><button type="button" data-food-retry>重新加载</button></div>`;el('foodPageStatus').textContent=''}}
    finally{if(token===listRequest)el('foodResults').setAttribute('aria-busy','false')}
  }
  async function open(initialQuery=null,initialCategory=null){
    window.XiaofanNavigatePublic?.('catalog');
    if(initialQuery!==null){query=String(initialQuery).trim().slice(0,100);category=query?'all':initialCategory||'common';page=1;el('foodSearchInput').value=query}
    else if(initialCategory!==null){category=initialCategory;page=1}
    try{await loadCategories()}catch{el('catalogTotal').textContent='食药署食品数据';el('foodCategories').innerHTML='<button type="button" data-food-category="all">全部食品</button>'}
    if(!initialized||initialQuery!==null||initialCategory!==null)await load();
  }
  function nutrientValue(value,unit='',grams=100){return value==null?'未知':`${fmt(Number(value)*grams/100)}${unit?` ${unit}`:''}`}
  function renderPortion(){
    if(!detailFood)return;const grams=Number(el('foodGrams').value),valid=Number.isFinite(grams)&&grams>0&&grams<=3000;
    el('foodDetailRecord').disabled=!valid;el('foodPortionError').textContent=valid?'':'请输入大于0且不超过3000的克数。';
    const n=detailFood.per100g;
    el('foodPortionNutrition').innerHTML=[['热量',n.kcal,'千卡'],['蛋白质',n.protein,'克'],['脂肪',n.fat,'克'],['碳水',n.carbs,'克']].map(([label,value,unit])=>`<div><small>${label}</small><strong>${valid?nutrientValue(value,unit,grams):'—'}</strong></div>`).join('');
    el('foodDetailRecord').textContent=valid?`记录这份 · ${fmt(grams)}克`:'记录这份';
  }
  async function detail(id){
    const token=++detailRequest;selected=id;detailFood=null;el('foodDetailRecord').disabled=true;el('foodDetailRecord').textContent='读取中…';
    el('foodDetailTitle').textContent=foods.get(id)?.displayName||'食品详情';el('foodDetailContent').innerHTML='<p class="food-detail-loading">正在读取营养详情…</p>';
    if(!el('foodDetail').open)el('foodDetail').showModal();
    try{
      const {result}=await request('/api/food-catalog/details?'+new URLSearchParams({id}));if(token!==detailRequest)return;
      detailFood=result.food;const food=detailFood;el('foodDetailTitle').textContent=food.displayName;
      el('foodDetailContent').innerHTML=`<p class="food-detail-sample">${esc(food.categoryLabel)} · 食药署样品：${esc(food.name)}</p>${food.matchNote?`<p class="food-sample-note">${esc(food.matchNote)}</p>`:''}<p class="food-detail-description">${esc(food.description||'无样品说明')}</p><label class="food-grams-label" for="foodGrams">食用份量 <span><input id="foodGrams" type="number" inputmode="decimal" value="100" min="0.1" max="3000" step="any"> 克</span></label><p class="food-portion-hint">按可食部分的重量换算；不预设“一碗”或“一个”的重量。</p><p id="foodPortionError" class="food-portion-error" role="status"></p><div id="foodPortionNutrition" class="food-portion-nutrition"></div><p class="food-detail-basis">每100克可食部 · 能量口径：${esc(food.energyBasisLabel)}</p><details class="food-all-nutrients"><summary>查看全部 ${result.nutrients.length} 项营养明细</summary><p>以下为每100克原始含量，空缺显示为未知。</p><table><thead><tr><th>营养指标</th><th>每100克含量</th></tr></thead><tbody>${result.nutrients.map(n=>`<tr><td>${esc(n.name)}</td><td>${n.value==null?'未知':`${esc(n.value)} ${esc(n.unit)}`}</td></tr>`).join('')}</tbody></table></details><p class="food-source-note"><a href="${esc(food.source.url)}" target="_blank" rel="noopener noreferrer">台湾食药署 · ${esc(food.id)}</a><br>${esc(food.source.attribution)} <a href="${esc(food.source.licenseUrl)}" target="_blank" rel="noopener noreferrer">授权条款</a></p>`;
      renderPortion();
    }catch(error){if(token===detailRequest)el('foodDetailContent').innerHTML=`<p class="food-empty">${esc(errorText(error))}</p>`}
  }
  async function record(id,grams=100){
    pendingMeal={id,grams};el('foodDetail').close();
    if(await window.XiaofanDevice.start())document.dispatchEvent(new CustomEvent('xiaofan:food-selected'));
  }
  el('foodSearchForm').addEventListener('submit',event=>{event.preventDefault();query=el('foodSearchInput').value.trim().slice(0,100);category='all';page=1;load()});
  el('publicFoodSearchForm').addEventListener('submit',event=>{event.preventDefault();open(el('publicFoodSearchInput').value)});
  el('foodSearchClear').addEventListener('click',()=>{el('foodSearchInput').value='';query='';category='common';page=1;load();el('foodSearchInput').focus()});
  el('foodCategories').addEventListener('click',event=>{const button=event.target.closest('[data-food-category]');if(!button)return;category=button.dataset.foodCategory;page=1;load()});
  el('foodPrevious').addEventListener('click',()=>{if(page>1){page--;load()}});el('foodNext').addEventListener('click',()=>{page++;load()});
  el('foodResults').addEventListener('click',event=>{
    const button=event.target.closest('[data-food-detail],[data-food-record],[data-food-reset],[data-food-retry]');if(!button)return;
    if(button.dataset.foodDetail)detail(button.dataset.foodDetail);
    else if(button.dataset.foodRecord&&foods.has(button.dataset.foodRecord))record(button.dataset.foodRecord);
    else if(button.hasAttribute('data-food-reset')){query='';category='all';page=1;el('foodSearchInput').value='';load()}
    else if(button.hasAttribute('data-food-retry'))load();
  });
  el('foodDetailContent').addEventListener('input',event=>{if(event.target.id==='foodGrams')renderPortion()});
  el('foodDetailRecord').addEventListener('click',()=>{const grams=Number(el('foodGrams')?.value);if(detailFood&&grams>0&&grams<=3000)record(detailFood.id,grams)});
  el('foodDetailClose').addEventListener('click',()=>el('foodDetail').close());
  document.addEventListener('click',event=>{if(event.target.closest('[data-open-food-catalog]'))open()});
  return {open,takeSelection(){const value=pendingMeal;pendingMeal=null;return value}};
})();
