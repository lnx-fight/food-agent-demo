function sum(values){return values.reduce((total,value)=>total+Number(value||0),0)}
function mean(values){return values.length?sum(values)/values.length:null}
function ratio(numerator,denominator,{emptyValue=null}={}){return denominator?numerator/denominator:emptyValue}
function percentile(values,quantile){
  if(!values.length)return null;
  const sorted=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  return sorted[Math.max(0,Math.ceil(quantile*sorted.length)-1)];
}
function meetsThreshold(value,definition){
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return null;
  return definition.direction==='lte'?Number(value)<=Number(definition.threshold):Number(value)>=Number(definition.threshold);
}
function metric(definition,value,details={}){
  const passed=meetsThreshold(value,definition);
  return {...definition,value,passed,status:passed===null?'not_evaluated':passed?'pass':'fail',...details};
}
function metricDefinition(config,id,kind='automaticMetrics'){
  const definition=(config[kind]||[]).find(item=>item.id===id);
  if(!definition)throw new Error(`缺少指标定义：${id}`);
  return definition;
}
function completedRows(rows){return rows.filter(row=>!row.error&&row.judgement?.signals)}

function calculateAutomaticMetrics(rows,config){
  const completed=completedRows(rows),signals=completed.map(row=>row.judgement.signals);
  const expectedPositive=signals.filter(item=>item.expectedSkill),expectedNegative=signals.filter(item=>!item.expectedSkill);
  const tp=expectedPositive.filter(item=>item.actualSkill).length;
  const fp=expectedNegative.filter(item=>item.actualSkill).length;
  const fn=expectedPositive.filter(item=>!item.actualSkill).length;
  const precision=ratio(tp,tp+fp),recall=ratio(tp,tp+fn),f1=precision===null||recall===null?null:(precision+recall?2*precision*recall/(precision+recall):0);
  const simple=completed.filter(row=>row.item.sampleType==='positive'&&row.item.expected.scenario!==null);
  const boundary=completed.filter(row=>row.item.sampleType==='boundary_ambiguous'&&row.item.expected.scenario!==null);
  const requiredHits=sum(signals.map(item=>item.requiredToolHits)),requiredTotal=sum(signals.map(item=>item.requiredToolTotal));
  const allowedCalls=sum(signals.map(item=>item.allowedToolCalls)),toolCalls=sum(signals.map(item=>item.toolCallTotal));
  const argumentHits=sum(signals.map(item=>item.toolArgumentHits)),argumentTotal=sum(signals.map(item=>item.toolArgumentTotal));
  const answerSignals=signals.filter(item=>item.answerSignalApplicable);
  const forbiddenHits=sum(signals.map(item=>item.forbiddenClaimHits)),forbiddenTotal=sum(signals.map(item=>item.forbiddenClaimTotal));
  const exceptionRows=rows.filter(row=>row.item.sampleType==='exception'),adversarialRows=rows.filter(row=>row.item.sampleType==='adversarial');
  const minimumStabilityRuns=Number(config.releasePolicy?.minimumRunsForStability)||3,byCase=new Map();
  for(const row of rows){if(!byCase.has(row.item.id))byCase.set(row.item.id,[]);byCase.get(row.item.id).push(row)}
  const repeated=[...byCase.values()].filter(group=>group.length>=minimumStabilityRuns);
  const stable=repeated.filter(group=>group.every(row=>!row.error&&row.judgement?.signals)&&new Set(group.map(row=>row.judgement.signals.decisionSignature)).size===1);
  const nonMenu=completed.filter(row=>row.item.expected.scenario!=='restaurants');
  const values={
    execution_completion_rate:ratio(completed.length,rows.length),
    automated_case_pass_rate:ratio(rows.filter(row=>!row.error&&row.judgement?.passed).length,rows.length),
    skill_precision:precision,
    skill_recall:recall,
    skill_f1:f1,
    intent_accuracy:ratio(signals.filter(item=>item.intentCorrect).length,signals.length),
    simple_scenario_accuracy:ratio(simple.filter(row=>row.judgement.signals.scenarioCorrect).length,simple.length),
    boundary_scenario_accuracy:ratio(boundary.filter(row=>row.judgement.signals.scenarioCorrect).length,boundary.length),
    required_tool_recall:ratio(requiredHits,requiredTotal),
    allowed_tool_precision:ratio(allowedCalls,toolCalls,{emptyValue:1}),
    tool_argument_accuracy:ratio(argumentHits,argumentTotal),
    action_accuracy:ratio(signals.filter(item=>item.actionCorrect).length,signals.length),
    proposal_accuracy:ratio(signals.filter(item=>item.proposalCorrect).length,signals.length),
    answer_signal_accuracy:ratio(answerSignals.filter(item=>item.answerSignalCorrect).length,answerSignals.length),
    forbidden_claim_avoidance:ratio(forbiddenHits,forbiddenTotal),
    duplicate_free_tool_rate:ratio(signals.filter(item=>item.duplicateFree).length,signals.length),
    exception_pass_rate:ratio(exceptionRows.filter(row=>!row.error&&row.judgement?.passed).length,exceptionRows.length),
    adversarial_pass_rate:ratio(adversarialRows.filter(row=>!row.error&&row.judgement?.passed).length,adversarialRows.length),
    decision_stability_rate:ratio(stable.length,repeated.length),
    non_menu_latency_p95_ms:percentile(nonMenu.map(row=>row.ms),0.95)
  };
  const metricDetails={
    execution_completion_rate:{numerator:completed.length,denominator:rows.length},
    automated_case_pass_rate:{numerator:rows.filter(row=>!row.error&&row.judgement?.passed).length,denominator:rows.length},
    skill_precision:{tp,fp,fn},skill_recall:{tp,fp,fn},skill_f1:{tp,fp,fn},
    intent_accuracy:{numerator:signals.filter(item=>item.intentCorrect).length,denominator:signals.length},
    simple_scenario_accuracy:{numerator:simple.filter(row=>row.judgement.signals.scenarioCorrect).length,denominator:simple.length},
    boundary_scenario_accuracy:{numerator:boundary.filter(row=>row.judgement.signals.scenarioCorrect).length,denominator:boundary.length},
    required_tool_recall:{numerator:requiredHits,denominator:requiredTotal},
    allowed_tool_precision:{numerator:allowedCalls,denominator:toolCalls},
    tool_argument_accuracy:{numerator:argumentHits,denominator:argumentTotal},
    action_accuracy:{numerator:signals.filter(item=>item.actionCorrect).length,denominator:signals.length},
    proposal_accuracy:{numerator:signals.filter(item=>item.proposalCorrect).length,denominator:signals.length},
    answer_signal_accuracy:{numerator:answerSignals.filter(item=>item.answerSignalCorrect).length,denominator:answerSignals.length},
    forbidden_claim_avoidance:{numerator:forbiddenHits,denominator:forbiddenTotal},
    duplicate_free_tool_rate:{numerator:signals.filter(item=>item.duplicateFree).length,denominator:signals.length},
    exception_pass_rate:{numerator:exceptionRows.filter(row=>!row.error&&row.judgement?.passed).length,denominator:exceptionRows.length},
    adversarial_pass_rate:{numerator:adversarialRows.filter(row=>!row.error&&row.judgement?.passed).length,denominator:adversarialRows.length},
    decision_stability_rate:{numerator:stable.length,denominator:repeated.length,minimumRuns:minimumStabilityRuns},
    non_menu_latency_p95_ms:{sampleCount:nonMenu.length}
  };
  return config.automaticMetrics.map(definition=>metric(definition,values[definition.id],metricDetails[definition.id]||{}));
}

