import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const routes=source.slice(source.indexOf("let pendingPersonalView='today';"),source.indexOf("$$('.nav-item').forEach(b=>"));
function harness({profile=false,offline=false}={}){
 const names=['catalog','discover','today','week','agent','trend','meals'],nodes=new Map();let starts=0,onboarding=0,catalogOpens=0;
 const classes=initial=>{const values=new Set(initial);return {add:name=>values.add(name),remove:name=>values.delete(name),toggle(name,on){on?values.add(name):values.delete(name)},contains:name=>values.has(name)}};
 const views=names.map(name=>({id:name+'View',classList:classes(name==='catalog'?['active']:[])}));views.forEach(node=>nodes.set('#'+node.id,node));
 nodes.set('#pageTitle',{textContent:'食物热量表'});nodes.set('.sidebar',{classList:classes([])});
 const nav=names.map(name=>({dataset:{view:name},classList:classes([]),attributes:{},setAttribute(name,value){this.attributes[name]=value},removeAttribute(name){delete this.attributes[name]}}));
 const context=createContext({state:{currentView:'catalog'},accountReady:false,userData:null,$:selector=>nodes.get(selector),$$:selector=>selector==='.view'?views:nav,initOnboarding(){onboarding++},window:{scrollTo(){}}});
 context.window.XiaofanDevice={async start(){starts++;if(offline)return false;context.accountReady=true;if(profile)context.userData={profile:{age:30}};return true}};
 context.window.XiaofanCatalog={async open(){catalogOpens++;context.window.XiaofanNavigatePublic('catalog')}};
 runInContext(routes,context);
 return {context,names,nav,views,starts:()=>starts,onboarding:()=>onboarding,catalogOpens:()=>catalogOpens};
}
test('热量表和发现位于同一主界面，未开始使用不连接身份服务或弹资料',async()=>{
 const h=harness();await h.context.switchView('catalog');await h.context.switchView('discover');
 assert.equal(h.starts(),0);assert.equal(h.onboarding(),0);assert.equal(h.context.state.currentView,'discover');assert.equal(h.nav.length,7);
 assert.equal(h.nav.find(node=>node.dataset.view==='catalog').dataset.view,'catalog');assert.equal(h.views.find(node=>node.id==='discoverView').classList.contains('active'),true);
 h.context.window.XiaofanNavigatePublic('today');assert.equal(h.context.state.currentView,'discover');assert.equal(h.onboarding(),0);
});
test('开始个人功能前后全部栏目仍在，已有资料可在今日、热量表和计划之间切换',async()=>{
 const h=harness({profile:true});
 await h.context.switchView('today');assert.equal(h.starts(),1);assert.equal(h.onboarding(),0);assert.equal(h.context.state.currentView,'today');
 for(const name of ['catalog','week','agent','trend','meals','discover','catalog']){
  await h.context.switchView(name);assert.equal(h.context.state.currentView,name);assert.equal(h.nav.length,7);assert.equal(h.views.filter(node=>node.classList.contains('active')).length,1);
 }
 assert.equal(h.starts(),1);assert.equal(h.onboarding(),0);assert.equal(h.nav.find(node=>node.dataset.view==='catalog').attributes['aria-current'],'page');
});
test('仅主动使用个人功能时才建档，离线失败仍能在主界面查热量',async()=>{
 const h=harness();await h.context.switchView('week');assert.equal(h.starts(),1);assert.equal(h.onboarding(),1);assert.equal(h.context.state.currentView,'catalog');assert.equal(runInContext('pendingPersonalView',h.context),'week');
 await h.context.switchView('catalog');assert.equal(h.starts(),1);assert.equal(h.onboarding(),1);
 h.context.userData={profile:{age:30}};await h.context.switchView('week');assert.equal(h.context.state.currentView,'week');
 const offline=harness({offline:true});await offline.context.switchView('today');assert.equal(offline.context.state.currentView,'catalog');assert.equal(offline.onboarding(),0);await offline.context.switchView('catalog');assert.equal(offline.catalogOpens(),1);
});
test('所有栏目实际位于唯一主界面内，热量表不再使用独立全屏弹窗',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const main=html.slice(html.indexOf('<main class="main-content">'),html.indexOf('</main>'));
 for(const id of ['catalog','discover','today','week','agent','trend','meals'])assert.match(main,new RegExp(`id="${id}View"`),id);
 assert.match(html,/class="nav-item active" data-view="catalog"/);assert.doesNotMatch(html,/<dialog id="foodCatalog"/);
 assert.equal((html.match(/class="app-shell"/g)||[]).length,1);assert.match(html,/id="cancelOnboarding"/);assert.match(html,/class="onboarding hidden" id="onboarding"/);
});
test('取消资料设置后再次点加号仍能建档，完成资料后才消费食品选择',async()=>{
 const h=harness();h.context.accountReady=true;
 const entry=source.slice(source.indexOf('async function resumeCatalogFood(){'),source.indexOf("document.addEventListener('xiaofan:food-selected'"));
 let taken=0,opened=0,recalculated=0;const selected={id:'tfda:A0550601',grams:150},form={dataset:{},elements:{grams:{}}};
 h.context.window.XiaofanCatalog.takeSelection=()=>{taken++;return selected};h.context.openMealRecord=()=>opened++;
 h.context.lookupDatasetNutrition=async id=>{form.dataset.matchedReference=id};h.context.recalculateBarcodeNutrition=()=>recalculated++;
 const original=h.context.$;h.context.$=selector=>selector==='#manualMealForm'?form:original(selector);
 runInContext(entry,h.context);
 await h.context.resumeCatalogFood();assert.equal(h.onboarding(),1);assert.equal(taken,0);assert.equal(opened,0);
 h.context.userData={profile:{age:30}};await h.context.resumeCatalogFood();assert.equal(taken,1);assert.equal(opened,1);assert.equal(form.elements.grams.value,150);assert.equal(recalculated,1);assert.equal(h.context.state.currentView,'today');
});
