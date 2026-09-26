/**
 * TRADE ARENA SERVICE WORKER
 * Progressive Web App offline support & caching
 *
 * Version: 2.0
 * Updated: 2026-04-18
 */

// Bumped to v6: the stylesheet parse fix (stray quote in var(--cyan')) and the
// /api/ no-cache rule. v5 is dropped so returning users get the corrected CSS
// instead of the cached, mostly-unparsed stylesheet.
const CACHE_VERSION = 'trade-arena-v6';
const CRITICAL_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// ═══════════════════════════════════════════════════════════
// INSTALL EVENT - Cache critical assets
// ═══════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log('🔧 Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      console.log('📦 Caching critical assets');
      return cache.addAll(CRITICAL_ASSETS).catch(err => {
        console.warn('⚠️ Cache addAll partial failure:', err);
        // Don't fail on partial cache misses
      });
    })
  );
  self.skipWaiting();
});

// ═══════════════════════════════════════════════════════════
// ACTIVATE EVENT - Clean old caches
// ═══════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log('✅ Service Worker activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_VERSION)
          .map(name => {
            console.log('🧹 Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

// ═══════════════════════════════════════════════════════════
// FETCH EVENT - Same-origin only (network first, cache fallback)
// ═══════════════════════════════════════════════════════════
//
// Only same-origin GETs are handled here. Previously this called
// event.respondWith() for EVERY request, which meant the service worker
// re-fetched cross-origin assets (Google Fonts, the ethers CDN, Google's
// sign-in script) itself. A worker's own fetch() is subject to the page's
// connect-src directive, and connect-src does not list those hosts - so
// every one of them failed with "Refused to connect because it violates the
// document's Content Security Policy". That silently blocked the webfonts
// (breaking the UI typography) and ethers (breaking the wallet).
//
// Letting the browser handle cross-origin requests directly is both correct
// and faster: the browser's normal request is governed by style-src /
// script-src, which DO allow those hosts.
self.addEventListener('fetch', event => {
  const req = event.request;

  // Let the browser handle anything that is not a simple same-origin GET.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API traffic. These responses are live account state (balances,
  // P&L, prices, positions); serving one from the cache would show the user a
  // stale balance after a deposit, withdrawal or trade. Always go to network,
  // and let a genuine offline failure surface as an error rather than as
  // convincing-but-wrong numbers.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  event.respondWith(
    fetch(req)
      .then(response => {
        // Cache successful responses
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_VERSION).then(cache => {
            cache.put(req, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed - try cache
        return caches.match(req)
          .then(response => response || createOfflineFallback(req));
      })
  );
});

// ═══════════════════════════════════════════════════════════
// OFFLINE FALLBACK
// ═══════════════════════════════════════════════════════════
function createOfflineFallback(request) {
  // For HTML documents, return cached index.html
  if (request.destination === 'document') {
    return caches.match('./index.html');
  }

  // For CSS, return a minimal fallback
  if (request.destination === 'style') {
    return new Response('body { color: #fff; }', {
      headers: { 'Content-Type': 'text/css' }
    });
  }

  // For everything else, return 404
  return new Response('Offline - Resource not available', {
    status: 404,
    statusText: 'Not Found'
  });
}

// ═══════════════════════════════════════════════════════════
// MESSAGE HANDLER - For communication with app
// ═══════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_VERSION);
  }
});

console.log('🚀 Trade Arena Service Worker loaded - PWA ready!');