function calculateSampleTypeMetrics(rows,config){
  return (config.sampleTypeGates||[]).map(gate=>{
    const group=rows.filter(row=>row.item.sampleType===gate.sampleType),passed=group.filter(row=>!row.error&&row.judgement?.passed).length,value=ratio(passed,group.length);
    const definition={id:`sample_type_${gate.sampleType}_pass_rate`,name:`${gate.sampleType} 样本通过率`,format:'percentage',direction:'gte',threshold:gate.threshold,hardGate:true,definition:`${gate.sampleType} 中自动断言全部通过的运行数 / 该类型运行数`};
    return metric(definition,value,{numerator:passed,denominator:group.length,sampleType:gate.sampleType});
  });
}

function calculateJudgeMetrics(rows,config){
  const definitions=config.judgeMetrics||[],judged=rows.filter(row=>row.modelJudgement);
  const scoreValues=field=>judged.map(row=>row.modelJudgement.scores?.[field]).filter(value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))).map(Number);
  const constraint=scoreValues('constraintCompliance'),safety=scoreValues('safetyCompliance'),grounding=scoreValues('grounding'),executability=scoreValues('executability'),personalization=scoreValues('personalization'),clarity=scoreValues('clarity');
  const criterionResults=judged.flatMap(row=>Array.isArray(row.modelJudgement.criterionResults)?row.modelJudgement.criterionResults:[]);
  const values={
    judge_coverage_rate:ratio(judged.length,rows.length),
    judge_constraint_compliance_rate:mean(constraint),
    judge_safety_compliance_rate:mean(safety),
    judge_criteria_pass_rate:ratio(criterionResults.filter(item=>item.pass===true).length,criterionResults.length),
    grounding_mean:mean(grounding),
    executability_mean:mean(executability),
    executability_below_3_rate:ratio(executability.filter(value=>value<3).length,executability.length),
    personalization_mean:mean(personalization),
    clarity_mean:mean(clarity),
    hard_violation_count:sum(judged.map(row=>Array.isArray(row.modelJudgement.hardViolations)?row.modelJudgement.hardViolations.length:0))
  };
  return definitions.map(definition=>metric(definition,values[definition.id],{
    judgedRuns:judged.length,
    totalRuns:rows.length,
    ...(definition.id==='judge_criteria_pass_rate'?{numerator:criterionResults.filter(item=>item.pass===true).length,denominator:criterionResults.length}:{})
  }));
}

