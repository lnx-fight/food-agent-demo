const invalid=message=>Object.assign(new Error(message),{status:400});
export function validBarcode(value){
  const code=String(value??'').trim();
  if(!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)||/^0+$/.test(code))return false;
  let sum=0;for(let i=code.length-2,weight=3;i>=0;i--,weight=weight===3?1:3)sum+=Number(code[i])*weight;
  return (10-sum%10)%10===Number(code.at(-1));
}
export function canonicalBarcode(value){
  const code=String(value??'').trim();if(!validBarcode(code))throw invalid('请输入校验位正确的8、12、13或14位商品条码');
  return code.padStart(14,'0');
}
function number(value,{required=false,max=100000}={}){
  if(value==null||value===''){if(required)throw invalid('请填写完整的标签数值');return null}
  const n=Number(value);if(!Number.isFinite(n)||n<0||n>max)throw invalid('标签数值超出有效范围');return n;
}
export function normalizePackagedFood(input){
  if(input.confirmed!==true)throw invalid('请先核对包装标签，再确认保存');
  const barcode=canonicalBarcode(input.barcode),name=String(input.name||'').trim(),brand=String(input.brand||'').trim();
  if(!name||name.length>100||brand.length>100)throw invalid('请填写有效的商品名称');
  const basisUnit=String(input.basisUnit||'');if(!['g','ml','serving'].includes(basisUnit))throw invalid('请选择克、毫升或份作为标签单位');
  const basisAmount=number(input.basisAmount,{required:true,max:10000});if(!basisAmount)throw invalid('标签基准量必须大于0');
  const energyUnit=String(input.energyUnit||'');if(!['kcal','kJ'].includes(energyUnit))throw invalid('请选择千卡或千焦');
  const energy=number(input.energy,{required:true,max:50000}),nutrients={kcal:+(energyUnit==='kJ'?energy/4.184:energy).toFixed(4)};
  for(const key of ['protein','fat','carbs','sugar','fiber','sodiumMg'])nutrients[key]=number(input[key],{max:key==='sodiumMg'?100000:10000});
  const servingAmount=number(input.servingAmount,{max:10000});
  const servingUnit=servingAmount?String(input.servingUnit||''):null;
  if(servingAmount&&!['g','ml'].includes(servingUnit))throw invalid('每份重量须明确为克或毫升');
  const relative=basisUnit==='serving'&&servingAmount?basisAmount*servingAmount:basisUnit!=='serving'?basisAmount:null;
  if(relative!=null&&['protein','fat','carbs','sugar','fiber'].some(key=>nutrients[key]!=null&&nutrients[key]>relative*1.1))throw invalid('营养克数超过标签基准量，请核对每份与每100克口径');
  return {barcode,name,brand,basisUnit,basisAmount,energyUnit,energy,nutrients,servingAmount:servingAmount||null,servingUnit,source:'user_confirmed_label'};
}
export function packagedPortion(product,amount,unit){
  const quantity=Number(amount);if(!Number.isFinite(quantity)||quantity<=0||quantity>10000)throw invalid('请输入有效的实际食用量');
  let converted=quantity;
  if(unit!==product.basisUnit){
    if(!product.servingAmount)throw invalid('标签未提供每份重量，不能换算单位');
    if(unit==='serving'&&product.basisUnit===product.servingUnit)converted=quantity*product.servingAmount;
    else if(product.basisUnit==='serving'&&unit===product.servingUnit)converted=quantity/product.servingAmount;
    else throw invalid('克与毫升不能直接换算');
  }
  const factor=converted/product.basisAmount;
  return Object.fromEntries(Object.entries(product.nutrients).map(([key,value])=>[key,value==null?null:+(value*factor).toFixed(2)]));
}
