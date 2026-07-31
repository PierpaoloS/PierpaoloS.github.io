const C='giappone-v3';
self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./index.html','./manifest.webmanifest'])));
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==C).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==location.origin) return;               // API cambio ecc.: gestite dalla pagina
  const isDoc = req.mode==='navigate' || url.pathname==='/' || url.pathname.endsWith('/index.html');
  if(isDoc){
    // network-first: online prendi sempre l'ultima, offline usa la cache
    e.respondWith(
      fetch(req).then(r=>{const c=r.clone(); caches.open(C).then(x=>x.put('./index.html',c)); return r;})
        .catch(()=>caches.match('./index.html').then(r=>r||caches.match('./')))
    );
    return;
  }
  // altre risorse stesso dominio: cache-first
  e.respondWith(
    caches.match(req).then(cached=>cached || fetch(req).then(r=>{const c=r.clone(); caches.open(C).then(x=>x.put(req,c)); return r;}))
  );
});
