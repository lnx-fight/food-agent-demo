import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {MultiFormatReader,BarcodeFormat,BinaryBitmap,HybridBinarizer,RGBLuminanceSource,DecodeHintType}=require('@zxing/library');

test('实际条码编码/解码：EAN13照片算法可读取商品编号，无需LLM',()=>{
 const code='3017620422003',left=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
 const parity='LLGGGL'; // EAN-13 prefix 3, fixture independent of scanner implementation.
 const invert=bits=>bits.replace(/[01]/g,b=>b==='0'?'1':'0');
 const bars='0'.repeat(12)+'101'+[...code.slice(1,7)].map((n,i)=>parity[i]==='L'?left[+n]:invert(left[+n]).split('').reverse().join('')).join('')+'01010'+[...code.slice(7)].map(n=>invert(left[+n])).join('')+'101'+'0'.repeat(12);
 const w=bars.length*4,h=180,pixels=new Uint8ClampedArray(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)pixels[y*w+x]=bars[Math.floor(x/4)]==='1'?0:255;
 const hints=new Map([[DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.EAN_13]]]),result=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels,w,h))),hints);
 assert.equal(result.getText(),code);
});
