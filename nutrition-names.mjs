import * as OpenCC from 'opencc-js/t2cn';

// Conversion changes labels and lookup keys only, never nutrition values.
export const simplifyChinese=OpenCC.Converter({from:'tw',to:'cn'});
export function nutritionKey(value){
  return simplifyChinese(String(value||'').normalize('NFKC')).toLowerCase().trim().replace(/[（]/g,'(').replace(/[）]/g,')').replace(/\s+/g,' ');
}
