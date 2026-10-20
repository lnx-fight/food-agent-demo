import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-device-'));
process.env.DASHSCOPE_API_KEY='';
const {server,createAgentTask,upsertUser,embedPendingMemories}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()});
async function call(path,{method,body,cookie,headers={}}={}){
 const response=await fetch(base+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan',...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
 return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
let alice,bob,aliceId,bobId;
test('免账号使用的浏览器数据完整生命周期',async t=>{
 await t.test('浏览不创建身份，业务仍按浏览器隔离，不能通过clientId认领历史',async()=>{
  await upsertUser('legacy-person',{profile:{name:'private legacy',age:30},mealLogs:[],weightLogs:[]});
  for(const path of ['/api/user/state?clientId=legacy-person','/api/agent/logs','/api/agent/events','/api/nutrition/search?q=鸡蛋','/api/device/export'])assert.equal((await call(path)).status,401,path);
  assert.equal((await call('/api/health')).status,200);assert.equal((await call('/api/device/session')).data.device,null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n,0);
 });
 await t.test('无需用户名密码创建独立会话，仅服务端保存凭证哈希',async()=>{
  const a=await call('/api/device/session',{body:{}});assert.equal(a.status,201);alice=a.cookie;aliceId=a.data.device.id;
  assert.match(a.headers.get('set-cookie'),/HttpOnly/);assert.match(a.headers.get('set-cookie'),/SameSite=Strict/);assert.match(a.headers.get('set-cookie'),/Max-Age=15552000/);
  assert.equal(a.data.device.mode,'device');assert.equal(a.data.device.username,undefined);
  assert.equal(db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(aliceId).password_hash,'device:disabled');
  assert.ok(!db.prepare('SELECT token_hash FROM account_sessions WHERE account_id=?').get(aliceId).token_hash.includes(alice.split('=')[1]));
  const b=await call('/api/device/session',{body:{}});assert.equal(b.status,201);bob=b.cookie;bobId=b.data.device.id;assert.notEqual(bobId,aliceId);
  const renewed=await call('/api/device/session',{cookie:alice,body:{username:'bob',clientId:'legacy-person'}});assert.equal(renewed.status,200);assert.equal(renewed.data.device.id,aliceId);assert.equal(renewed.cookie,alice);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n,2);
 });
 await t.test('拒绝跨站写入和缺少自定义请求头的写入',async()=>{
  for(const headers of [{'X-Requested-With':''},{Origin:'https://attacker.example'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}]){
   const result=await call('/api/device/session',{cookie:alice,body:{},headers});assert.ok([403,415].includes(result.status));
  }
  assert.equal((await call('/api/device/session',{cookie:alice})).data.device.id,aliceId);
 });
 await t.test('身份与数据隔离、乐观锁阻止旧标签页覆盖',async()=>{
  const data={clientId:'legacy-person',profile:{name:'Alice',age:30,weight:60,height:165,targetWeight:58,targetDate:'2027-01-01'},mealLogs:[{date:'2026-10-15',type:'午餐',name:'鸡蛋',calories:140,protein:12}],weightLogs:[{date:'2026-10-15',weight:60}],chatHistory:[{role:'user',content:'private meal'}]};
  const saved=await call('/api/user/state',{cookie:alice,method:'PUT',headers:{'X-State-Version':'0'},body:data});assert.equal(saved.status,200);assert.equal(saved.data.stateVersion,1);assert.notEqual(saved.data.state.clientId,'legacy-person');
  const own=await call('/api/user/state?clientId=legacy-person',{cookie:alice});assert.equal(own.data.state.profile.name,'Alice');
  assert.equal((await call('/api/user/state?clientId='+own.data.state.clientId,{cookie:bob})).data.state,null);
  for(const headers of [{},{'X-State-Version':'0'}])assert.equal((await call('/api/user/state',{cookie:alice,method:'PUT',headers,body:{profile:{name:'stale'}}})).status,409);
  assert.equal((await call('/api/user/state',{cookie:alice})).data.state.profile.name,'Alice');
  assert.ok(db.prepare('SELECT profile FROM users WHERE client_id=?').get('legacy-person').profile.includes('private legacy'));
 });
 await t.test('待办不能通过猜测ID修改其他浏览器的数据',async()=>{
  const client=db.prepare('SELECT client_id FROM accounts WHERE id=?').get(aliceId).client_id;
  const task=await createAgentTask(client,'test-private','2026-10-15',{text:'private task'}),id=task.id||db.prepare('SELECT id FROM agent_tasks ORDER BY id DESC LIMIT 1').get().id;
  for(const action of ['complete','accept','dismiss','snooze']){
   const result=await call('/api/agent/tasks/'+action,{cookie:bob,body:{id,clientId:client}});
   if(action==='complete')assert.equal(result.data.result.ok,false);else assert.equal(result.status,404);
   assert.equal(db.prepare('SELECT status FROM agent_tasks WHERE id=?').get(id).status,'pending');
  }
 });
 await t.test('导出只含当前浏览器的数据，不含凭证或其他人的数据',async()=>{
  const result=await call('/api/device/export',{cookie:alice});assert.equal(result.status,200);assert.equal(result.data.state.profile.name,'Alice');assert.equal(result.data.account.mode,'device');
  assert.doesNotMatch(JSON.stringify(result.data),/password_hash|token_hash|private legacy|device:disabled/);assert.match(result.headers.get('content-disposition'),/attachment/);assert.match(result.headers.get('cache-control'),/no-store/);
 });
 await t.test('清空需要确认文字，清除派生数据并撤销旧会话，晚到请求不复活数据',async()=>{
  const client=db.prepare('SELECT client_id FROM accounts WHERE id=?').get(aliceId).client_id,user=db.prepare('SELECT id FROM users WHERE client_id=?').get(client);
  const memory=db.prepare("INSERT INTO agent_memory(user_id,kind,date,payload,created_at) VALUES(?,'test','2026-10-15','{}','now')").run(user.id).lastInsertRowid;
  db.prepare("INSERT INTO memory_embeddings(memory_id,embedding) VALUES(?,'[]')").run(memory);
  const goal=db.prepare("INSERT INTO agent_goals(user_id,client_id,objective) VALUES(?,?,'private')").run(user.id,client).lastInsertRowid;
  db.prepare("INSERT INTO agent_goal_steps(goal_id,step_no,tool) VALUES(?,1,'test')").run(goal);db.prepare("INSERT INTO agent_logs(client_id,kind,detail) VALUES(?,'test','private')").run(client);
  assert.equal((await call('/api/device/clear',{cookie:alice,body:{confirmation:'delete'}})).status,400);
  db.prepare("INSERT INTO agent_memory(user_id,kind,date,payload,created_at) VALUES(?,'pending','2026-10-15','{}','pending-time')").run(user.id);
  const originalFetch=globalThis.fetch;let finishEmbedding;process.env.DASHSCOPE_API_KEY='test-fixture';
  globalThis.fetch=(url,options)=>String(url).endsWith('/embeddings')?new Promise(resolve=>{finishEmbedding=()=>resolve({ok:true,json:async()=>({data:[{embedding:[1,2]}]})})}):originalFetch(url,options);
  try{
   const job=embedPendingMemories(client);await new Promise(resolve=>setImmediate(resolve));
   const old=alice,cleared=await call('/api/device/clear',{cookie:alice,body:{confirmation:'清空数据'}});assert.equal(cleared.status,200);alice=cleared.cookie;
   finishEmbedding();await job;
   assert.equal((await call('/api/device/export',{cookie:old})).status,401);
  }finally{globalThis.fetch=originalFetch;process.env.DASHSCOPE_API_KEY=''}
  const result=await call('/api/user/state',{cookie:alice});assert.equal(result.data.state,null);assert.equal(result.data.stateVersion,2);
  for(const table of ['memory_embeddings','agent_goal_steps','agent_goals','meal_logs','weight_logs','agent_memory','agent_tasks','agent_logs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE client_id=?').get('legacy-person').n,1);
  assert.equal((await call('/api/user/state',{cookie:alice,method:'PUT',headers:{'X-State-Version':'1'},body:{profile:{name:'resurrect'}}})).status,409);
 });
 await t.test('删除只影响当前使用空间，过期或伪造凭证不能读取历史记录',async()=>{
  assert.equal((await call('/api/device/delete',{cookie:alice,body:{confirmation:'wrong'}})).status,400);
  const deleted=await call('/api/device/delete',{cookie:alice,body:{confirmation:'删除全部数据'}});assert.equal(deleted.status,200);assert.equal(db.prepare('SELECT id FROM accounts WHERE id=?').get(aliceId),undefined);
  assert.equal((await call('/api/device/export',{cookie:alice})).status,401);assert.equal((await call('/api/device/session',{cookie:bob})).data.device.id,bobId);
  db.prepare('UPDATE account_sessions SET expires_at=0 WHERE account_id=?').run(bobId);
  assert.equal((await call('/api/device/export',{cookie:bob})).status,401);
  const fresh=await call('/api/device/session',{cookie:bob,body:{id:bobId}});assert.equal(fresh.status,201);assert.notEqual(fresh.data.device.id,bobId);assert.equal((await call('/api/user/state',{cookie:fresh.cookie})).data.state,null);
  assert.equal((await call('/api/user/state',{cookie:'xiaofan_session='+'a'.repeat(64)})).status,401);
 });
 await t.test('生产Cookie强制Secure，创建限流只影响新空间不阻止现有会话',async()=>{
  process.env.NODE_ENV='production';const fresh=await call('/api/device/session',{body:{}});assert.equal(fresh.status,201);assert.match(fresh.headers.get('set-cookie'),/; Secure/);process.env.NODE_ENV='test';
  db.prepare('UPDATE auth_attempts SET count=100').run();assert.equal((await call('/api/device/session',{body:{}})).status,429);
  assert.equal((await call('/api/device/session',{cookie:fresh.cookie,body:{}})).status,200);
 });
});
