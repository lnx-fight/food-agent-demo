import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {canonicalBarcode,validBarcode,normalizePackagedFood,packagedPortion} from '../packaged-nutrition.mjs';
import {lookupPackagedFood,savePackagedFood,labelDraft,labelImage} from '../packaged-foods.mjs';

const input={barcode:'3017620422003',name:'测试饼干',brand:'测试品牌',basisUnit:'g',basisAmount:100,energyUnit:'kJ',energy:2092,protein:6,fat:20,carbs:65,confirmed:true};
test('GTIN校验及补零规范化，不接受二维码链接、校验错误或丢失前导零',()=>{
 assert.equal(validBarcode('3017620422003'),true);assert.equal(validBarcode('3017620422004'),false);
 assert.equal(canonicalBarcode('012345678905'),canonicalBarcode('0012345678905'));
 assert.equal(canonicalBarcode('3017620422003'),'03017620422003');
 for(const code of ['00000000','123','https://example.com','3017620422004'])assert.throws(()=>canonicalBarcode(code));
});
test('按标签基准换算千焦/千卡、克/毫升/份，缺失蛋白质保持未知',()=>{
 const product=normalizePackagedFood(input);assert.equal(product.nutrients.kcal,500);
 assert.equal(packagedPortion(product,30,'g').kcal,150);assert.equal(product.nutrients.sugar,null);
 assert.throws(()=>packagedPortion(product,30,'ml'),/重量|换算/);
 const serving=normalizePackagedFood({...input,basisUnit:'serving',basisAmount:1,energyUnit:'kcal',energy:150,servingAmount:30,servingUnit:'g',protein:'',fat:6,carbs:19.5});
 assert.equal(packagedPortion(serving,15,'g').kcal,75);assert.equal(packagedPortion(serving,.5,'serving').protein,null);
 const drink=normalizePackagedFood({...input,basisUnit:'ml',energyUnit:'kcal',energy:40,protein:3,carbs:6,fat:1,servingAmount:250,servingUnit:'ml'});
 assert.equal(packagedPortion(drink,1,'serving').kcal,100);
 assert.throws(()=>packagedPortion(drink,250,'g'),/直接换算/);
 assert.throws(()=>normalizePackagedFood({...input,confirmed:false}),/核对/);
 for(const patch of [{basisAmount:0},{energy:-1},{energyUnit:'kcal;drop table'},{protein:200}])assert.throws(()=>normalizePackagedFood({...input,...patch}));
});
test('私有D1商品主键隔离，同条码不同用户互不覆盖，不能注入SQL',async()=>{
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE accounts(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES('a'),('b');");db.exec(readFileSync(new URL('../migrations/0014_packaged_foods.sql',import.meta.url),'utf8'));
 await savePackagedFood(db,'a',input);assert.equal(await lookupPackagedFood(db,'b',input.barcode),null);
 await savePackagedFood(db,'b',{...input,name:'另一个包装',energy:100});assert.equal((await lookupPackagedFood(db,'a',input.barcode)).name,'测试饼干');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM packaged_foods').get().n,2);
 await assert.rejects(lookupPackagedFood(db,'a',"3017620422003' OR 1=1"));db.close();
});
test('识别草稿不猜数字，拒绝远程图片地址与过大图片，原始图不写入产品',()=>{
 assert.equal(labelDraft({protein:null,energy:'bad',basisUnit:'unknown'}).protein,null);assert.equal(labelDraft({energy:'bad'}).energy,null);
 assert.equal(labelDraft({basisUnit:'unknown'}).basisUnit,'');assert.throws(()=>labelImage('https://example.com/image.jpg'));
 assert.equal(labelImage('data:image/jpeg;base64,AA=='),'data:image/jpeg;base64,AA==');
 assert.throws(()=>labelImage('data:image/jpeg;base64,'+'A'.repeat(7_000_000)));
 assert.ok(!JSON.stringify(normalizePackagedFood({...input,imageDataUrl:'private'})).includes('private'));
});

process.env.NODE_ENV='test';process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-packaged-'));process.env.DASHSCOPE_API_KEY='';
const {server}=await import('../server.mjs');
server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
async function call(path,{cookie,body}={}){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
test('包装食品API：不读跨用户商品，导出/清空/删除涵盖补录数据，不自动写入饮食',async()=>{
 assert.equal((await call('/api/nutrition/barcode/'+input.barcode)).status,401);
 const a=(await call('/api/device/session',{body:{}})).cookie,b=(await call('/api/device/session',{body:{}})).cookie;
 assert.equal((await call('/api/packaged-foods',{cookie:a,body:{...input,confirmed:false}})).status,400);
 assert.equal((await call('/api/packaged-foods',{cookie:a,body:input})).status,200);
 assert.equal((await call('/api/nutrition/barcode/'+input.barcode,{cookie:a})).status,200);
 assert.equal((await call('/api/nutrition/barcode/'+input.barcode,{cookie:b})).status,404);
 const exported=await call('/api/device/export',{cookie:a});assert.equal(exported.data.records.packaged_foods.length,1);
 assert.equal((await call('/api/user/state',{cookie:a})).data.state,null);
 assert.equal((await call('/api/packaged-foods/label',{cookie:a,body:{imageDataUrl:'data:image/jpeg;base64,AA=='}})).status,503);
 assert.equal((await call('/api/packaged-foods/label',{cookie:a,body:{imageDataUrl:'https://evil.test'}})).status,400);
 const cleared=await call('/api/device/clear',{cookie:a,body:{confirmation:'清空数据'}});assert.equal(cleared.status,200);
 assert.equal((await call('/api/nutrition/barcode/'+input.barcode,{cookie:cleared.cookie})).status,404);
 assert.equal((await call('/api/packaged-foods',{cookie:b,body:input})).status,200);
 assert.equal((await call('/api/device/delete',{cookie:b,body:{confirmation:'删除全部数据'}})).status,200);
});
