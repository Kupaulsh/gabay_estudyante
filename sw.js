/* Gabay Estudyante — service worker (web version only)
   Keeps the app files available offline. Online it always tries the network
   first, so updates show up straight away; offline it falls back to the saved copy. */
const CACHE = 'gabay-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'admin.js', 'data.js', 'notifications.js',
  'supabase-client.js', 'vendor-supabase.js'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method!=='GET') return;
  const url = new URL(req.url);
  if(url.origin!==self.location.origin) return;     // Supabase etc. are handled by the app itself
  e.respondWith(
    fetch(req).then(res=>{
      if(res && res.ok){ const copy = res.clone(); caches.open(CACHE).then(c=>c.put(req, copy)); }
      return res;
    }).catch(()=>caches.match(req).then(hit=>hit || (req.mode==='navigate' ? caches.match('index.html') : Response.error())))
  );
});
