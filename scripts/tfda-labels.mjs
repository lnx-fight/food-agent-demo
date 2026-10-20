import {simplifyChinese,nutritionKey} from '../nutrition-names.mjs';

let text='';for await(const chunk of process.stdin)text+=chunk;
const foods=JSON.parse(text);
for(const food of foods){
  food.name=simplifyChinese(food.original_name);
  food.category=simplifyChinese(food.category);
  food.description=simplifyChinese(food.description);
  food.names=food.names.map(([term,kind])=>[nutritionKey(term),kind]);
}
process.stdout.write(JSON.stringify(foods));
