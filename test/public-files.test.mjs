import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PUBLIC_FILES,servePublicFile} from '../public-files.mjs';

function request(path,method='GET'){
  const result={};
  servePublicFile({method},{writeHead(status,headers){Object.assign(result,{status,headers})},end(body){result.body=body}},path);
  return result;
}

test('公开服务只提供应用资源，不暴露密钥、源码、数据库和个人文件',()=>{
  for(const path of ['/.env','/%2eenv','/.git/config','/server.mjs','/public-files.mjs','/package.json','/data/nutrition.sqlite','/data/nutrition.sqlite-wal','/README.md','/简历/','/../.env','/%2e%2e%2f.env','/index.html%00','//index.html'])assert.equal(request(path).status,404,path);
  assert.equal(request('/%zz').status,400);
});
test('页面及离线缓存需要的资源完整，HEAD无响应体，拒绝写入方法',()=>{
  assert.equal(request('/').status,200);
  for(const name of PUBLIC_FILES){const result=request('/'+name);assert.equal(result.status,200,name);assert.equal(result.headers['X-Content-Type-Options'],'nosniff');assert.equal(result.body.length,Number(result.headers['Content-Length']))}
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  for(const [,path] of html.matchAll(/(?:src|href)="([^"#]+)"/g))if(!path.startsWith('https:'))assert.equal(request('/'+path.split('?')[0]).status,200,path);
  const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
  for(const [,path] of sw.matchAll(/'\.\/([^']*)'/g))assert.equal(request('/'+path.split('?')[0]).status,200,path);
  assert.equal(request('/index.html','HEAD').body,undefined);
  assert.equal(request('/.env','HEAD').body,undefined);
  assert.equal(request('/','POST').status,405);
  assert.equal(request('/','POST').headers.Allow,'GET, HEAD');
});
test('页面脚本样式使用发布版本，离线预缓存与页面引用一致',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
  const shell=new Set([...sw.matchAll(/'\.\/([^']*)'/g)].map(match=>match[1]));
  const version=sw.match(/const CACHE='xiaofan-v(\d+)'/)[1];
  for(const [,path] of html.matchAll(/(?:src|href)="([^"#]+)"/g)){
    if(path.startsWith('https:')||!/^.+\.(css|js)(?:\?|$)/.test(path))continue;
    assert.equal(new URL(path,'https://xiaofan.test/').searchParams.get('v'),version,path);
    assert.ok(shell.has(path),`预缓存缺少 ${path}`);
  }
});
