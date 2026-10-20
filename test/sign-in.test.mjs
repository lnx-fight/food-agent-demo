import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'xiaofan-login-removal-'));
const {server,upsertUser}=await import('../server.mjs');
const db=new DatabaseSync(join(process.env.DATA_DIR,'nutrition.sqlite'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close()});
async function call(path,body,cookie){
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Xiaofan',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
test('移除账号密码接口，旧记录不删除且无法凭用户名或clientId认领',async()=>{
 db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run('previous-owner','previous_user','previous-password-hash','previous-client',3,'2026-10-19');
 await upsertUser('previous-client',{profile:{age:30,name:'旧档案'},mealLogs:[{date:'2026-10-19',type:'午餐',name:'历史米饭',calories:130,protein:2.69}],weightLogs:[]});
 for(const path of ['/api/auth/login','/api/auth/register','/api/auth/logout','/api/auth/logout-all','/api/account/password'])assert.equal((await call(path,{username:'previous_user',password:'previous passphrase'})).status,410,path);
 assert.equal((await call('/api/auth/session')).status,410);
 const started=await call('/api/device/session',{username:'previous_user',clientId:'previous-client'});assert.equal(started.status,201);assert.notEqual(started.data.device.id,'previous-owner');
 assert.equal((await call('/api/user/state?clientId=previous-client',undefined,started.cookie)).data.state,null);
 assert.equal(db.prepare('SELECT password_hash FROM accounts WHERE id=?').get('previous-owner').password_hash,'previous-password-hash');
 assert.equal(db.prepare('SELECT calories FROM meal_logs WHERE user_id=(SELECT id FROM users WHERE client_id=?)').get('previous-client').calories,130);
});
test('已有有效Cookie延续原档案，无需再次登录，不替换身份或重算记录',async()=>{
 const token=randomBytes(32).toString('hex'),cookie='xiaofan_session='+token;
 db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),'previous-owner',Date.now(),Date.now()+60000);
 const before=await call('/api/device/session',undefined,cookie);assert.equal(before.data.device.id,'previous-owner');assert.equal(before.data.device.username,undefined);
 const started=await call('/api/device/session',{},cookie);assert.equal(started.status,200);assert.equal(started.cookie,cookie);assert.equal(started.data.device.id,'previous-owner');
 const state=await call('/api/user/state',undefined,cookie);assert.equal(state.data.state.profile.name,'旧档案');assert.equal(state.data.stateVersion,3);assert.equal(state.data.state.mealLogs[0].calories,130);
});
