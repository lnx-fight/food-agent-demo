import {canonicalBarcode,normalizePackagedFood,packagedPortion} from '../packaged-nutrition.mjs';
const dialog=document.getElementById('packagedDialog');
const el=id=>document.getElementById(id),form=el('packagedForm');
let selected=null,requestId=0,cameraId=0,controls=null,cameraTimer=null;
const say=text=>{el('packagedStatus').textContent=text};
const field=name=>form.elements.namedItem(name);
async function api(path,body){
 const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(response.status===401){dialog.close();window.XiaofanDevice?.expired()}if(!response.ok)throw Object.assign(new Error(data.error||'请求失败'),{status:response.status});return data;
}
function clearProduct(){selected=null;el('packagedRecord').disabled=true;el('packagedPortionSummary').textContent='';}
function fill(product){
 form.reset();product={...product,...product.nutrients};for(const key of ['name','brand','basisUnit','basisAmount','energyUnit','energy','protein','fat','carbs','sugar','fiber','sodiumMg','servingAmount','servingUnit'])field(key).value=product[key]??'';
 field('confirmed').checked=false;clearProduct();
}
function inputProduct(){
 const data=Object.fromEntries(new FormData(form));return {...data,barcode:el('packagedCode').value,confirmed:field('confirmed').checked};
}
function showProduct(product){
 selected=product;el('packagedRecord').disabled=product.nutrients.kcal==null;
 const unit=el('packagedAmountUnit');unit.replaceChildren();
 const units=new Set([product.basisUnit]);if(product.servingAmount){units.add('serving');units.add(product.servingUnit)}
 for(const value of units){const option=document.createElement('option');option.value=value;option.textContent={g:'克',ml:'毫升',serving:'份'}[value];unit.append(option)}
 el('packagedAmount').value=product.basisUnit==='serving'?'1':String(product.basisAmount);calculate();
}
function calculate(){
 if(!selected)return;
 try{const n=packagedPortion(selected,el('packagedAmount').value,el('packagedAmountUnit').value);el('packagedPortionSummary').textContent=`本次食用：${n.kcal} 千卡 · 蛋白质 ${n.protein==null?'未知':n.protein+'克'}`;el('packagedRecord').disabled=false}
 catch(error){el('packagedPortionSummary').textContent=error.message;el('packagedRecord').disabled=true}
}
async function lookup(){
 stopCamera();const token=++requestId;clearProduct();form.reset();
 try{
  const code=canonicalBarcode(el('packagedCode').value);say('正在查询你的商品库…');
  const data=await api('/api/nutrition/barcode/'+code);if(token!==requestId||!dialog.open)return;
  fill(data.product);showProduct(data.product);say('已找到你核对过的商品，请检查包装是否相同，再填写实际食用量。');
 }catch(error){if(token===requestId)say(error.status===404?'尚未收录。请拍营养标签或手动填写，核对后保存。':error.message)}
}
function stopCamera(){
 cameraId++;clearTimeout(cameraTimer);controls?.stop();controls=null;
 const video=el('packagedVideo');video.srcObject?.getTracks().forEach(track=>track.stop());video.srcObject=null;video.hidden=true;el('packagedStopCamera').hidden=true;
}
async function camera(){
 stopCamera();const token=cameraId;const video=el('packagedVideo');video.hidden=false;el('packagedStopCamera').hidden=false;say('将商品条码放入画面中；未识别时可拍照或手动输入。');
 cameraTimer=setTimeout(()=>{if(token===cameraId){stopCamera();say('未识别到条码，请拍清晰照片或手动输入编号。')}},25000);
 try{
  const reader=window.XiaofanBarcodeScanner.create();
  const result=await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'}},audio:false},video,(found,error,control)=>{
   if(token!==cameraId){control.stop();return}
   if(found){try{const code=canonicalBarcode(found.getText());control.stop();el('packagedCode').value=code;stopCamera();lookup()}catch{}}
  });
  if(token!==cameraId||!dialog.open){result.stop()}else controls=result;
 }catch{if(token===cameraId){stopCamera();say('无法打开摄像头，请允许相机权限，或上传条码照片、手动输入。')}}
}
async function photoBarcode(file){
 stopCamera();const token=++requestId;if(!file)return;
 if(file.size>10_000_000){say('条码照片请小于10MB');return}
 const url=URL.createObjectURL(file);say('正在本机识别条码照片…');
 try{const found=await window.XiaofanBarcodeScanner.create().decodeFromImageUrl(url);if(token!==requestId||!dialog.open)return;el('packagedCode').value=canonicalBarcode(found.getText());await lookup()}
 catch{if(token===requestId)say('没有识别到有效商品条码，请重新拍摄或手动输入。')}
 finally{URL.revokeObjectURL(url)}
}
async function imageData(file){
 if(!/^image\/(jpeg|png|webp)$/.test(file.type)||file.size>10_000_000)throw new Error('请选择小于10MB的JPG、PNG或WebP图片');
 const bitmap=await createImageBitmap(file);try{
  const ratio=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*ratio);canvas.height=Math.round(bitmap.height*ratio);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.86);
 }finally{bitmap.close()}
}
async function recognize(file){
 if(!file)return;stopCamera();const token=++requestId;clearProduct();say('正在读取营养标签，请稍候。识别后仍需逐项核对。');
 try{canonicalBarcode(el('packagedCode').value);const imageDataUrl=await imageData(file);if(token!==requestId)return;const data=await api('/api/packaged-foods/label',{imageDataUrl});if(token!==requestId||!dialog.open)return;fill(data.draft);say('已填入识别草稿。请对照照片核对单位与数值；空白项不会补成0。')}
 catch(error){if(token===requestId)say(error.message+' 可以继续手动填写。')}
}
form.addEventListener('submit',async event=>{
 event.preventDefault();stopCamera();const token=++requestId,button=el('packagedSave');button.disabled=true;
 try{const input=inputProduct();normalizePackagedFood(input);say('正在保存到你的商品库…');const data=await api('/api/packaged-foods',input);if(token!==requestId||!dialog.open)return;showProduct(data.product);say('已保存，仅此浏览器使用空间可见。输入实际食用量后可去确认记餐。')}
 catch(error){if(token===requestId)say(error.message)}finally{button.disabled=false}
});
form.addEventListener('input',event=>{if(event.target.name!=='confirmed'){requestId++;clearProduct();field('confirmed').checked=false}});
el('packagedCode').addEventListener('input',()=>{requestId++;clearProduct();form.reset()});
el('packagedLookup').onclick=lookup;el('packagedCamera').onclick=camera;el('packagedStopCamera').onclick=stopCamera;
el('packagedBarcodePhoto').onchange=event=>{photoBarcode(event.target.files[0]);event.target.value=''};
el('packagedLabelPhoto').onchange=event=>{recognize(event.target.files[0]);event.target.value=''};
el('packagedAmount').oninput=calculate;el('packagedAmountUnit').onchange=calculate;
el('packagedRecord').onclick=()=>{
 if(!selected)return;try{const amount=Number(el('packagedAmount').value),unit=el('packagedAmountUnit').value,nutrition=packagedPortion(selected,amount,unit);window.XiaofanRecordPackaged({product:selected,amount,unit,nutrition});dialog.close()}catch(error){say(error.message)}
};
el('packagedClose').onclick=()=>dialog.close();
dialog.addEventListener('close',()=>{stopCamera();requestId++;clearProduct();form.reset();el('packagedCode').value='';say('')});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera()});
window.XiaofanPackaged={open(){requestId++;clearProduct();form.reset();el('packagedCode').value='';say('扫描条码或输入编号。首次使用请按包装补录，之后可直接查询。');dialog.showModal();el('packagedCode').focus()}};
document.querySelectorAll('[data-open-packaged]').forEach(button=>button.addEventListener('click',()=>window.XiaofanOpenPackaged()));
