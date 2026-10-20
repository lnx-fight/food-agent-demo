import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
function harness({offline=false}={}){
 const handlers={},stored=[],cacheReads=[];
 runInNewContext(source,{self:{addEventListener(name,fn){handlers[name]=fn}},location:{origin:'https://xiaofan.test'},URL,Response,caches:{async match(request){cacheReads.push(request);return request==='./index.html'?new Response('cached offline page'):undefined},async open(){return {async put(request,response){stored.push(await response.text())}}}},fetch:async()=>{if(offline)throw new Error('offline');return new Response('latest deployed page')}});
 return {handlers,stored,cacheReads};
}
test('联网导航返回线上最新版HTML，不被已有页面缓存遮挡',async()=>{
 const h=harness();let response;
 h.handlers.fetch({request:{url:'https://xiaofan.test/',method:'GET',mode:'navigate'},respondWith(value){response=value}});
 assert.equal(await (await response).text(),'latest deployed page');assert.deepEqual(h.stored,['latest deployed page']);assert.equal(h.cacheReads.length,0);
});
test('离线导航回退预缓存页面，个人API仍不进入任何缓存',async()=>{
 const h=harness({offline:true});let response;
 h.handlers.fetch({request:{url:'https://xiaofan.test/?v=30',method:'GET',mode:'navigate'},respondWith(value){response=value}});
 assert.equal(await (await response).text(),'cached offline page');assert.ok(h.cacheReads.includes('./index.html'));
 h.handlers.fetch({request:{url:'https://xiaofan.test/api/user/state',method:'GET'},respondWith(){assert.fail('Private API must not be cached')}});
});
