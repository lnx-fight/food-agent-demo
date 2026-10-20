import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-sign-in-'));
const {server}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,password='first sign in passphrase';
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()});
async function call(path,{body,cookie}={}){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}

test('统一登录入口：首次自动创建，已有账号验密，始终要求有效会话',async t=>{
  let signedIn;
  await t.test('未登录不能访问产品数据，包括带demo参数的请求',async()=>{
    for(const path of ['/api/user/state','/api/user/state?demo','/api/nutrition/search?q=米饭&demo','/api/agent/logs'])assert.equal((await call(path)).status,401,path);
  });
  await t.test('没有注册也能首次登录并获得受保护会话',async()=>{
    signedIn=await call('/api/auth/login',{body:{username:'New_Person',password}});
    assert.equal(signedIn.status,201);assert.equal(signedIn.data.created,true);assert.equal(signedIn.data.account.username,'new_person');
    assert.match(signedIn.headers.get('set-cookie'),/HttpOnly/);assert.match(signedIn.headers.get('set-cookie'),/SameSite=Strict/);
    const row=db.prepare('SELECT * FROM accounts WHERE username=?').get('new_person');assert.ok(row);assert.notEqual(row.password_hash,password);assert.ok(!row.password_hash.includes(password));
    assert.equal((await call('/api/user/state',{cookie:signedIn.cookie})).status,200);
  });
  await t.test('已有用户名仍校验密码，不重复建号或覆盖原密码',async()=>{
    const before=db.prepare('SELECT * FROM accounts WHERE username=?').get('new_person');
    const wrong=await call('/api/auth/login',{body:{username:'new_person',password:'incorrect but long password'}});
    assert.equal(wrong.status,401);assert.equal(wrong.cookie,undefined);
    const correct=await call('/api/auth/login',{body:{username:'NEW_PERSON',password}});
    assert.equal(correct.status,200);assert.equal(correct.data.created,false);assert.equal(correct.data.account.id,before.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts WHERE username=?').get('new_person').n,1);
    assert.equal(db.prepare('SELECT password_hash FROM accounts WHERE username=?').get('new_person').password_hash,before.password_hash);
  });
  await t.test('并发首次登录同名不同密码，只接受创建成功的那一份密码',async()=>{
    const results=await Promise.all([password,password+' other'].map(value=>call('/api/auth/login',{body:{username:'same_name_race',password:value}})));
    assert.deepEqual(results.map(item=>item.status).sort(),[201,401]);
    const winner=results.find(item=>item.status===201),loser=results.find(item=>item.status===401);
    assert.equal(loser.cookie,undefined);assert.equal((await call('/api/auth/session',{cookie:winner.cookie})).data.account.id,winner.data.account.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts WHERE username=?').get('same_name_race').n,1);
  });
  await t.test('并发首次登录同名同密码复用一个账号',async()=>{
    const results=await Promise.all([1,2].map(()=>call('/api/auth/login',{body:{username:'same_password_race',password}})));
    assert.deepEqual(results.map(item=>item.status).sort(),[200,201]);assert.equal(results[0].data.account.id,results[1].data.account.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts WHERE username=?').get('same_password_race').n,1);
  });
  await t.test('无效凭据不创建账号，退出后不能继续访问产品',async()=>{
    const before=db.prepare('SELECT COUNT(*) n FROM accounts').get().n;
    for(const body of [{username:'bad name',password},{username:'short_password',password:'123'}])assert.equal((await call('/api/auth/login',{body})).status,400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n,before);
    assert.equal((await call('/api/auth/logout',{body:{},cookie:signedIn.cookie})).status,200);
    assert.equal((await call('/api/user/state',{cookie:signedIn.cookie})).status,401);
  });
});
