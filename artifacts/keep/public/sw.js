self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("keep-shell-v1").then((c) => c.addAll(["/", "/assets/styles.css", "/assets/app.js", "/assets/mark.svg"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api") || u.pathname.startsWith("/s/") || u.pathname.startsWith("/dav")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
