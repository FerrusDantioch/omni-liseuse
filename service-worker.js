'use strict';

importScripts('js/config.js');

/*
 * Service worker d'Omni-Liseuse : rend l'application utilisable hors ligne.
 *
 * - CACHE_APP contient les fichiers applicatifs (mis à jour à chaque version).
 * - CACHE_LIBS contient les bibliothèques et polices (~2,2 Mo), afin de ne
 *   pas les retélécharger à chaque mise à jour de l'application.
 * - Les livres ne passent jamais par ici : ils sont dans IndexedDB.
 */

const CACHE_PREFIX = 'omni-liseuse-';
const CACHE_APP = 'omni-liseuse-app-v' + self.CONFIG_APP.version;
const CACHE_LIBS = 'omni-liseuse-libs-v2';
const SCOPE_PATH = new URL('./', self.location).pathname;
const NAVIGATION_TIMEOUT = 4000;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/themes.css',
  './css/app.css',
  './js/config.js',
  './js/theme-init.js',
  './js/app.js',
  './js/state.js',
  './js/loaders.js',
  './js/sanitize.js',
  './js/db.js',
  './js/import-export.js',
  './js/library.js',
  './js/pageturn.js',
  './js/reader.js',
  './js/pwa.js',
  './js/engines/epub.js',
  './js/engines/text.js',
  './js/engines/comic.js',
  './js/engines/pdf.js',
  './libs/LICENCES.txt',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

const LIBS_SHELL = [
  './libs/dexie.min.js',
  './libs/jszip.min.js',
  './libs/epub.min.js',
  './libs/pdf.min.mjs',
  './libs/pdf.worker.min.mjs',
  './polices/eb-garamond.woff2',
  './polices/eb-garamond-italique.woff2',
  './polices/oxanium.woff2'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const [appCache, libsCache] = await Promise.all([
      caches.open(CACHE_APP),
      caches.open(CACHE_LIBS)
    ]);

    const missingLibs = [];
    for (const url of LIBS_SHELL) {
      if (!(await libsCache.match(url))) missingLibs.push(url);
    }

    await Promise.all([
      appCache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' }))),
      missingLibs.length
        ? libsCache.addAll(missingLibs.map(url => new Request(url, { cache: 'reload' })))
        : Promise.resolve()
    ]);
  })());
});

/* Appui sur « Mettre à jour » : la nouvelle version remplace l'ancienne. */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_APP && key !== CACHE_LIBS)
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const inScope =
    url.protocol.startsWith('http') &&
    url.origin === self.location.origin &&
    url.pathname.startsWith(SCOPE_PATH);

  if (!inScope) return;

  if (request.mode === 'navigate') {
    event.respondWith(cachedPage(request, url));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cachedPage(request, url) {
  const appCache = await caches.open(CACHE_APP);
  const libsCache = await caches.open(CACHE_LIBS);

  let cached =
    (await appCache.match(request, { ignoreSearch: true })) ||
    (await libsCache.match(request, { ignoreSearch: true }));

  if (cached) return cached;

  const isAppRoot =
    url.pathname === SCOPE_PATH ||
    url.pathname === SCOPE_PATH + 'index.html';

  if (isAppRoot) {
    cached = await appCache.match('./');
    if (cached) return cached;
  }

  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Réseau trop lent')), NAVIGATION_TIMEOUT);
      })
    ]);

    if (response.status === 200 && response.type === 'basic') {
      await appCache.put(isAppRoot ? './' : request, response.clone());
    }

    return response;
  } catch (_) {
    return new Response(
      'Omni-Liseuse n’a pas encore été enregistrée pour le mode hors ligne. ' +
      'Ouvre-la une fois avec une connexion.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
}

async function cacheFirst(request) {
  const appCache = await caches.open(CACHE_APP);
  const libsCache = await caches.open(CACHE_LIBS);

  const cached =
    (await appCache.match(request, { ignoreVary: true })) ||
    (await libsCache.match(request, { ignoreVary: true }));

  if (cached) return cached;

  try {
    const response = await fetch(request);

    if (response.status === 200 && response.type === 'basic') {
      await appCache.put(request, response.clone());
    }

    return response;
  } catch (_) {
    return new Response(
      'Ressource indisponible hors ligne.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
}
