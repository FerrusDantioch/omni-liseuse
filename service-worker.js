"use strict";

/*
 * Service worker d'Omni-Liseuse : rend l'application utilisable hors ligne.
 *
 * - La page (index.html) est d'abord demandée au réseau, pour recevoir
 *   les mises à jour ; sans connexion, la copie en cache est utilisée.
 *   Pas besoin de changer CACHE_NAME à chaque mise à jour de la page.
 * - Les bibliothèques (versions figées) et les icônes sont servies
 *   depuis le cache.
 * - Les livres ne passent jamais par ici : ils sont dans IndexedDB.
 */

const CACHE_NAME = "omni-liseuse-v3.1.0";
const CACHE_PREFIX = "omni-liseuse-";

const APP_SHELL = [
  "./",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

const LIBRARIES = [
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  "https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js",
  "https://unpkg.com/dexie@4.0.11/dist/dexie.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Oxanium:wght@500;600;700&display=swap"
];

/* Sites externes dont les réponses peuvent être gardées en cache. */
const CACHED_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com"
];

const NAVIGATION_TIMEOUT = 4000;

async function fetchExternal(request) {
  const url = typeof request === "string" ? request : request.url;

  try {
    // Réponse « cors » lisible plutôt qu'opaque : elle occupe moins de quota.
    return await fetch(url, { mode: "cors", credentials: "omit" });
  } catch (error) {
    return fetch(request, { mode: "no-cors", credentials: "omit" });
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await cache.addAll(
      APP_SHELL.map(url => new Request(url, { cache: "reload" }))
    );

    await Promise.allSettled(LIBRARIES.map(async url => {
      const response = await fetchExternal(url);
      if (response.ok || response.type === "opaque") {
        await cache.put(url, response);
      }
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (request.mode === "navigate" && sameOrigin) {
    event.respondWith(networkFirstPage(request));
    return;
  }

  if (sameOrigin || CACHED_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, sameOrigin));
  }
});

async function networkFirstPage(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Réseau trop lent")), NAVIGATION_TIMEOUT);
      })
    ]);

    if (response.ok) {
      await cache.put("./", response.clone());
    }

    return response;
  } catch (error) {
    const cached = await cache.match("./") || await cache.match(request, { ignoreSearch: true });

    if (cached) return cached;

    return new Response(
      "Omni-Liseuse n’a pas encore été enregistrée pour le mode hors ligne. " +
      "Ouvrez-la une fois avec une connexion.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
}

async function cacheFirst(request, sameOrigin) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreVary: true });

  if (cached) return cached;

  const response = sameOrigin ? await fetch(request) : await fetchExternal(request);

  if (response.ok || response.type === "opaque") {
    await cache.put(request, response.clone());
  }

  return response;
}
