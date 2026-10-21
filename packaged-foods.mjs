import {canonicalBarcode,normalizePackagedFood} from './packaged-nutrition.mjs';
export async function lookupPackagedFood(db,owner,barcode){
  const code=canonicalBarcode(barcode),row=await db.prepare('SELECT product,updated_at FROM packaged_foods WHERE owner_id=? AND barcode=?').get(owner,code);
  return row?{...JSON.parse(row.product),updatedAt:row.updated_at}:null;
}
export async function savePackagedFood(db,owner,input){
  const product=normalizePackagedFood(input),updatedAt=new Date().toISOString();
  await db.prepare('INSERT INTO packaged_foods(owner_id,barcode,product,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,barcode) DO UPDATE SET product=excluded.product,updated_at=excluded.updated_at').run(owner,product.barcode,JSON.stringify(product),updatedAt);
  return {...product,updatedAt};
}
export async function deletePackagedFood(db,owner,barcode){
  await db.prepare('DELETE FROM packaged_foods WHERE owner_id=? AND barcode=?').run(owner,canonicalBarcode(barcode));
}
export function labelImage(value){
  if(typeof value!=='string'||!/^data:image\/(?:jpeg|png|webp);base64,[a-zA-Z0-9+/]+=*$/.test(value)||value.length>7_000_000)throw Object.assign(new Error('请上传不超过5MB的JPG、PNG或WebP营养标签照片'),{status:400});
  return value;
}
// OCR is only a draft. Unknown units and values stay empty for user review.
export function labelDraft(value={}){
  const text=key=>String(value[key]||'').slice(0,100),num=key=>value[key]==null||value[key]===''?null:Number.isFinite(Number(value[key]))&&Number(value[key])>=0?Number(value[key]):null;
  const result={name:text('name'),brand:text('brand'),basisUnit:['g','ml','serving'].includes(value.basisUnit)?value.basisUnit:'',basisAmount:num('basisAmount'),energyUnit:['kcal','kJ'].includes(value.energyUnit)?value.energyUnit:'',energy:num('energy'),servingAmount:num('servingAmount'),servingUnit:['g','ml'].includes(value.servingUnit)?value.servingUnit:''};
  for(const key of ['protein','fat','carbs','sugar','fiber','sodiumMg'])result[key]=num(key);
  return result;
}
