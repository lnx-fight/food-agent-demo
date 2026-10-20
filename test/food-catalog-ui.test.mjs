import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../food-catalog.js',import.meta.url),'utf8');
const food={id:'tfda:A0550601',name:'白饭',displayName:'米饭',icon:'🍚',category:'staple',categoryLabel:'主食',description:'样品状态:熟',energyBasisLabel:'修正热量',per100g:{kcal:182,protein:3.1,fat:null,carbs:40},nutrientCount:104,source:{url:'https://data.gov.tw/dataset/8543',licenseUrl:'https://data.gov.tw/license',attribution:'官方数据'}};
const categoryData={total:2213,categories:[{id:'common',name:'常见',count:14},{id:'all',name:'全部食品',count:2213},{id:'staple',name:'主食',count:137}],source:{attribution:'官方数据'}};
const list={foods:[food],total:1,page:1,pages:1};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(fetcher){
 const nodes=new Map(),requests=[],events=[],documentHandlers={};let starts=0;
 function node(id){if(!nodes.has(id))nodes.set(id,{id,value:id==='foodGrams'?'100':'',textContent:'',innerHTML:'',open:false,handlers:{},attributes:{},disabled:false,addEventListener(name,fn){this.handlers[name]=fn},setAttribute(name,value){this.attributes[name]=value},showModal(){this.open=true},close(){this.open=false},focus(){}});return nodes.get(id)}
 const document={getElementById:node,addEventListener(name,fn){documentHandlers[name]=fn},dispatchEvent(event){events.push(event)}};
 const window={XiaofanDevice:{async start(){starts++;return true}}};
 runInNewContext(source,{window,document,Intl,URLSearchParams,CustomEvent:class{constructor(type){this.type=type}},fetch:async(path,options)=>{
  requests.push({path,options});const data=fetcher?await fetcher(path):path.includes('/categories')?categoryData:path.includes('/details')?{result:{food,nutrients:[{name:'膳食纤维',value:null,unit:'g'},{name:'钠',value:'0',unit:'mg'}]}}:list;
  return {ok:true,json:async()=>data};
 }});
 const click=(id,dataset,attributes=[])=>node(id).handlers.click({target:{closest:()=>({dataset,hasAttribute:name=>attributes.includes(name)})}});
 return {catalog:window.XiaofanCatalog,node,requests,events,documentHandlers,click,starts:()=>starts};
}
test('热量查询不创建会话、不弹个人资料；渲染分类、结果、营养详情和份量换算',async()=>{
 const h=harness();assert.equal(h.requests.length,0);
 await h.catalog.open('米饭');assert.equal(h.starts(),0);assert.equal(h.node('foodCatalog').open,true);
 assert.match(h.node('foodResults').innerHTML,/182/);assert.match(h.node('foodResults').innerHTML,/千卡/);assert.match(h.node('foodCategories').innerHTML,/主食/);
 assert.ok(h.requests.every(r=>r.path.startsWith('/api/food-catalog')&&r.options.credentials==='omit'));
 assert.match(h.requests.at(-1).path,/category=all/);
 h.click('foodResults',{foodDetail:food.id});await flush();
 assert.equal(h.node('foodDetail').open,true);assert.match(h.node('foodPortionNutrition').innerHTML,/182 千卡/);assert.match(h.node('foodPortionNutrition').innerHTML,/未知/);assert.match(h.node('foodDetailContent').innerHTML,/0 mg/);
 h.node('foodGrams').value='150';h.node('foodDetailContent').handlers.input({target:{id:'foodGrams'}});assert.match(h.node('foodPortionNutrition').innerHTML,/273 千卡/);assert.match(h.node('foodPortionNutrition').innerHTML,/4.65 克/);
 h.node('foodGrams').value='0';h.node('foodDetailContent').handlers.input({target:{id:'foodGrams'}});assert.equal(h.node('foodDetailRecord').disabled,true);
 h.node('foodGrams').value='150';h.node('foodDetailContent').handlers.input({target:{id:'foodGrams'}});
 h.node('foodDetailRecord').handlers.click();await flush();
 assert.equal(h.starts(),1);assert.equal(h.node('foodCatalog').open,false);assert.equal(h.node('foodDetail').open,false);assert.equal(h.events[0].type,'xiaofan:food-selected');
 const selected=h.catalog.takeSelection();assert.equal(selected.id,food.id);assert.equal(selected.grams,150);assert.equal(h.catalog.takeSelection(),null);
 assert.equal(h.requests.some(r=>r.path.includes('/api/user/')),false);
});
test('分类搜索和重试不进入个人流程，食品内容正确转义',async()=>{
 const unsafe={...food,displayName:'<img src=x onerror=alert(1)>'};
 const h=harness(async path=>path.includes('/categories')?categoryData:{...list,foods:[unsafe]});
 await h.catalog.open();assert.match(h.node('foodResults').innerHTML,/&lt;img/);assert.doesNotMatch(h.node('foodResults').innerHTML,/<img src=x/);
 h.click('foodCategories',{foodCategory:'staple'});await flush();assert.match(h.requests.at(-1).path,/category=staple/);
 h.node('foodSearchInput').value='汉堡';h.node('foodSearchForm').handlers.submit({preventDefault(){}});await flush();assert.match(h.requests.at(-1).path,/category=all/);assert.equal(h.starts(),0);
 h.node('foodCatalogClose').handlers.click();assert.equal(h.node('foodCatalog').open,false);
});
test('快速切换搜索时，较早的网络响应不能覆盖新结果',async()=>{
 let finishOld;
 const h=harness(async path=>{
  if(path.includes('/categories'))return categoryData;
  if(path.includes('q=old'))return new Promise(resolve=>{finishOld=resolve});
  return {...list,foods:[{...food,displayName:'最新食品'}]};
 });
 const old=h.catalog.open('old');await flush();await h.catalog.open('new');assert.match(h.node('foodResults').innerHTML,/最新食品/);
 finishOld({...list,foods:[{...food,displayName:'过期食品'}]});await old;
 assert.match(h.node('foodResults').innerHTML,/最新食品/);assert.doesNotMatch(h.node('foodResults').innerHTML,/过期食品/);
});
test('公开入口、独立详情与记餐交接资源完整，只有记录才进入个人使用',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/id="publicFoodSearchForm"/);assert.match(html,/<dialog id="foodCatalog"/);assert.match(source,/id="foodGrams"/);assert.match(html,/food-catalog.js/);
});
