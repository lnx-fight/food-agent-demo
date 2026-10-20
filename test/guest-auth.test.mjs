import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../account-ui.js',import.meta.url),'utf8');
function harness(responses){
 const nodes=new Map(),classes=new Set(['guest-mode']),requests=[];
 const document={body:{classList:{add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name))}},addEventListener(){}};
 function node(id){if(!nodes.has(id))nodes.set(id,{id,hidden:['accountPanel'].includes(id),inert:id==='productApp',value:'',textContent:'',dataset:{},isConnected:true,addEventListener(){},focus(){document.activeElement=this}});return nodes.get(id)}
 document.getElementById=node;document.activeElement=node('guestAction');const window={};
 runInNewContext(source,{window,document,fetch:async(path,options)=>{
  requests.push({path,method:options.method});const response=responses.shift();if(response instanceof Error)throw response;
  return {ok:true,json:async()=>response};
 }});return {device:window.XiaofanDevice,node,classes,requests};
}
test('首次只浏览不创建数据空间，点击使用后直接建档，无需登录',async()=>{
 const device={id:'browser-one'},remote={state:null,stateVersion:0};
 const h=harness([{device},{device},remote]);let guests=0,ready;
 await h.device.boot({guest(){guests++},ready:(...args)=>{ready=args}});
 assert.equal(h.requests.length,0);assert.equal(guests,1);assert.equal(h.node('guestHome').hidden,false);assert.equal(h.node('productApp').inert,true);
 assert.equal(await h.device.start(),true);assert.equal(ready[0].id,device.id);assert.equal(ready[1].stateVersion,0);
 assert.equal(h.node('guestHome').hidden,true);assert.equal(h.node('productApp').inert,false);
 assert.deepEqual(h.requests.map(r=>r.path),['/api/device/session','/api/device/session','/api/user/state']);
 assert.equal(h.requests.some(r=>r.path.includes('/auth/')),false);
 await h.device.start();assert.equal(h.requests.length,3);
});
test('服务不可用可浏览并重试，阻止Cookie时不进入个人界面',async()=>{
 const h=harness([new Error('offline'),{device:{id:'device-one'}},{device:null}]);
 await h.device.boot({guest(){},ready(){assert.fail('Cookie不可用时不能进入')}});
 assert.equal(h.node('guestHome').hidden,false);assert.equal(h.requests.length,0);
 assert.equal(await h.device.start(),false);assert.equal(h.node('guestHome').hidden,false);
 assert.equal(await h.device.start(),false);assert.match(h.node('deviceConnectionStatus').textContent,/允许本站保存浏览器数据/);assert.equal(h.node('productApp').inert,true);
});
test('现有浏览器会话先加载本人记录，重复点击复用同一次连接',async()=>{
 const device={id:'old-account'},remote={state:{profile:{age:30}},stateVersion:4};
 const h=harness([{device},{device},remote]);let readyCount=0;
 await h.device.boot({ready:(value,data)=>{readyCount++;assert.equal(value.id,device.id);assert.equal(data.stateVersion,4)}});
 assert.equal(readyCount,0);assert.equal(h.node('productApp').inert,true);assert.equal(h.requests.length,0);
 await Promise.all([h.device.start(),h.device.start()]);assert.equal(readyCount,1);assert.equal(h.requests.length,3);assert.equal(h.node('productApp').inert,false);assert.equal(h.classes.has('guest-mode'),false);
 h.device.expired();assert.equal(h.node('guestHome').hidden,false);assert.match(h.node('deviceConnectionStatus').textContent,/创建新的使用空间/);
});
test('产品页面不存在用户名密码表单、注册登录或退出入口',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/authGate|authUsername|authPassword|accountPasswordForm|accountLogout|type="password"|data-login-purpose/);
 assert.match(html,/data-start-product>开始使用/);assert.match(html,/清除浏览器数据/);assert.match(html,/我的数据/);
 assert.match(html,/<body class="guest-mode">/);
 const css=readFileSync(new URL('../guest.css',import.meta.url),'utf8');assert.match(css,/body\.guest-mode #onboarding[^}]*display:none!important/);
});
