import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../account-ui.js',import.meta.url),'utf8');
function harness(responses){
  const nodes=new Map(),classes=new Set(['guest-mode']),requests=[],storageReads=[];
  const document={body:{classList:{add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name))}},addEventListener(){}};
  function node(id){
    if(!nodes.has(id))nodes.set(id,{id,hidden:['authGate','authForm','accountPanel'].includes(id),inert:id==='productApp',value:'',textContent:'',dataset:{},isConnected:true,addEventListener(){},focus(){document.activeElement=this}});
    return nodes.get(id);
  }
  document.getElementById=node;document.activeElement=node('guestAction');
  const storage={getItem(key){storageReads.push(key);return null},setItem(){},removeItem(){}};
  const window={};
  runInNewContext(source,{window,document,localStorage:storage,sessionStorage:storage,fetch:async path=>{
    requests.push(path);const response=responses.shift();if(response instanceof Error)throw response;
    return {ok:true,json:async()=>response};
  }});
  return {account:window.XiaofanAccount,node,document,classes,requests,storageReads};
}

test('访客启动不弹登录，不读取个人缓存或个人接口；使用功能才弹窗且可关闭',async()=>{
  const h=harness([{account:null}]);let guestCalls=0;
  await h.account.boot({guest(){guestCalls++},legacy(){assert.fail('访客不得读取旧档案')},ready(){assert.fail('访客不得进入个人产品')}});
  assert.deepEqual(h.requests,['/api/auth/session']);assert.equal(guestCalls,1);
  assert.equal(h.node('authGate').hidden,true);assert.equal(h.node('guestHome').hidden,false);assert.equal(h.node('productApp').inert,true);
  assert.ok(h.storageReads.every(key=>key==='xiaofan_login_expired'));
  const original=h.document.activeElement;
  assert.equal(h.account.requireLogin('登录后记录一餐'),false);
  assert.equal(h.node('authGate').hidden,false);assert.equal(h.node('authReason').textContent,'登录后记录一餐');
  assert.equal(h.node('guestHome').inert,true);assert.equal(h.document.activeElement,h.node('authUsername'));
  h.node('authPassword').value='temporary password';h.account.dismissLogin();
  assert.equal(h.node('authGate').hidden,true);assert.equal(h.node('guestHome').inert,false);assert.equal(h.node('authPassword').value,'');
  assert.equal(h.document.activeElement,original);assert.equal(h.classes.has('guest-mode'),true);
});

test('账号服务不可用仍允许浏览，用户主动使用时可以重试登录',async()=>{
  const h=harness([new Error('offline')]);
  await h.account.boot({guest(){},legacy(){assert.fail('不得读取个人缓存')}});
  assert.equal(h.node('guestHome').hidden,false);assert.equal(h.node('authGate').hidden,true);
  h.account.requireLogin();assert.equal(h.node('authGate').hidden,false);assert.equal(h.node('authRetry').hidden,false);
  h.node('authBrowse').onclick();assert.equal(h.node('authGate').hidden,true);
});

test('有效会话先加载本人状态，再进入个人产品，不再要求重复登录',async()=>{
  const account={id:'account-one',username:'existing_user'},remote={state:{profile:{age:30}},stateVersion:4};
  const h=harness([{account},remote]);let ready;
  await h.account.boot({legacy:()=>null,ready:(...args)=>{ready=args}});
  assert.deepEqual(h.requests,['/api/auth/session','/api/user/state']);assert.equal(ready[0].id,account.id);assert.equal(ready[1].stateVersion,4);
  assert.equal(h.node('guestHome').hidden,true);assert.equal(h.node('productApp').inert,false);assert.equal(h.node('authGate').hidden,true);
  assert.equal(h.account.requireLogin(),true);assert.equal(h.node('authGate').hidden,true);
});
