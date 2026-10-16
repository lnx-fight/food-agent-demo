import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateAutomaticMetrics,calculateSampleTypeMetrics,calculateJudgeMetrics,releaseDecision,percentile} from '../scripts/agent-eval-metrics.mjs';

const config=JSON.parse(readFileSync(new URL('./fixtures/agent-eval-metrics.json',import.meta.url),'utf8'));
const metricById=(metrics,id)=>metrics.find(item=>item.id===id);
function row({id,type='positive',scenario='diy',passed=true,error='',ms=100,signals={}}){
  return {
    item:{id,sampleType:type,expected:{scenario}},
    error,
    ms,
    judgement:error?null:{passed,signals:{expectedSkill:true,actualSkill:true,intentCorrect:true,scenarioCorrect:true,actionCorrect:true,proposalCorrect:true,requiredToolHits:1,requiredToolTotal:1,allowedToolCalls:1,toolCallTotal:1,toolArgumentHits:1,toolArgumentTotal:1,answerSignalApplicable:true,answerSignalCorrect:true,forbiddenClaimHits:1,forbiddenClaimTotal:1,duplicateFree:true,decisionSignature:'stable',...signals}}
  };
}

test('自动指标分别计算 Skill、Tool、回答和延迟，不使用总加权分',()=>{
  const rows=[
    row({id:'p1'}),
    row({id:'n1',type:'negative',scenario:null,signals:{expectedSkill:false,actualSkill:false,requiredToolHits:0,requiredToolTotal:0,allowedToolCalls:0,toolCallTotal:0,toolArgumentHits:0,toolArgumentTotal:0,answerSignalApplicable:false,forbiddenClaimHits:0,forbiddenClaimTotal:0}}),
    row({id:'b1',type:'boundary_ambiguous',scenario:'unknown',passed:false,ms:300,signals:{actualSkill:false,scenarioCorrect:false,actionCorrect:false,requiredToolHits:0,toolArgumentHits:0,answerSignalCorrect:false,forbiddenClaimHits:0,duplicateFree:false,decisionSignature:'unstable'}})
  ];
  const metrics=calculateAutomaticMetrics(rows,config);
  assert.equal(metricById(metrics,'execution_completion_rate').value,1);
  assert.equal(metricById(metrics,'skill_precision').value,1);
  assert.equal(metricById(metrics,'skill_recall').value,0.5);
  assert.equal(metricById(metrics,'required_tool_recall').value,0.5);
  assert.equal(metricById(metrics,'tool_argument_accuracy').value,0.5);
  assert.equal(metricById(metrics,'answer_signal_accuracy').value,0.5);
  assert.equal(metricById(metrics,'forbidden_claim_avoidance').value,0.5);
  assert.equal(metricById(metrics,'non_menu_latency_p95_ms').value,300);
  assert.equal(metricById(metrics,'decision_stability_rate').status,'not_evaluated');
  assert.equal(metrics.some(item=>item.id==='weighted_total_score'),false);
});

test('稳定率只在同一样本至少运行三次后计算',()=>{
  const stable=[row({id:'same'}),row({id:'same'}),row({id:'same'})];
  const stableMetric=metricById(calculateAutomaticMetrics(stable,config),'decision_stability_rate');
  assert.equal(stableMetric.value,1);
  const unstable=[row({id:'same'}),row({id:'same'}),row({id:'same',signals:{decisionSignature:'changed'}})];
  assert.equal(metricById(calculateAutomaticMetrics(unstable,config),'decision_stability_rate').value,0);
});

test('大模型裁判评分计算覆盖率、平均分、低分率和一票否决数',()=>{
  const rows=[
    {...row({id:'p1'}),modelJudgement:{scores:{constraintCompliance:1,safetyCompliance:1,grounding:5,executability:5,personalization:4,clarity:4},criterionResults:[{pass:true}],hardViolations:[]}},
    {...row({id:'p2'}),modelJudgement:{scores:{constraintCompliance:1,safetyCompliance:0,grounding:3,executability:2,personalization:null,clarity:4},criterionResults:[{pass:false}],hardViolations:['allergy_conflict']}}
  ];
  const metrics=calculateJudgeMetrics(rows,config);
  assert.equal(metricById(metrics,'judge_coverage_rate').value,1);
  assert.equal(metricById(metrics,'judge_criteria_pass_rate').value,0.5);
  assert.equal(metricById(metrics,'grounding_mean').value,4);
  assert.equal(metricById(metrics,'executability_mean').value,3.5);
  assert.equal(metricById(metrics,'executability_below_3_rate').value,0.5);
  assert.equal(metricById(metrics,'personalization_mean').value,4);
  assert.equal(metricById(metrics,'hard_violation_count').value,1);
});

test('发布判定要求完整切片、自动硬门槛、大模型裁判和零严重违规同时通过',()=>{
  const rows=[row({id:'p1'})];
  const automatic=calculateAutomaticMetrics(rows,config);
  const slices=calculateSampleTypeMetrics(rows,config);
  const judge=calculateJudgeMetrics(rows,config);
  const decision=releaseDecision({rows,automaticMetrics:automatic,sampleTypeMetrics:slices,judgeMetrics:judge,config,totalDatasetCases:30});
  assert.equal(decision.status,'not_ready');
  assert.ok(decision.blockers.some(item=>item.includes('样本不完整')));
  assert.ok(decision.blockers.some(item=>item.includes('大模型裁判覆盖率')));
});

test('P95 使用 nearest-rank 口径',()=>{
  assert.equal(percentile([10,20,30,40,50,60,70,80,90,100],0.95),100);
  assert.equal(percentile([],0.95),null);
});
