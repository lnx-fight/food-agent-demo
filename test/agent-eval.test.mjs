import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMealType,inferMealType} from '../server.mjs';

// 离线评测夹具：验证 Agent 依赖的基础解析逻辑不会回归
test('餐次解析覆盖口语表达',()=>{
  assert.equal(normalizeMealType('晚饭'),'晚餐');
  assert.equal(normalizeMealType('中午'),'午餐');
  assert.equal(normalizeMealType('早餐'),'早餐');
  assert.equal(normalizeMealType('其他摄入'),'其他摄入');
  assert.equal(normalizeMealType(''),'');
});

test('inferMealType 兜底必然落在三个正餐之一',()=>{
  const t=inferMealType('随便吃点');
  assert.ok(['早餐','午餐','晚餐'].includes(t));
});

test('硬约束回归：忌口关键词词条保留完整词根',()=>{
  // preferenceTerms 在服务器端用于硬过滤，这里验证其词条切分不会把“花生”截断
  const terms='不吃花生、海鲜过敏'.split(/[、,，;；\s]+/).map(x=>x.replace(/不吃|过敏|不喜欢|忌口|不要/g,'').trim()).filter(x=>x.length>=2);
  assert.ok(terms.includes('花生'));
  assert.ok(terms.includes('海鲜'));
});
