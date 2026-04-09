/**
 * Toolspage Elite Service Worker
 * (c) 2026 Antigravity
 */

const CACHE_NAME = "toolspage-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/assets/css/styles.css",
  "/assets/js/app.js",
  "/assets/js/api-client.js",
  "/assets/vendor/pdf-lib.min.js",
  "/assets/vendor/tesseract.min.js",
  "/assets/vendor/jspdf.umd.min.js",
  "/assets/vendor/mammoth.browser.min.js",
  "/assets/vendor/pdf.min.js",
  "/assets/vendor/pdf.worker.min.js",
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700;800&family=Sora:wght@400;700;800&display=swap"
];

// Install Event
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] Pre-caching elite assets...");
      return cache.addAll(ASSETS);
    })
  );
});

// Activate Event (Cleanup)
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
});

// Fetch Event (Cache-First)
self.addEventListener("fetch", (e) => {
  if (e.request.method === "POST" && e.request.url.endsWith("/share")) {
    e.respondWith((async () => {
      const formData = await e.request.formData();
      const file = formData.get("shared_file");
      if (file) {
        const cache = await caches.open("toolspage-share");
        await cache.put("/shared-file", new Response(file, { headers: { "X-Original-Name": file.name, "Content-Type": file.type } }));
      }
      return Response.redirect("/tools/share-router.html", 303);
    })());
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      return cachedResponse || fetch(e.request);
    })
  );
});
