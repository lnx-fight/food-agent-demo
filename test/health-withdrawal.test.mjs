import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-withdraw-health-'));
process.env.DASHSCOPE_API_KEY='';
const {upsertUser,schedulerTick,pendingTasks}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
after(()=>db.close());
const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),state={profile:{age:30,weight:60,height:165,targetWeight:58,targetDate:'2026-12-31'},weightLogs:[{date,weight:60}],mealLogs:[{id:'original-meal',date,type:'早餐',name:'未吃',status:'skipped',calories:0,protein:0,carbs:null,fat:0}],weeklyPlan:{id:'original-week'}};

test('撤回健康页面和模块，原有导航、记餐与PWA资源仍完整',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/healthView|health-center|data-view="health"|name="carbs"/);
  for(const name of ['today','week','agent','trend','meals'])assert.match(html,new RegExp(`data-view="${name}"`));
  for(const file of ['health-core.js','health-import.js','health-center.js','health-center.css']){assert.equal(existsSync(new URL(`../${file}`,import.meta.url)),false);assert.equal(sw.includes(file),false);}
  for(const path of sw.matchAll(/'\.\/([^']+)'/g))assert.equal(existsSync(new URL(`../${path[1]}`,import.meta.url)),true,path[1]);
});
test('普通同步保留旧健康存档、餐食标识、未吃状态及原有计划',async ()=>{
  (await upsertUser('withdraw-test',state));
  const archive={version:1,records:[{kind:'sleep',date,hours:7.5}]},row=db.prepare('SELECT id,app_state FROM users WHERE client_id=?').get('withdraw-test'),appState=JSON.parse(row.app_state);
  db.prepare('UPDATE users SET app_state=? WHERE id=?').run(JSON.stringify({...appState,healthCoach:archive}),row.id);
  const result=(await upsertUser('withdraw-test',state)),saved=JSON.parse(db.prepare('SELECT app_state FROM users WHERE id=?').get(row.id).app_state);
  assert.deepEqual(saved.healthCoach,archive);assert.equal(result.healthCoach,undefined);assert.equal(result.mealLogs[0].id,'original-meal');assert.equal(result.mealLogs[0].status,'skipped');assert.equal(result.mealLogs[0].fat,0);assert.equal(result.mealLogs[0].carbs,null);assert.equal(result.weightLogs[0].weight,60);assert.equal(result.weeklyPlan.id,'original-week');
});
test('旧健康提醒停用并保留历史，原有提醒继续可见',async ()=>{
  const row=db.prepare('SELECT id FROM users WHERE client_id=?').get('withdraw-test');
  for(const kind of ['health_legacy','plan_lunch'])db.prepare("INSERT INTO agent_tasks(user_id,kind,due_date,status,payload,state) VALUES(?,?,?,'pending',?,'pending')").run(row.id,kind,date,JSON.stringify({text:'测试提醒'}));
  (await schedulerTick());assert.equal(db.prepare('SELECT status FROM agent_tasks WHERE user_id=? AND kind=?').get(row.id,'health_legacy').status,'cancelled');assert.deepEqual((await pendingTasks('withdraw-test',date)).map(task=>task.kind),['plan_lunch']);
});
test('历史健康对话继续从模型上下文隔离，专用健康接口已移除',()=>{
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8'),server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  assert.match(app,/historyForModel=agentConversation\.filter\(item=>item\.scope!=='health'\)/);assert.doesNotMatch(server,/\/api\/health-coach\/|healthResponse|dueHealthReminders/);
});
