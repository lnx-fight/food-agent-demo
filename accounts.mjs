import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {env,isCloudflare} from './runtime.mjs';
import {atomic,accountGuard,clearGuard} from './database.mjs';

// Keep the existing tables and cookie so valid pre-change sessions retain their data.
// New visitors receive an isolated browser identity, with no username or password.
const SESSION_MS=180*86400000,COOKIE='xiaofan_session';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});

export function createAccounts({db,json,readBody,getState,saveState,closeEvents=()=>{}}){
  if(!isCloudflare)db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,client_id TEXT UNIQUE NOT NULL,state_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS account_session_owner ON account_sessions(account_id);
    CREATE TABLE IF NOT EXISTS write_guards(ok INTEGER NOT NULL CHECK(ok=1));
    CREATE TABLE IF NOT EXISTS auth_attempts(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
  const active=new Map();
  const account=async id=>(await db.prepare('SELECT * FROM accounts WHERE id=?').get(id));
  async function session(req){
    const match=String(req.headers.cookie||'').match(/(?:^|;\s*)xiaofan_session=([a-f0-9]{64})(?:;|$)/);
    if(!match)return null;
    return (await db.prepare('SELECT a.*,s.token_hash,s.expires_at FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(match[1]),Date.now()))||null;
  }
  const secure=()=>env.NODE_ENV==='production'||env.COOKIE_SECURE==='true';
  function cookie(res,value,maxAge){res.setHeader('Set-Cookie',`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure()?'; Secure':''}`)}
  async function issue(res,id){
    const token=randomBytes(32).toString('hex'),now=Date.now();
    (await db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(now));
    (await db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(hash(token),id,now,now+SESSION_MS));
    cookie(res,token,SESSION_MS/1000);
  }
  const publicAccount=row=>({id:row.id,mode:'device',createdAt:row.created_at});
  function checkWrite(req){
    if(['GET','HEAD'].includes(req.method))return;
    const scheme=secure()?'https':'http',origin=env.PUBLIC_ORIGIN||`${scheme}://${req.headers.host}`;
    if(req.headers['x-requested-with']!=='Xiaofan'||(req.headers.origin&&req.headers.origin!==origin)||['cross-site','same-site'].includes(req.headers['sec-fetch-site']))throw fail(403,'请求来源校验失败，请从本站页面操作');
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail(415,'请使用 JSON 请求');
  }
  async function rate(req){
    const now=Date.now();(await db.prepare('DELETE FROM auth_attempts WHERE expires_at<=?').run(now));
    // 只在显式启用可信反向代理时读取代理提供的地址。
    const remote=isCloudflare?String(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'unknown'):env.TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',').at(-1).trim():req.socket.remoteAddress||'unknown';
    for(const [scope,key,limit] of [['device',remote,30]]){
      const bucket=hash(`${scope}:${key}`),entry=await db.prepare('INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').get(bucket,now+15*60000);
      if(entry.count>limit)throw fail(429,'尝试次数过多，请15分钟后重试');
    }
  }
  function purgeStatements(clientId){
    const uid='(SELECT id FROM users WHERE client_id=?)',statements=[];
    statements.push([`DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM agent_memory WHERE user_id=${uid})`,[clientId]]);
    statements.push([`DELETE FROM skill_embeddings WHERE skill_id IN (SELECT id FROM skills WHERE user_id=${uid})`,[clientId]]);
    statements.push([`DELETE FROM agent_goal_steps WHERE goal_id IN (SELECT id FROM agent_goals WHERE user_id=${uid})`,[clientId]]);
    for(const table of ['meal_logs','weight_logs','agent_memory','agent_tasks','goals','skills','agent_goals'])statements.push([`DELETE FROM ${table} WHERE user_id=${uid}`,[clientId]]);
    statements.push(['DELETE FROM users WHERE client_id=?',[clientId]],['DELETE FROM agent_logs WHERE client_id=?',[clientId]]);
    return statements;
  }
  async function guardedWrite(row,statements){
    try{return await atomic(db,[accountGuard(row,{session:true}),...statements,clearGuard])}
    catch(error){if(/write_guards|CHECK constraint/.test(error.message))throw fail(409,'设备会话状态已改变，请刷新页面后重试');throw error}
  }
  async function exportData(row){
    const user=(await db.prepare('SELECT id,app_state FROM users WHERE client_id=?').get(row.client_id)),result={format:'xiaofan-device-export',version:1,exportedAt:new Date().toISOString(),account:publicAccount(row),state:(await getState(row.client_id)),records:{}};
    if(user){
      for(const table of ['agent_memory','agent_tasks','goals','skills','agent_goals'])result.records[table]=(await db.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(user.id));
      result.records.agent_goal_steps=(await db.prepare('SELECT * FROM agent_goal_steps WHERE goal_id IN (SELECT id FROM agent_goals WHERE user_id=?)').all(user.id));
      result.records.memory_embeddings=(await db.prepare('SELECT * FROM memory_embeddings WHERE memory_id IN (SELECT id FROM agent_memory WHERE user_id=?)').all(user.id));
      result.records.skill_embeddings=(await db.prepare('SELECT * FROM skill_embeddings WHERE skill_id IN (SELECT id FROM skills WHERE user_id=?)').all(user.id));
      result.archivedAppState=JSON.parse(user.app_state||'{}');
    }
    result.records.agent_logs=(await db.prepare('SELECT * FROM agent_logs WHERE client_id=?').all(row.client_id));
    return result;
  }
  async function handle(req,res,url){
    const path=url.pathname;
    if(path.startsWith('/api/auth/')||path.startsWith('/api/account/')){
      checkWrite(req);return json(res,410,{error:'账号密码功能已移除，请刷新页面后直接开始使用。'});
    }
    if(!path.startsWith('/api/device/'))return false;
    checkWrite(req);
    if(path==='/api/device/session'&&req.method==='GET'){
      const row=await session(req);return json(res,200,{ok:true,device:row?publicAccount(row):null});
    }
    if(path==='/api/device/session'&&req.method==='POST'){
      await readBody(req,8000);
      let row=await session(req);
      if(row){
        await db.prepare('UPDATE account_sessions SET expires_at=? WHERE token_hash=?').run(Date.now()+SESSION_MS,row.token_hash);
        const token=String(req.headers.cookie).match(/(?:^|;\s*)xiaofan_session=([a-f0-9]{64})(?:;|$)/)[1];
        cookie(res,token,SESSION_MS/1000);return json(res,200,{ok:true,device:publicAccount(row)});
      }
      await rate(req);
      const id=randomUUID(),clientId=randomUUID();
      // Legacy columns stay for schema compatibility; no usable password is created.
      await db.prepare('INSERT INTO accounts(id,username,password_hash,client_id,created_at) VALUES(?,?,?,?,?)').run(id,'device_'+id,'device:disabled',clientId,new Date().toISOString());
      await issue(res,id);row=await account(id);
      return json(res,201,{ok:true,device:publicAccount(row)});
    }
    const row=await session(req);if(!row)throw fail(401,'设备会话已失效，请刷新页面后开始使用');
    if(path==='/api/device/export'&&req.method==='GET'){
      res.setHeader('Content-Disposition','attachment; filename="xiaofan-data.json"');return json(res,200,await exportData(row));
    }
    if(['/api/device/clear','/api/device/delete'].includes(path)&&req.method==='POST'){
      const b=await readBody(req,8000),deleting=path.endsWith('/delete'),confirmation=deleting?'删除全部数据':'清空数据';
      if(b.confirmation!==confirmation)throw fail(400,`请输入“${confirmation}”确认`);
      if((active.get(row.id)||0)>0)throw fail(409,'仍有请求正在处理，请等待完成后重试');
      await guardedWrite(row,[...purgeStatements(row.client_id),['DELETE FROM account_sessions WHERE account_id=?',[row.id]],deleting?['DELETE FROM accounts WHERE id=?',[row.id]]:['UPDATE accounts SET state_version=state_version+1 WHERE id=?',[row.id]]]);
      closeEvents(row.client_id);
      if(deleting)cookie(res,'',0);else await issue(res,row.id);
      return json(res,200,{ok:true});
    }
    return json(res,404,{error:'接口不存在'});
  }
  async function authorize(req,url){
    checkWrite(req);const row=(await session(req));if(!row)throw fail(401,'设备会话已失效，请刷新页面后开始使用');
    req.account=row;url.searchParams.set('clientId',row.client_id);
    active.set(row.id,(active.get(row.id)||0)+1);
    return ()=>{const count=(active.get(row.id)||1)-1;if(count)active.set(row.id,count);else active.delete(row.id)};
  }
  async function save(req,state){
    const row=await account(req.account.id);if(!row)throw fail(401,'设备会话已失效，请刷新页面后开始使用');
    if(String(req.headers['x-state-version'])!==String(row.state_version))throw fail(409,'云端数据已更新，请先处理同步冲突','STATE_CONFLICT');
    let saved;
    try{saved=await saveState(row.client_id,state,{before:[accountGuard({...row,token_hash:req.account.token_hash},{version:true,session:true})],after:[['UPDATE accounts SET state_version=state_version+1 WHERE id=?',[row.id]],clearGuard]})}
    catch(error){if(/write_guards|CHECK constraint/.test(error.message))throw fail(409,'云端数据已更新，请先处理同步冲突','STATE_CONFLICT');throw error}
    return {state:saved,stateVersion:row.state_version+1};
  }
  return {handle,authorize,save,session,publicAccount,exportData};
}
