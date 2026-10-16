import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {executeAgentTool} from '../server.mjs';

const dataset=JSON.parse(readFileSync(new URL('./fixtures/agent-behavior-cases.json',import.meta.url),'utf8'));
const sampleTypes=['positive','negative','boundary_ambiguous','exception','adversarial'];

test('Agent 行为评测集完整覆盖五类样本',()=>{
  assert.equal(dataset.schemaVersion,1);
  assert.equal(dataset.scope,'next-meal-decision');
  assert.equal(dataset.cases.length,30);
  assert.equal(new Set(dataset.cases.map(item=>item.id)).size,dataset.cases.length);
  for(const type of sampleTypes)assert.ok(dataset.cases.filter(item=>item.sampleType===type).length>=5,`${type} 样本不足`);
});

test('负样本不命中 Skill，异常和对抗样本具备明确判定依据',()=>{
  const catalog=dataset.toolFixtureCatalog;
  for(const item of dataset.cases.filter(item=>item.sampleType==='negative'))assert.equal(item.expected.skill,null,item.id);
  for(const item of dataset.cases.filter(item=>item.sampleType==='exception')){
    assert.ok(item.toolFixtureRefs.length>0,item.id);
    assert.ok(item.toolFixtureRefs.some(ref=>{
      const fixture=catalog[ref];
      return fixture.ok===false||(Array.isArray(fixture.result)&&fixture.result.length===0)||fixture.result?.nutrition===null;
    }),`${item.id} 缺少可复现异常 fixture`);
  }
  for(const item of dataset.cases.filter(item=>item.sampleType==='adversarial')){
    assert.ok(item.hardConstraints.length>0,item.id);
    assert.ok(item.expected.judgeCriteria.length>0,item.id);
    assert.deepEqual(item.judgeMethods,['rule','model'],item.id);
  }
});

test('Tool fixture 仅在测试环境短路真实外部调用',async()=>{
  assert.equal(process.env.NODE_ENV,'test');
  const fixture={ok:false,result:{error:'固定的评测异常'}};
  const out=await executeAgentTool('search_nearby_restaurants',{}, {toolFixtures:{search_nearby_restaurants:fixture}});
  assert.equal(out.tool,'search_nearby_restaurants');
  assert.equal(out.ok,false);
  assert.deepEqual(out.result,{error:'固定的评测异常'});
  out.result.error='已修改';
  assert.equal(fixture.result.error,'固定的评测异常');
});
