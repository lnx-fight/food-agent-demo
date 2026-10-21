import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {canonicalBarcode,normalizePackagedFood,packagedPortion} from '../packaged-nutrition.mjs';
const source=readFileSync(new URL('../frontend/packaged-foods.js',import.meta.url),'utf8').replace(/^import .*;\n/,'');
const product=normalizePackagedFood({barcode:'3017620422003',name:'饼干',brand:'测试',basisUnit:'g',basisAmount:100,energyUnit:'kcal',energy:500,protein:6,fat:20,carbs:65,confirmed:true});
function harness(){
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,disabled:false,events:{},children:[],textContent:'',addEventListener(name,fn){this.events[name]=fn},replaceChildren(){this.children=[];this.value=''},append(item){this.children.push(item);if(!this.value)this.value=item.value},focus(){}});return nodes.get(id)};
 const fields=Object.fromEntries(['name','brand','basisAmount','basisUnit','energy','energyUnit','protein','fat','carbs','sugar','fiber','sodiumMg','servingAmount','servingUnit','confirmed'].map(key=>[key,{value:'',checked:false}]));
 const form=node('packagedForm');form.elements={namedItem:name=>fields[name]};form.reset=()=>{for(const f of Object.values(fields)){f.value='';f.checked=false}};
 const dialog=node('packagedDialog');dialog.open=false;dialog.showModal=()=>dialog.open=true;dialog.close=()=>{dialog.open=false;dialog.events.close()};
 let response={ok:true,json:async()=>({product})},records=[],stops=0;
 const context={console,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({value:'',textContent:''})},window:{XiaofanRecordPackaged:data=>records.push(data)},setTimeout,clearTimeout,canonicalBarcode,normalizePackagedFood,packagedPortion,URL,fetch:async()=>typeof response==='function'?await response():response};
 runInNewContext(source,context);
 return {node,fields,dialog,records,context,setResponse:value=>response=value,open:()=>context.window.XiaofanPackaged.open(),stops:()=>stops,track:()=>({stop(){stops++}})};
}
test('包装UI：保存商品查询后带入基准和营养，实际克数换算后只进入确认表单',async()=>{
 const h=harness();h.open();h.node('packagedCode').value=product.barcode;await h.node('packagedLookup').onclick();
 assert.equal(h.fields.protein.value,6);assert.equal(h.fields.energy.value,500);assert.equal(h.node('packagedRecord').disabled,false);
 h.node('packagedAmount').value='30';h.node('packagedAmount').oninput();assert.match(h.node('packagedPortionSummary').textContent,/150 千卡/);assert.equal(h.records.length,0);
 h.node('packagedRecord').onclick();assert.equal(h.records.length,1);assert.equal(h.records[0].nutrition.kcal,150);assert.equal(h.records[0].amount,30);assert.equal(h.dialog.open,false);
});
test('包装UI：改条码或标签取消旧结果，晚到的响应不覆盖新输入，关闭时停止相机',async()=>{
 const h=harness();h.open();h.node('packagedCode').value=product.barcode;
 let resolve;h.setResponse(()=>new Promise(done=>resolve=done));const pending=h.node('packagedLookup').onclick();
 h.node('packagedCode').value='012345678905';h.node('packagedCode').events.input();resolve({ok:true,json:async()=>({product})});await pending;
 assert.equal(h.node('packagedRecord').disabled,true);assert.equal(h.fields.name.value,'');
 h.node('packagedVideo').srcObject={getTracks:()=>[h.track()]};h.dialog.close();assert.equal(h.stops(),1);assert.equal(h.node('packagedVideo').srcObject,null);
});
test('包装UI：缺失商品和识别失败保留手动补录路径；未经确认不可保存',async()=>{
 const h=harness();h.open();h.node('packagedCode').value=product.barcode;h.setResponse({ok:false,status:404,json:async()=>({error:'尚未收录'})});await h.node('packagedLookup').onclick();assert.match(h.node('packagedStatus').textContent,/手动填写/);assert.equal(h.node('packagedRecord').disabled,true);
});

test('实际记餐交接保留小数蛋白质和食用量，等待用户最终确认',()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const handoff=app.slice(app.indexOf('window.XiaofanRecordPackaged='),app.indexOf('function clearMealNutritionState'));
 const form={elements:Object.fromEntries(['name','unit','grams','calories','protein'].map(k=>[k,{value:'',step:'0.1'}])),dataset:{}};
 let opened=0,recalculated=0;const status={textContent:''},context={window:{},userData:{profile:{age:30}},$:selector=>selector==='#manualMealForm'?form:status,openMealRecord:()=>opened++,recalculateBarcodeNutrition:()=>recalculated++};
 runInNewContext(handoff,context);context.window.XiaofanRecordPackaged({product,amount:26.5,unit:'g',nutrition:{kcal:132.5,protein:1.59}});
 assert.equal(opened,1);assert.equal(recalculated,1);assert.equal(form.elements.protein.step,'any');assert.equal(form.elements.protein.value,1.59);assert.equal(form.elements.calories.value,132.5);assert.equal(form.elements.grams.value,26.5);assert.equal(form.dataset.nutritionSource,'PACKAGED_LABEL');assert.match(status.textContent,/确认日期、餐次/);
});
