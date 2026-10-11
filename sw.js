/* Gabay Estudyante — service worker (web version only)
   - App files: served straight from the saved copy (instant start) and refreshed in the background.
   - Images: saved the first time they load, so they appear instantly (and offline) afterwards.
   - Data (Supabase) is handled by the app itself, never here. */
const VERSION = 'v3';
const SHELL_CACHE = 'gabay-shell-' + VERSION;
const IMG_CACHE = 'gabay-img-v1';
const IMG_MAX = 80;
/*SHELL*/
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'admin.js', 'data.js', 'study.js', 'notifications.js',
  'supabase-client.js', 'vendor-supabase.js', 'GaEs_Icon.png', 'pccm-logo.png', 'tup-logo.png', 'alarm.wav', 'alarm2.wav'];
/*END*/

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(SHELL_CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==SHELL_CACHE && k!==IMG_CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

async function trimImages(){
  const c = await caches.open(IMG_CACHE);
  const keys = await c.keys();
  if(keys.length>IMG_MAX) await Promise.all(keys.slice(0, keys.length-IMG_MAX).map(k=>c.delete(k)));
}
async function notifyUpdated(){
  const list = await self.clients.matchAll();
  list.forEach(cl=>cl.postMessage('updated'));
}

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method!=='GET') return;
  const url = new URL(req.url);

  // Images (any site): cache-first
  if(req.destination==='image'){
    e.respondWith(caches.open(IMG_CACHE).then(async c=>{
      const hit = await c.match(req);
      if(hit) return hit;
      try{
        const res = await fetch(req);
        if(res && (res.ok || res.type==='opaque')){ c.put(req, res.clone()); trimImages(); }
        return res;
      }catch(err){ return Response.error(); }
    }));
    return;
  }

  if(url.origin!==self.location.origin) return;     // Supabase, fonts etc. are left alone

  // App files: saved copy first, refreshed in the background
  e.respondWith(caches.open(SHELL_CACHE).then(async c=>{
    const hit = await c.match(req, {ignoreSearch:true});
    const refresh = fetch(req).then(async res=>{
      if(res && res.ok){
        if(hit && /script|style|document/.test(req.destination)){
          const [a, b] = [await hit.clone().text().catch(()=>''), await res.clone().text().catch(()=>'')];
          if(a && b && a!==b) notifyUpdated();
        }
        c.put(req, res.clone());
      }
      return res;
    }).catch(()=>null);
    if(hit){ refresh; return hit; }
    const res = await refresh;
    return res || (req.mode==='navigate' ? (await c.match('index.html')) : Response.error());
  }));
});