function releaseDecision({rows,automaticMetrics,sampleTypeMetrics,judgeMetrics,config,totalDatasetCases}){
  const blockers=[],policy=config.releasePolicy||{},uniqueCases=new Set(rows.map(row=>row.item.id)),presentTypes=new Set(rows.map(row=>row.item.sampleType));
  if(uniqueCases.size<Number(policy.minimumCases||totalDatasetCases))blockers.push(`样本不完整：${uniqueCases.size}/${policy.minimumCases||totalDatasetCases}`);
  for(const type of policy.requiredSampleTypes||[])if(!presentTypes.has(type))blockers.push(`缺少样本类型：${type}`);
  const runsByCase=new Map();for(const row of rows)runsByCase.set(row.item.id,(runsByCase.get(row.item.id)||0)+1);
  if([...runsByCase.values()].some(count=>count<Number(policy.minimumRunsPerCase||1)))blockers.push('存在运行次数不足的样本');
  for(const item of [...automaticMetrics,...sampleTypeMetrics,...judgeMetrics].filter(item=>item.hardGate)){
    if(item.status==='not_evaluated')blockers.push(`${item.name} 未评测`);
    else if(item.status==='fail')blockers.push(`${item.name} 未达门槛`);
  }
  return {status:blockers.length?'not_ready':'pass',blockers:[...new Set(blockers)]};
}

function formatMetricValue(item){
  if(item.value===null||item.value===undefined)return '-';
  if(item.format==='percentage')return `${(Number(item.value)*100).toFixed(1)}%`;
  if(item.format==='milliseconds')return `${Math.round(Number(item.value))}ms`;
  if(item.format==='score_5')return `${Number(item.value).toFixed(2)}/5`;
  return String(Number(item.value).toFixed(Number.isInteger(Number(item.value))?0:2));
}

export {calculateAutomaticMetrics,calculateSampleTypeMetrics,calculateJudgeMetrics,releaseDecision,formatMetricValue,percentile,meetsThreshold};
