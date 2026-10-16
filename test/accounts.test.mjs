import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-accounts-'));
process.env.DASHSCOPE_API_KEY='';
const {server,createAgentTask,upsertUser,embedPendingMemories}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,password='a secure test passphrase';
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()});
async function call(path,{method,body,cookie,headers={}}={}){
  const response=await fetch(base+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan',...(cookie?{Cookie:cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
let alice,bob,aliceId,bobId;
test('完整账号与数据生命周期',async t=>{
  await t.test('所有产品接口都要求登录，旧clientId不能恢复个人数据',async()=>{
    (await upsertUser('legacy-person',{profile:{name:'private legacy',age:30},mealLogs:[],weightLogs:[]}));
    for(const path of ['/api/user/state?clientId=legacy-person','/api/agent/logs','/api/agent/events','/api/nutrition/search?q=鸡蛋','/api/account/export'])assert.equal((await call(path)).status,401,path);
    assert.equal((await call('/api/health')).status,200);
    assert.equal((await call('/api/auth/session')).data.account,null);
  });
  await t.test('注册校验、密码哈希和HttpOnly会话',async()=>{
    assert.equal((await call('/api/auth/register',{body:{username:'invalid user',password}})).status,400);
    assert.equal((await call('/api/auth/register',{body:{username:'short',password:'123'}})).status,400);
    const a=await call('/api/auth/register',{body:{username:'alice',password}});assert.equal(a.status,201);alice=a.cookie;aliceId=a.data.account.id;
    assert.match(a.headers.get('set-cookie'),/HttpOnly/);assert.match(a.headers.get('set-cookie'),/SameSite=Strict/);
    assert.doesNotMatch(a.data.account.id,/alice/);
    const row=db.prepare('SELECT * FROM accounts WHERE id=?').get(aliceId);assert.notEqual(row.password_hash,password);assert.equal(row.password_hash.includes(password),false);
    const token=alice.split('=')[1];assert.equal(db.prepare('SELECT token_hash FROM account_sessions WHERE account_id=?').get(aliceId).token_hash.includes(token),false);
    const b=await call('/api/auth/register',{body:{username:'bob',password}});assert.equal(b.status,201);bob=b.cookie;bobId=b.data.account.id;
    assert.equal((await call('/api/auth/register',{body:{username:'ALICE',password}})).status,409);
  });
  await t.test('拒绝跨站写入和缺少自定义请求头的写入',async()=>{
    for(const headers of [{'X-Requested-With':''},{Origin:'https://attacker.example'},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}]){
      const result=await call('/api/auth/logout',{cookie:alice,body:{},headers});assert.ok([403,415].includes(result.status));
    }
    assert.equal((await call('/api/auth/session',{cookie:alice})).data.account.username,'alice');
  });
  await t.test('服务端绑定身份、数据隔离和乐观锁阻止旧设备覆盖',async()=>{
    const data={clientId:'legacy-person',profile:{name:'Alice',age:30,weight:60,height:165,targetWeight:58,targetDate:'2027-01-01'},mealLogs:[{date:'2026-10-15',type:'午餐',name:'鸡蛋',calories:140,protein:12}],weightLogs:[{date:'2026-10-15',weight:60}],chatHistory:[{role:'user',content:'private meal'}]};
    const saved=await call('/api/user/state',{cookie:alice,method:'PUT',headers:{'X-State-Version':'0'},body:data});assert.equal(saved.status,200);assert.equal(saved.data.stateVersion,1);
    assert.notEqual(saved.data.state.clientId,'legacy-person');
    const own=await call('/api/user/state?clientId=legacy-person',{cookie:alice});assert.equal(own.data.state.profile.name,'Alice');
    const other=await call('/api/user/state?clientId='+own.data.state.clientId,{cookie:bob});assert.equal(other.data.state,null);
    assert.equal((await call('/api/user/state',{cookie:alice,method:'PUT',headers:{'X-State-Version':'0'},body:{profile:{name:'stale'}}})).status,409);
    assert.equal((await call('/api/user/state',{cookie:alice,method:'PUT',body:data})).status,409);
    assert.equal((await call('/api/user/state',{cookie:alice})).data.state.profile.name,'Alice');
    assert.equal(db.prepare('SELECT profile FROM users WHERE client_id=?').get('legacy-person').profile.includes('private legacy'),true);
  });
  await t.test('待办操作不能通过猜测ID修改其他账号的数据',async()=>{
    const client=db.prepare('SELECT client_id FROM accounts WHERE id=?').get(aliceId).client_id;
    const task=(await createAgentTask(client,'test-private','2026-10-15',{text:'private task'}));
    const id=task.id||db.prepare('SELECT id FROM agent_tasks ORDER BY id DESC LIMIT 1').get().id;
    for(const action of ['complete','accept','dismiss','snooze']){
      const result=await call('/api/agent/tasks/'+action,{cookie:bob,body:{id,clientId:client}});
      if(action==='complete')assert.equal(result.data.result.ok,false);else assert.equal(result.status,404);
      assert.equal(db.prepare('SELECT status FROM agent_tasks WHERE id=?').get(id).status,'pending');
    }
  });
  await t.test('导出只含本账号数据，不包含密码、会话或其他用户',async()=>{
    const result=await call('/api/account/export',{cookie:alice});assert.equal(result.status,200);assert.equal(result.data.state.profile.name,'Alice');assert.equal(result.data.account.username,'alice');
    const raw=JSON.stringify(result.data);assert.doesNotMatch(raw,/password_hash|token_hash|private legacy/);assert.equal(raw.includes(password),false);
    assert.match(result.headers.get('content-disposition'),/attachment/);assert.match(result.headers.get('cache-control'),/no-store/);
  });
  await t.test('登录错误、过期会话及退出当前设备',async()=>{
    assert.equal((await call('/api/auth/login',{body:{username:'alice',password:'wrong but long password'}})).status,401);
    const login=await call('/api/auth/login',{body:{username:'alice',password}});assert.equal(login.status,200);
    assert.equal((await call('/api/auth/logout',{cookie:login.cookie,body:{}})).status,200);
    assert.equal((await call('/api/account/export',{cookie:login.cookie})).status,401);
    const expired=await call('/api/auth/login',{body:{username:'bob',password}});
    db.prepare('UPDATE account_sessions SET expires_at=0 WHERE token_hash=(SELECT token_hash FROM account_sessions WHERE account_id=? ORDER BY created_at DESC LIMIT 1)').run(bobId);
    assert.equal((await call('/api/account/export',{cookie:expired.cookie})).status,401);
  });
  await t.test('修改密码需要当前密码，修改后其他会话失效',async()=>{
    const second=await call('/api/auth/login',{body:{username:'alice',password}});
    assert.equal((await call('/api/account/password',{cookie:alice,body:{password:'incorrect',newPassword:'new secure passphrase'}})).status,403);
    const changed=await call('/api/account/password',{cookie:alice,body:{password,newPassword:'new secure passphrase'}});assert.equal(changed.status,200);alice=changed.cookie;
    assert.equal((await call('/api/account/export',{cookie:second.cookie})).status,401);
    assert.equal((await call('/api/auth/login',{body:{username:'alice',password}})).status,401);
    assert.equal((await call('/api/auth/login',{body:{username:'alice',password:'new secure passphrase'}})).status,200);
  });
  await t.test('清空要求密码和确认文字，并清理派生记录、撤销旧会话',async()=>{
    const client=db.prepare('SELECT client_id FROM accounts WHERE id=?').get(aliceId).client_id,user=db.prepare('SELECT id FROM users WHERE client_id=?').get(client);
    const memory=db.prepare("INSERT INTO agent_memory(user_id,kind,date,payload,created_at) VALUES(?,'test','2026-10-15','{}','now')").run(user.id).lastInsertRowid;
    db.prepare("INSERT INTO memory_embeddings(memory_id,embedding) VALUES(?,'[]')").run(memory);
    const goal=db.prepare("INSERT INTO agent_goals(user_id,client_id,objective) VALUES(?,?,'private')").run(user.id,client).lastInsertRowid;
    db.prepare("INSERT INTO agent_goal_steps(goal_id,step_no,tool) VALUES(?,1,'test')").run(goal);
    db.prepare("INSERT INTO agent_logs(client_id,kind,detail) VALUES(?,'test','private')").run(client);
    assert.equal((await call('/api/account/clear',{cookie:alice,body:{password:'new secure passphrase',confirmation:'delete'}})).status,400);
    // 模拟注销前已经开始、注销后才返回的后台嵌入请求。
    db.prepare("INSERT INTO agent_memory(user_id,kind,date,payload,created_at) VALUES(?,'pending','2026-10-15','{}','pending-time')").run(user.id);
    const originalFetch=globalThis.fetch;let finishEmbedding;
    process.env.DASHSCOPE_API_KEY='test-fixture';
    globalThis.fetch=(url,options)=>String(url).endsWith('/embeddings')?new Promise(resolve=>{finishEmbedding=()=>resolve({ok:true,json:async()=>({data:[{embedding:[1,2]}]})})}):originalFetch(url,options);
    const embeddingJob=embedPendingMemories(client);await new Promise(resolve=>setImmediate(resolve));
    const old=alice,cleared=await call('/api/account/clear',{cookie:alice,body:{password:'new secure passphrase',confirmation:'清空数据'}});assert.equal(cleared.status,200);alice=cleared.cookie;
    finishEmbedding();await embeddingJob;globalThis.fetch=originalFetch;process.env.DASHSCOPE_API_KEY='';
    assert.equal((await call('/api/account/export',{cookie:old})).status,401);
    const result=await call('/api/user/state',{cookie:alice});assert.equal(result.data.state,null);assert.equal(result.data.stateVersion,2);
    for(const table of ['memory_embeddings','agent_goal_steps','agent_goals','meal_logs','weight_logs','agent_memory','agent_tasks','agent_logs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE client_id=?').get('legacy-person').n,1);
    assert.equal((await call('/api/user/state',{cookie:alice,method:'PUT',headers:{'X-State-Version':'1'},body:{profile:{name:'resurrect'}}})).status,409);
  });
  await t.test('注销只删除当前账号，退出全部设备使会话立即失效',async()=>{
    const deleted=await call('/api/account/delete',{cookie:alice,body:{password:'new secure passphrase',confirmation:'注销账号'}});assert.equal(deleted.status,200);
    assert.equal(db.prepare('SELECT id FROM accounts WHERE id=?').get(aliceId),undefined);
    assert.equal((await call('/api/account/export',{cookie:alice})).status,401);
    const b=await call('/api/auth/login',{body:{username:'bob',password}});assert.equal(b.status,200);bob=b.cookie;
    assert.equal((await call('/api/auth/logout-all',{cookie:bob,body:{}})).status,200);
    assert.equal((await call('/api/account/export',{cookie:bob})).status,401);
  });
  await t.test('生产会话强制Secure，限流持久化阻止暴力尝试',async()=>{
    process.env.NODE_ENV='production';
    const login=await call('/api/auth/login',{body:{username:'bob',password}});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/; Secure/);process.env.NODE_ENV='test';
    db.prepare('UPDATE auth_attempts SET count=100').run();
    assert.equal((await call('/api/auth/login',{body:{username:'bob',password}})).status,429);
  });
});
