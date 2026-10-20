import {randomBytes,randomUUID,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {env,isCloudflare} from './runtime.mjs';
import {atomic,accountGuard,clearGuard} from './database.mjs';
import {promisify} from 'node:util';

const derive=promisify(scrypt),SESSION_MS=7*86400000,COOKIE='xiaofan_session';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(status,message,code)=>Object.assign(new Error(message),{status,code});
const passwordValid=value=>typeof value==='string'&&value.length>=12&&value.length<=128;
async function passwordHash(password,salt=randomBytes(16).toString('hex')){
  if(isCloudflare){
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
    const key=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:100000},material,256);
    return `pbkdf2-sha256:100000:${salt}:${Buffer.from(key).toString('hex')}`;
  }
  const key=await derive(password,salt,64,{N:131072,r:8,p:1,maxmem:160*1024*1024});
  return `${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password,encoded){
  if(typeof password!=='string'||password.length>128)return false;
  if(encoded.startsWith('pbkdf2-sha256:')){
    const [,rounds,salt,key]=encoded.split(':');
    if(rounds!=='100000'||!key||key.length!==64)return false;
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
    const actual=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:Number(rounds)},material,256);
    return timingSafeEqual(Buffer.from(actual),Buffer.from(key,'hex'));
  }
  if(isCloudflare)throw fail(503,'此账号使用旧版密码格式，需先完成密码迁移');
  const [salt,key]=encoded.split(':'),actual=await passwordHash(password,salt);
  return timingSafeEqual(Buffer.from(actual.split(':')[1],'hex'),Buffer.from(key,'hex'));
}

export function createAccounts({db,json,readBody,getState,saveState,closeEvents=()=>{}}){
  if(!isCloudflare)db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,client_id TEXT UNIQUE NOT NULL,state_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS account_session_owner ON account_sessions(account_id);
    CREATE TABLE IF NOT EXISTS write_guards(ok INTEGER NOT NULL CHECK(ok=1));
    CREATE TABLE IF NOT EXISTS auth_attempts(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);`);
  const active=new Map();let hashing=0;
  // 限制同时执行的内存密集型密码派生，避免公开注册耗尽内存。
  async function passwordWork(fn){if(hashing>=2)throw fail(429,'登录服务繁忙，请稍后重试');hashing++;try{return await fn()}finally{hashing--}}
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
  const publicAccount=row=>({id:row.id,username:row.username,createdAt:row.created_at});
  function checkWrite(req){
    if(['GET','HEAD'].includes(req.method))return;
    const scheme=secure()?'https':'http',origin=env.PUBLIC_ORIGIN||`${scheme}://${req.headers.host}`;
    if(req.headers['x-requested-with']!=='Xiaofan'||(req.headers.origin&&req.headers.origin!==origin)||['cross-site','same-site'].includes(req.headers['sec-fetch-site']))throw fail(403,'请求来源校验失败，请从本站页面操作');
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail(415,'请使用 JSON 请求');
  }
  async function rate(req,username){
    const now=Date.now();(await db.prepare('DELETE FROM auth_attempts WHERE expires_at<=?').run(now));
    // 只在显式启用可信反向代理时读取代理提供的地址。
    const remote=isCloudflare?String(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'unknown'):env.TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',').at(-1).trim():req.socket.remoteAddress||'unknown';
    for(const [scope,key,limit] of [['ip',remote,30],['user',username,10]]){
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
    catch(error){if(/write_guards|CHECK constraint/.test(error.message))throw fail(409,'账号状态已改变，请重新登录');throw error}
  }
  async function exportData(row){
    const user=(await db.prepare('SELECT id,app_state FROM users WHERE client_id=?').get(row.client_id)),result={format:'xiaofan-account-export',version:1,exportedAt:new Date().toISOString(),account:publicAccount(row),state:(await getState(row.client_id)),records:{}};
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
    if(!path.startsWith('/api/auth/')&&!path.startsWith('/api/account/'))return false;
    checkWrite(req);
    if(path==='/api/auth/session'&&req.method==='GET'){
      const row=(await session(req));return json(res,200,{ok:true,account:row?publicAccount(row):null});
    }
    if(['/api/auth/register','/api/auth/login'].includes(path)&&req.method==='POST'){
      const b=await readBody(req,8000),username=String(b.username||'').trim().toLowerCase();
      (await rate(req,username));
      if(!/^[a-z0-9_]{3,32}$/.test(username)||!passwordValid(b.password))throw fail(400,'用户名需为3–32位字母、数字或下划线，密码需为12–128个字符');
      let row=await db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
      if(!row){
        const encoded=await passwordWork(()=>passwordHash(b.password)),id=randomUUID(),clientId=randomUUID();
        // A simultaneous first sign-in must not replace the winner's password or identity.
        const inserted=await db.prepare('INSERT INTO accounts(id,username,password_hash,client_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(username) DO NOTHING').run(id,username,encoded,clientId,new Date().toISOString());
        if(inserted.changes){
          await issue(res,id);return json(res,201,{ok:true,created:true,account:publicAccount(await account(id))});
        }
        row=await db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
      }
      if(path.endsWith('/register'))throw fail(409,'该用户名不可用，请更换');
      if(!row)throw fail(401,'账号状态已改变，请重新登录');
      const encoded=row.password_hash;
      const matched=await passwordWork(async ()=>(await passwordMatches(b.password,encoded)));
      if(!row||!matched)throw fail(401,'用户名或密码不正确');
      // 密码校验期间账号可能被另一会话修改或注销。
      if((await account(row.id))?.password_hash!==encoded)throw fail(401,'账号状态已改变，请重新登录');
      (await issue(res,row.id));return json(res,200,{ok:true,created:false,account:publicAccount(row)});
    }
    const row=(await session(req));if(!row)throw fail(401,'请先登录');
    if(path==='/api/auth/logout'&&req.method==='POST'){
      (await db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(row.token_hash));cookie(res,'',0);closeEvents(row.client_id);return json(res,200,{ok:true});
    }
    if(path==='/api/auth/logout-all'&&req.method==='POST'){
      (await db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(row.id));cookie(res,'',0);closeEvents(row.client_id);return json(res,200,{ok:true});
    }
    if(path==='/api/account/export'&&req.method==='GET'){
      res.setHeader('Content-Disposition','attachment; filename="xiaofan-data.json"');return json(res,200,(await exportData(row)));
    }
    if(['/api/account/password','/api/account/clear','/api/account/delete'].includes(path)&&req.method==='POST'){
      const b=await readBody(req,8000);
      if(!await passwordWork(async ()=>(await passwordMatches(b.password,row.password_hash))))throw fail(403,'当前密码不正确');
      if((await account(row.id))?.password_hash!==row.password_hash||!(await session(req)))throw fail(401,'会话已失效，请重新登录');
      if((active.get(row.id)||0)>0)throw fail(409,'仍有请求正在处理，请等待完成后重试');
      if(path.endsWith('/password')){
        if(!passwordValid(b.newPassword))throw fail(400,'新密码需为12–128个字符');
        const encoded=await passwordWork(async ()=>(await passwordHash(b.newPassword)));
        if((await account(row.id))?.password_hash!==row.password_hash)throw fail(409,'账号状态已改变，请重新登录');
        await guardedWrite(row,[['UPDATE accounts SET password_hash=? WHERE id=?',[encoded,row.id]],['DELETE FROM account_sessions WHERE account_id=?',[row.id]]]);
        closeEvents(row.client_id);(await issue(res,row.id));return json(res,200,{ok:true});
      }
      const confirmation=path.endsWith('/delete')?'注销账号':'清空数据';
      if(b.confirmation!==confirmation)throw fail(400,`请输入“${confirmation}”确认`);
      await guardedWrite(row,[...purgeStatements(row.client_id),['DELETE FROM account_sessions WHERE account_id=?',[row.id]],path.endsWith('/delete')?['DELETE FROM accounts WHERE id=?',[row.id]]:['UPDATE accounts SET state_version=state_version+1 WHERE id=?',[row.id]]]);
      closeEvents(row.client_id);
      if(path.endsWith('/clear'))(await issue(res,row.id));else cookie(res,'',0);
      return json(res,200,{ok:true});
    }
    return json(res,404,{error:'接口不存在'});
  }
  async function authorize(req,url){
    checkWrite(req);const row=(await session(req));if(!row)throw fail(401,'请先登录');
    req.account=row;url.searchParams.set('clientId',row.client_id);
    active.set(row.id,(active.get(row.id)||0)+1);
    return ()=>{const count=(active.get(row.id)||1)-1;if(count)active.set(row.id,count);else active.delete(row.id)};
  }
  async function save(req,state){
    const row=await account(req.account.id);if(!row)throw fail(401,'请先登录');
    if(String(req.headers['x-state-version'])!==String(row.state_version))throw fail(409,'云端数据已更新，请先处理同步冲突','STATE_CONFLICT');
    let saved;
    try{saved=await saveState(row.client_id,state,{before:[accountGuard({...row,token_hash:req.account.token_hash},{version:true,session:true})],after:[['UPDATE accounts SET state_version=state_version+1 WHERE id=?',[row.id]],clearGuard]})}
    catch(error){if(/write_guards|CHECK constraint/.test(error.message))throw fail(409,'云端数据已更新，请先处理同步冲突','STATE_CONFLICT');throw error}
    return {state:saved,stateVersion:row.state_version+1};
  }
  return {handle,authorize,save,session,publicAccount,exportData};
}
