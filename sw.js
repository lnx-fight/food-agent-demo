// 小饭 PWA Service Worker：应用外壳缓存优先，API 一律走网络
// 修改应用壳文件时同步递增版本，避免缓存优先策略继续提供旧版 app.js。
const CACHE='xiaofan-v9';
const SHELL=['./','./index.html','./styles.css','./app.js','./pantry.css','./onboarding.css','./api.css','./record-status.css'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==location.origin)return;
  if(url.pathname.includes('/api/'))return; // 数据接口永不缓存
  event.respondWith(
    caches.match(request).then(hit=>{
      const network=fetch(request).then(response=>{
        if(response&&response.ok){const clone=response.clone();caches.open(CACHE).then(cache=>cache.put(request,clone))}
        return response;
      }).catch(()=>hit);
      return hit||network;
    })
  );
});
