import {BrowserMultiFormatReader} from '@zxing/browser';
import {BarcodeFormat,DecodeHintType} from '@zxing/library';
const hints=new Map([[DecodeHintType.POSSIBLE_FORMATS,[BarcodeFormat.EAN_13,BarcodeFormat.EAN_8,BarcodeFormat.UPC_A,BarcodeFormat.ITF]]]);
window.XiaofanBarcodeScanner={create:()=>new BrowserMultiFormatReader(hints)};
