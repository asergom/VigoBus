// Service worker: la app (interfaz y paradas) funciona sin conexión.
// La red peatonal, las direcciones y los horarios (data/peatonal.json, data/direcciones.json, data/viajes.json) se guardan en caché la primera vez que se usan.
// Los tiempos de llegada siempre se piden a la red. Sube VERSION al cambiar archivos.
const VERSION = "pv-v36";
const SHELL = [
  "./",
  "index.html",
  "css/app.css",
  "js/i18n.js",
  "js/app.js",
  "js/peaton.js",
  "js/direcciones.js",
  "js/bus.js",
  "js/planificador.js",
  "data/paradas.geojson",
  "data/lineas.json",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/leaflet.js",
  "fonts/Barlow-Regular.woff2",
  "fonts/Barlow-Medium.woff2",
  "fonts/Barlow-SemiBold.woff2",
  "fonts/BarlowCondensed-SemiBold.woff2",
  "fonts/BarlowCondensed-Bold.woff2",
  "icons/favicon.svg",
  "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // API y teselas: red
  // Primero la red (para ver cambios publicados) y, sin conexión, la caché.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
