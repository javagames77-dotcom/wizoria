// ═══════════════════════════════════════════════════════════
// GhostAudit / Wizoria — Shopper PWA Service Worker
// ═══════════════════════════════════════════════════════════

const CACHE_NAME = 'ga-shopper-v1';
const APP_SHELL = [
  './index.html',
  './app.js',
  './manifest.json'
];

// ─── INSTALL: pre-cache app shell ─────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE: clean up old caches ─────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(
      names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

// ─── FETCH ──────────────────────────────────────────────────
// App shell (same-origin, non-API) → cache-first, so the interface itself works offline.
// API calls (n8n webhook) → always network; the anketa/photo/audio screens keep collected
// data in memory until connectivity returns, per ТЗ ("Анкета заповнюється без інтернету.
// Синхронізація при підключенні") — actual background sync queue is a follow-up, not yet
// wired into this first version.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApiCall = url.hostname !== self.location.hostname;

  if (isApiCall) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ success: false, error: "Немає з'єднання з сервером" }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ─── PUSH ───────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'Wizoria', body: 'Нове сповіщення' };
  try { payload = event.data ? event.data.json() : payload; } catch (_) {}

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Wizoria', {
      body: payload.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      vibrate: [100, 50, 100],
      data: payload.data || {}
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow('./index.html');
    })
  );
});
