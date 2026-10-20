// 小饭 PWA Service Worker：应用外壳缓存优先，API 一律走网络
// 修改应用壳文件时同步递增版本，避免缓存优先策略继续提供旧版 app.js。
const CACHE='xiaofan-v31';
const SHELL=['./','./index.html','./styles.css?v=31','./app.js?v=31','./adaptive-plan.js?v=31','./pantry.css?v=31','./onboarding.css?v=31','./api.css?v=31','./record-status.css?v=31','./adaptive-plan.css?v=31','./account-ui.js?v=31','./account.css?v=31','./guest.css?v=31','./guest-ui.js?v=31','./food-catalog.js?v=31','./food-catalog.css?v=31','./xiaofan-icon.png','./icon-192.png','./apple-touch-icon.png','./favicon-32.png','./favicon.ico','./site.webmanifest'];

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
  // Online navigation must use the deployed page; keep cached HTML for offline use.
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).then(async response=>{
      if(!response.ok)throw new Error('Page unavailable');
      try{const cache=await caches.open(CACHE);await cache.put(request,response.clone())}catch{}
      return response;
    }).catch(async()=>await caches.match(request)||await caches.match('./index.html')||new Response('网络不可用，请联网后重试。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})));
    return;
  }
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
