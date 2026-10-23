/* Próximo Vitrasa: mapa de paradas y próximos buses en Vigo. */
(() => {
  "use strict";

  // ---------- Configuración ----------
  // Tiempos en vivo: API de datos abiertos del Concello de Vigo.
  // Si el navegador la bloquea (CORS), se puede poner aquí la URL de un proxy
  // definiendo window.PV_API_URL antes de cargar este script.
  const API_URL = window.PV_API_URL || "https://datos.vigo.org/vci_api_app/api2.jsp";
  const INFOBUS_URL = (id) => `https://infobus.vitrasa.es:8002/Default.aspx?parada=${encodeURIComponent(id)}`;
  const REFRESH_MS = 30000;
  const NEAR_COUNT = 15;
  const FAV_KEY = "pv:favoritas";
  const FAV_KEY2 = "pv:favoritas2";
  const VIGO = [42.2286, -8.7226];

  // ---------- Idioma ----------
  const I18N = window.PV_I18N;
  const LANG_KEY = "pv:idioma";
  function pickLang() {
    try { const saved = localStorage.getItem(LANG_KEY); if (saved && I18N.dict[saved]) return saved; } catch { /* sin almacenamiento */ }
    const nav = (navigator.languages || [navigator.language || "es"]).map((l) => l.slice(0, 2).toLowerCase());
    return nav.find((l) => I18N.dict[l]) || "es";
  }
  let lang = pickLang();
  function t(key, params = {}) {
    const str = (I18N.dict[lang] && I18N.dict[lang][key]) || I18N.dict.es[key] || key;
    return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ""));
  }
  const flagSvg = (code) => I18N.langs.find((l) => l.code === code).flag;

  // ---------- Utilidades ----------
  const panel = document.getElementById("panel");
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
  const isDesktop = () => matchMedia("(min-width: 860px)").matches;
  const canHover = matchMedia("(hover: hover)").matches;

  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(m / 1000)} km`;
  }
  const walkMin = (m) => Math.max(1, Math.round(m / 75)); // ~4,5 km/h

  const LOWER = new Set(["por", "de", "do", "da", "dos", "das", "del", "e", "y", "o", "a", "en"]);
  function titleCase(s) {
    return s.replace(/\s+/g, " ").trim().toLowerCase().split(" ")
      .map((w, i) => (i > 0 && LOWER.has(w)) ? w : w.replace(/^(\(?)(\p{L})/u, (_, p, c) => p + c.toUpperCase()))
      .join(" ");
  }

  // Polilínea codificada (algoritmo de Google, precisión 5).
  function decodePolyline(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let b, shift = 0, res = 0;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
        const d = res & 1 ? ~(res >> 1) : res >> 1;
        if (k === 0) lat += d; else lng += d;
      }
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }

  const normLine = (c) => String(c).trim().replace(/[.\-]+$/, "").trim().replace(/^PSA(\d)/, "PSA $1");

  // Chapa de línea con su color oficial (si se conoce).
  function lineStyle(code) {
    const l = lines && lines[code];
    return l ? ` style="--lc:${l.color};--lt:${l.texto}"` : "";
  }
  function lineChip(code, cls = "chip") {
    const tappable = lines && lines[code];
    const tag = tappable ? "button" : "i";
    const attrs = tappable ? ` type="button" data-line="${esc(code)}" aria-label="${esc(t("see_line", { code }))}"` : "";
    return `<${tag} class="${cls}"${attrs}${lineStyle(code)}>${esc(code)}</${tag}>`;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- Estado ----------
  let stops = [];                 // {id, name, key, ll:[lat,lon], marker}
  const byId = new Map();
  let favs = loadFavs();
  let me = null;                  // [lat, lon] del usuario
  let mode = "near";              // near | fav | search
  let current = null;             // parada abierta
  let refreshTimer = null;
  let fetchCtl = null;
  let qTimer = null;               // búsqueda pendiente mientras se escribe
  let reqSeq = 0;                 // descarta respuestas de peticiones antiguas
  let lines = null;               // data/lineas.json: recorrido y paradas de cada línea
  let lineRuta = null;            // destino de la fila de llegadas desde la que se abrió la línea
  let active = null;              // línea iluminada: { code, dir, stops, from, fromDir }
  let tripRouteOn = false;        // hay un viaje dibujado en "Cómo llegar"

  // Favoritas (5): paradas (con las líneas que se quieren ver, o todas), direcciones o sitios, y
  // casa y trabajo. Se guardan en este dispositivo; las de antes (una lista de paradas) se pasan solas.
  // { stops: [{ id, lines: null | [códigos] }], places: [{ ll, label, site? }], home, work }
  function loadFavs() {
    const empty = { stops: [], places: [], home: null, work: null };
    try {
      const v2 = JSON.parse(localStorage.getItem(FAV_KEY2));
      if (v2 && Array.isArray(v2.stops)) return { ...empty, ...v2 };
      const old = JSON.parse(localStorage.getItem(FAV_KEY));
      if (Array.isArray(old)) return { ...empty, stops: old.map((id) => ({ id: String(id), lines: null })) };
    } catch { /* sin almacenamiento o datos raros */ }
    return empty;
  }
  function saveFavs() {
    try {
      localStorage.setItem(FAV_KEY2, JSON.stringify(favs));
      localStorage.setItem(FAV_KEY, JSON.stringify(favs.stops.map((f) => f.id)));   // por si se vuelve a una versión anterior
    } catch { /* sin almacenamiento */ }
  }
  const favStop = (id) => favs.stops.find((f) => f.id === id);
  const placeKey = (p) => `${fmtLL(p.ll)}|${p.label}`;
  const favPlace = (p) => favs.places.find((f) => placeKey(f) === placeKey(p));

  // Buscadas recientemente (14): las últimas paradas, direcciones y sitios elegidos en el buscador o
  // en Desde/Hasta, para volver a ellos sin escribir. [{ id } | { ll, label, site? }], la última primero.
  const RECENT_KEY = "pv:recientes", RECENT_MAX = 8;
  let recents = [];
  try { const r = JSON.parse(localStorage.getItem(RECENT_KEY)); if (Array.isArray(r)) recents = r.filter((x) => x && (x.id || (x.ll && x.label))); } catch { /* sin almacenamiento */ }
  const recentKey = (r) => (r.id ? `s${r.id}` : placeKey(r));
  function saveRecents() { try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); } catch { /* sin almacenamiento */ } }
  function addRecent(r) {
    const e = r.id ? { id: String(r.id) } : { ll: [Number(r.ll[0].toFixed(5)), Number(r.ll[1].toFixed(5))], label: r.label, ...(r.site ? { site: r.site } : {}) };
    recents = [e, ...recents.filter((x) => recentKey(x) !== recentKey(e))].slice(0, RECENT_MAX);
    saveRecents();
  }

  // ---------- Mapa ----------
  const map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: true })
    .setView(VIGO, 14);
  map.attributionControl.setPrefix(false);
  if (isDesktop()) L.control.zoom({ position: "topleft" }).addTo(map);

  // Mapa base de OpenStreetMap: gratuito y sin clave.
  // OpenStreetMap exige saber desde qué web se piden los mapas (cabecera Referer).
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, referrerPolicy: "strict-origin-when-cross-origin",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">Colaboradores de OpenStreetMap</a>',
  }).addTo(map);
  map.attributionControl.addAttribution('Portales: <a href="https://datos.vigo.org/">Concello de Vigo</a>, <a href="https://www.sedecatastro.gob.es/">D. G. del Catastro</a>');

  // Abierta como archivo (file://) no hay web de origen y OpenStreetMap bloquea el mapa.
  if (location.protocol === "file:") {
    setTimeout(() => toast(t("file_warning")), 800);
  }

  const css = getComputedStyle(document.documentElement);
  const RED = css.getPropertyValue("--bus").trim() || "#D3202F";
  const INK = css.getPropertyValue("--ink").trim() || "#13222C";
  const renderer = L.canvas({ padding: 0.3, tolerance: 6 });

  // Icono de parada (señal con un autobús). Rojo normal, azul ría en favoritas
  // y, con una línea elegida, del color oficial de esa línea.
  const stopSvg = (bg, fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="${bg}" stroke="#fff" stroke-width="2.5"/><g fill="${fg}"><path d="M10.2 7.5h11.6a2.7 2.7 0 0 1 2.7 2.7v11.3a1.6 1.6 0 0 1-1.6 1.6H9.1a1.6 1.6 0 0 1-1.6-1.6V10.2a2.7 2.7 0 0 1 2.7-2.7z"/><rect x="9.6" y="23" width="3.2" height="2.6" rx="1"/><rect x="19.2" y="23" width="3.2" height="2.6" rx="1"/></g><g fill="${bg}"><rect x="9.8" y="10.4" width="12.4" height="5.6" rx="1.2"/><rect x="12.5" y="8.3" width="7" height="1.2" rx=".6"/><circle cx="11.2" cy="19.4" r="1.3"/><circle cx="20.8" cy="19.4" r="1.3"/></g></svg>`;
  const sizeFor = (z) => (z <= 12 ? 12 : z === 13 ? 16 : z === 14 ? 20 : z === 15 ? 26 : 30);
  const iconCache = new Map();
  function iconFor(s, z) {
    let bg = "#D3202F", fg = "#FFFFFF";
    const l = active && lines && lines[active.code];
    if (l && active.stops.has(s.id)) { bg = l.color; fg = l.texto; }
    else if (favStop(s.id)) bg = "#13222C";
    const size = sizeFor(z) + (l && active.stops.has(s.id) ? 4 : 0), k = `${bg}|${fg}|${size}`;
    if (!iconCache.has(k)) {
      iconCache.set(k, L.icon({
        iconUrl: `data:image/svg+xml,${encodeURIComponent(stopSvg(bg, fg))}`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2], className: "stop-icon",
      }));
    }
    return iconCache.get(k);
  }
  const refreshIcon = (s) => s.marker.setIcon(iconFor(s, map.getZoom()));
  const lineGroup = L.layerGroup().addTo(map);

  const selRing = L.circleMarker(VIGO, { renderer, radius: 22, weight: 3, color: RED, fill: false, interactive: false });
  let meMarker = null;

  // Con una línea elegida y el mapa alejado, las paradas se ocultan para que se vea bien el recorrido.
  const LINE_STOPS_ZOOM = 15;
  function updateStopVisibility() {
    // Con una línea abierta, las paradas se ocultan al alejar. En "Cómo llegar", con un viaje
    // dibujado, solo se ven las paradas de ese viaje (las dibuja drawTrip con el color de su línea).
    map.getContainer().classList.toggle("hide-stops", !!active && map.getZoom() < LINE_STOPS_ZOOM);
    map.getContainer().classList.toggle("trip-stops", tripRouteOn);
    drawNums();   // los números de portal se ocultan con una línea o un viaje dibujados
  }

  map.on("zoomend", () => {
    updateStopVisibility();
    const z = map.getZoom();
    stops.forEach((s) => s.marker.setIcon(iconFor(s, z)));
    selRing.setRadius(sizeFor(z) / 2 + 7);
  });
  map.on("moveend", () => { if (mode === "near" && !me && !current && !active) renderNear(); });

  // Centra un punto en la zona del mapa que no tapa el panel.
  function focusOn(ll, zoom) {
    const z = zoom != null ? zoom : Math.max(map.getZoom(), 16);
    const p = map.project(ll, z);
    const panel = $("#panel");
    // En móvil se usa la altura final del panel, no la de mitad de animación.
    const st = panel.dataset.state;
    const h = st === "full" ? innerHeight - 56 : st === "stop" ? innerHeight * 0.64 : st === "min" ? 92 : Math.max(260, innerHeight * 0.46);
    const shift = isDesktop() ? L.point(-panel.getBoundingClientRect().right / 2, 0) : L.point(0, h / 2);
    map.setView(map.unproject(p.add(shift), z), z, { animate: true });
  }

  // ---------- Datos ----------
  fetch("data/paradas.geojson")
    .then((r) => r.json())
    .then((gj) => {
      stops = gj.features.map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        const s = { id: f.properties.id, name: f.properties.nombre, lines: f.properties.lineas || [], ll: [lat, lon] };
        s.key = norm(`${s.name} ${s.id}`);
        s.marker = L.marker(s.ll, { icon: iconFor(s, map.getZoom()), keyboard: false, alt: s.name })
          .on("click", () => { if (tripOpen()) tripPickStop(s); else navigate(s.id, { replace: !!current }); })
          .addTo(map);
        if (canHover) s.marker.bindTooltip(() => `${esc(s.name)} (${esc(s.id)})`, { direction: "top", offset: [0, -6] });
        byId.set(s.id, s);
        return s;
      });
      // Encuadre inicial: el centro de Vigo, donde está la mayoría de paradas.
      map.setView(VIGO, 14);
      route();
    })
    .catch(() => {
      $("#list-note").textContent = t("stops_error");
    });

  const linesReady = fetch("data/lineas.json")
    .then((r) => r.json())
    .then((d) => {
      lines = d;
      // Con las líneas ya cargadas: abrir un enlace #linea/… o dar color a las chapas visibles.
      if (location.hash.startsWith("#linea/")) route();
      else if (current) $("#stop-lines").innerHTML = current.lines.map((l) => lineChip(l)).join("");
      else render();
    })
    .catch(() => { lines = {}; })
    .then(() => lines);

  // ---------- Lista ----------
  function stopItem(s, extra) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-id="${esc(s.id)}">
      <span class="name">${extra.nameHtml || esc(s.name)}</span>
      <span class="sub">${esc(t("stop_n", { id: s.id }))}${extra.sub ? ` · ${esc(extra.sub)}` : ""}</span>
      ${s.lines.length && !extra.noLines ? `<span class="lines">${s.lines.map((l) => `<i${lineStyle(l)}>${esc(l)}</i>`).join("")}</span>` : ""}
      ${extra.dist != null ? `<span class="dist">${fmtDist(extra.dist)}</span>` : ""}
    </button>`;
    return li;
  }

  function fillList(items, note) {
    const ul = $("#list");
    ul.replaceChildren(...items);
    const n = $("#list-note");
    if (note instanceof Node) n.replaceChildren(note); else n.textContent = note || "";
  }

  function nearest(origin, n) {
    return stops.map((s) => ({ s, d: haversine(origin, s.ll) }))
      .sort((a, b) => a.d - b.d).slice(0, n);
  }

  // "Qué sale ya cerca de mí" (22): con la ubicación, primero los próximos buses de las paradas a
  // menos de 600 m, mezclados por minutos (sin los que pasan antes de poder llegar andando).
  const NEAR_DEP_M = 600, NEAR_DEP_MAX = 8;
  let nearTimer = null;
  function renderNear() {
    if (!stops.length) return;
    clearTimeout(nearTimer);
    if (me) {
      const near = nearest(me, NEAR_COUNT);
      const dep = document.createElement("li");
      dep.className = "near-dep";
      dep.innerHTML = `<p class="group-head">${esc(t("near_dep"))}</p><div class="arrivals near-dep-list"><p class="note">…</p></div>`;
      const items = [dep, groupHead(t("near_stops")), ...near.map(({ s, d }) => stopItem(s, { dist: d, sub: t("walk", { n: walkMin(d) }) }))];
      fillList(items, "");
      refreshNearDep();
    } else {
      const c = map.getCenter();
      const items = nearest([c.lat, c.lng], NEAR_COUNT).map(({ s }) => stopItem(s, {}));
      const p = document.createElement("span");
      p.append(`${t("area_note")} `);
      const b = document.createElement("button");
      b.type = "button"; b.textContent = t("use_location");
      b.onclick = locate;
      p.append(b);
      fillList(items, p);
    }
  }


  function highlight(name, tokens) {
    // Subraya las coincidencias sin tener en cuenta tildes.
    const plain = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const ranges = [];
    tokens.forEach((t) => { const i = plain.indexOf(t); if (i >= 0) ranges.push([i, i + t.length]); });
    if (!ranges.length) return esc(name);
    ranges.sort((a, b) => b[0] - a[0]);
    const out = name;
    const parts = [];
    let end = out.length;
    ranges.forEach(([a, b]) => { if (b > end) return; parts.unshift(esc(out.slice(b, end))); parts.unshift(`<mark>${esc(out.slice(a, b))}</mark>`); end = a; });
    parts.unshift(esc(out.slice(0, end)));
    return parts.join("");
  }

  // Paradas que coinciden con lo escrito: por número de poste o por palabras del nombre (sin tildes).
  function matchStops(q) {
    const nq = norm(q);
    const tokens = nq.split(" ").filter(Boolean);
    if (/^\d+[a-z]?$/.test(nq)) {
      return stops.filter((s) => s.id.toLowerCase().startsWith(nq))
        .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
    }
    const res = stops.filter((s) => tokens.every((t) => s.key.includes(t)));
    res.sort((a, b) => (a.key.startsWith(tokens[0]) ? 0 : 1) - (b.key.startsWith(tokens[0]) ? 0 : 1) || a.name.localeCompare(b.name, "es"));
    return res;
  }

  function renderSearch(q) {
    const nq = norm(q);
    const tokens = nq.split(" ").filter(Boolean);
    const res = matchStops(q);
    // Líneas: por código ("18" → 18A, 18B, 18H; "c3" → C3d, C3i) o por nombre ("hospital").
    const compact = nq.replace(/ /g, "");
    const lineRes = !lines ? [] : Object.keys(lines).filter((code) => {
      const c = norm(code).replace(/ /g, "");
      return c === compact || (compact.length >= 1 && c.startsWith(compact) && /\d|^[a-z]{1,3}$/.test(compact)) ||
        (tokens.length && tokens.every((tk) => norm(lines[code].nombre).includes(tk)) && compact.length >= 3);
    });
    const shown = res.slice(0, 60);
    // Direcciones (calle y número), a partir de 3 letras; el diccionario se descarga la primera vez.
    const addr = [];
    if (/\p{L}.*\p{L}.*\p{L}/u.test(q)) {
      if (!dirData) ensureDir().then(() => { if ($("#q").value.trim() === q && mode === "search") renderSearch(q); }).catch(() => {});
      else {
        const p = dirData.parse(q);
        const found = dirData.matchStreets(p.street, p.num ? 3 : 4);
        found.forEach((st) => addr.push(addrItem(st, p.num, tokens)));
        if (p.num && found[0]) dirData.numbersStarting(found[0], p.num, 3).forEach((n) => addr.push(addrItem(found[0], n, tokens)));
      }
    }
    // Sitios importantes, también a partir de 3 letras.
    let sites = [];
    if (/\p{L}.*\p{L}.*\p{L}/u.test(q)) {
      if (!sitesData) ensureSites().then(() => { if ($("#q").value.trim() === q && mode === "search") renderSearch(q); }).catch(() => {});
      else sites = matchSites(q);
    }
    const items = [];
    if (lineRes.length) {
      items.push(groupHead(t("res_lines")));
      lineRes.forEach((code) => items.push(lineItem(code, highlight(lines[code].nombre, tokens))));
    }
    if (sites.length) items.push(groupHead(t("res_sites")), ...sites.map((s) => siteItem(s, tokens)));
    if (addr.length) items.push(groupHead(t("res_addr")), ...addr);
    if ((lineRes.length || addr.length || sites.length) && shown.length) items.push(groupHead(t("res_stops")));
    shown.forEach((s) => items.push(stopItem(s, { nameHtml: highlight(s.name, tokens), dist: me ? haversine(me, s.ll) : null })));
    fillList(items,
      res.length || lineRes.length || addr.length || sites.length ? (res.length > shown.length ? t("many", { n: res.length }) : "") : t("no_results", { q }));
  }


  // ---------- Sitios importantes (6) ----------
  // De OpenStreetMap (data/sitios.json, tools/actualizar_sitios.py): solo para buscarlos por su nombre
  // (o por sus otros nombres), sin dibujarlos en el mapa. Se descarga al empezar a escribir.
  let sitesData = null, sitesPending = null;
  function ensureSites() {
    if (sitesData) return Promise.resolve(sitesData);
    if (!sitesPending) {
      sitesPending = fetch("data/sitios.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((d) => (sitesData = d.sitios.map(([name, la, lo, ty, extra], i) => ({
          i, name, ll: [la / 1e5, lo / 1e5], type: d.tipos[ty], key: norm(name), alt: norm(extra || ""),
        }))))
        .catch((e) => { sitesPending = null; throw e; });
    }
    return sitesPending;
  }
  // Cada palabra escrita es el principio de alguna palabra del nombre (o de sus otros nombres).
  function matchSites(q, limit = 5) {
    if (!sitesData) return [];
    const tokens = norm(q).split(" ").filter(Boolean);
    if (!tokens.length) return [];
    const starts = (key, tk) => key.startsWith(tk) || key.includes(` ${tk}`);
    const out = [];
    for (const s of sitesData) {
      const inName = tokens.every((tk) => starts(s.key, tk));
      if (!inName && !tokens.every((tk) => starts(s.key, tk) || starts(s.alt, tk))) continue;
      out.push({ s, score: (inName ? 0 : 2) + (s.key.startsWith(tokens[0]) ? 0 : 1) });
    }
    out.sort((a, b) => a.score - b.score || (me ? haversine(me, a.s.ll) - haversine(me, b.s.ll) : 0) || a.s.name.localeCompare(b.s.name, "es"));
    return out.slice(0, limit).map((x) => x.s);
  }
  function siteItem(s, tokens) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-site="${s.i}">
      <span class="name">${highlight(s.name, tokens)}</span>
      <span class="sub">${esc(t(`site_${s.type}`))}</span>
      ${me ? `<span class="dist">${fmtDist(haversine(me, s.ll))}</span>` : ""}
    </button>`;
    return li;
  }

  function lineItem(code, nameHtml) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-line="${esc(code)}" class="line-row">
      <span class="badge"${lineStyle(code)}>${esc(code)}</span>
      <span class="name">${nameHtml || esc(lines[code].nombre)}</span>
    </button>`;
    return li;
  }
  function groupHead(text) {
    const li = document.createElement("li");
    li.className = "group-head";
    li.textContent = text;
    return li;
  }

  // Elementos de "Buscadas recientemente" (en el buscador y en Desde/Hasta).
  function recentItems(opts = {}) {
    const items = [];
    recents.forEach((r, k) => {
      if (r.id) {
        const s = byId.get(r.id);
        if (s) items.push(stopItem(s, { noLines: opts.noLines, dist: me ? haversine(me, s.ll) : null }));
        return;
      }
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" data-recent="${k}">
        <span class="name">${esc(r.label)}</span>
        <span class="sub">${esc(r.site ? t(`site_${r.site}`) : t("fav_address"))}</span>
        ${me ? `<span class="dist">${fmtDist(haversine(me, r.ll))}</span>` : ""}
      </button>`;
      items.push(li);
    });
    if (!items.length) return [];
    const head = document.createElement("li");
    head.className = "group-head recent-head";
    head.innerHTML = `<span>${esc(t("recent_title"))}</span><button type="button" class="recent-clear" data-recent-clear="1">${esc(t("recent_clear"))}</button>`;
    return [head, ...items];
  }
  function renderRecent() { fillList(recentItems(), ""); }

  function renderLines() {
    if (!lines) { fillList([], t("loading_lines")); return; }
    const items = Object.keys(lines).map((code) => lineItem(code));
    fillList(items, items.length ? "" : t("lines_error"));
  }

  const TABS = ["near", "fav", "lines"];
  function render() {
    const q = $("#q").value.trim();
    if (q) { mode = "search"; renderSearch(q); return; }
    if (document.activeElement === $("#q") && !location.hash && recents.length) { mode = "recent"; renderRecent(); return; }
    if (mode === "search" || mode === "recent") mode = TABS.find((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true") || "near";
    if (mode === "fav") renderFav();
    else if (mode === "lines") renderLines();
    else renderNear();
  }

  function setTab(which) {
    TABS.forEach((t) => $(`#tab-${t}`).setAttribute("aria-selected", t === which));
    mode = which;
    render();
  }

  // ---------- Ubicación ----------
  function getPosition(onOk) {
    if (!("geolocation" in navigator)) { toast(t("geo_unsupported")); return; }
    const btn = $("#locate");
    btn.classList.add("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.classList.remove("busy");
        me = [pos.coords.latitude, pos.coords.longitude];
        const icon = L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] });
        if (meMarker) meMarker.setLatLng(me); else meMarker = L.marker(me, { icon, interactive: false, keyboard: false }).addTo(map);
        onOk(me);
      },
      (err) => {
        btn.classList.remove("busy");
        toast(err.code === 1 ? t("geo_denied") : t("geo_error"));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  // Lejos de Vigo (más de 25 km del centro): no hay paradas ni calles que usar.
  const farFromVigo = (ll) => haversine(ll, VIGO) > 25000;

  function locate() {
    // En "Cómo llegar" solo se centra el mapa en tu posición, sin salir de la vista;
    // si estás lejos de Vigo, se avisa y el mapa no se mueve.
    if (tripOpen()) {
      getPosition((ll) => { if (farFromVigo(ll)) toast(t("geo_far_trip")); else focusOn(ll, 16); });
      return;
    }
    getPosition(() => {
        if (location.hash) navigate("");
        $("#q").value = "";
        setTab("near");
        if (farFromVigo(me)) {
          toast(t("geo_far"));
          const [n] = nearest(me, 1);
          if (n) focusOn(n.s.ll, 14);
        } else {
          focusOn(me, 16);
        }
    });
  }

  // ---------- Navegación ----------
  // El estado vive en la dirección: "" inicio, "#5660" parada, "#linea/18A" línea, "#ir/A/B" cómo llegar.
  // Así el botón Atrás del móvil y los enlaces compartidos funcionan solos.
  function navigate(hash, { replace = false } = {}) {
    const url = hash ? `#${hash}` : location.pathname + location.search;
    if (replace || !hash) history.replaceState({ d: 0 }, "", url);
    else history.pushState({ d: ((history.state && history.state.d) || 0) + 1 }, "", url);
    route();
  }
  function goBack() {
    if (history.state && history.state.d > 0) history.back();   // popstate llama a route()
    else navigate("", { replace: true });
  }
  function route() {
    if (!stops.length) return;
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === "ir" || h.startsWith("ir/")) { showTrip(h); return; }
    if (h === "info") { showInfo(); return; }
    if (h.startsWith("horario/") && byId.has(h.slice(8))) { showSched(h.slice(8)); return; }
    if (h.startsWith("dir/") && showPlace(h.slice(4))) return;
    if (h.startsWith("linea/")) {
      // #linea/18A, #linea/18A/5660 (abierta desde esa parada: se ve el próximo bus hacia ella) o
      // #linea/A/14225/<letrero>: solo los viajes con ese letrero, como si fueran una línea aparte.
      const [code, from, ...rest] = h.slice(6).split("/");
      if (!lines) return;                      // se reintenta al cargar las líneas
      if (lines[code]) { showLine(code, byId.has(from) ? from : null, byId.has(from) && rest.length ? rest.join("/") : null); return; }
      toast(t("no_line", { code }));
    } else if (h && byId.has(h)) {
      showStop(h); return;
    } else if (h) {
      toast(t("no_stop", { id: h }));
    }
    showHome();
  }
  addEventListener("popstate", route);

  function showView(id) {
    ["home", "line", "stop", "trip", "place", "info", "sched"].forEach((v) => ($(`#${v}`).hidden = v !== id));
    panel.dataset.view = id;
    if (id !== "trip") leaveTrip();
    if (id !== "place") leavePlace();
  }

  function leaveStop() {
    if (!current) return;
    current = null;
    clearTimeout(refreshTimer);
    if (fetchCtl) fetchCtl.abort();
    selRing.remove();
  }

  function showHome() {
    leaveStop();
    clearLine();
    showView("home");
    if (!isDesktop() && panel.dataset.state !== "full") panel.dataset.state = "peek";
    document.title = "Próximo Vitrasa";
    render();
  }

  // ---------- Línea iluminada ----------
  function clearLine() {
    if (!active) return;
    const was = active.stops;
    active = null;
    stopTrack();
    lineGroup.clearLayers();
    selRing.remove();
    updateStopVisibility();
    stops.forEach((s) => { s.marker.setOpacity(1).setZIndexOffset(0); if (was.has(s.id)) refreshIcon(s); });
  }

  function drawLine() {
    const l = lines[active.code];
    lineGroup.clearLayers();
    // Solo el sentido elegido: su trazado y sus paradas.
    const prev = active.stops;
    const dir = l.sentidos[active.dir];
    const v = active.variant && active.variant.main ? active.variant : null;
    active.stops = new Set(v ? [...v.main, ...v.extra] : [...dir.paradas, ...(dir.otras || [])]);
    updateStopVisibility();
    stops.forEach((s) => {
      const on = active.stops.has(s.id);
      s.marker.setOpacity(on ? 1 : 0.12).setZIndexOffset(on ? 500 : 0);
      if (on || prev.has(s.id)) refreshIcon(s);
    });
    // Variante: su recorrido pasando por sus paradas (y, más fino, el de sus viajes distintos).
    if (v) {
      v.others.forEach((ids) => thinStroke(pathThrough(dir, ids), l.color));
      lineStroke(pathThrough(dir, v.main), l.color);
      return;
    }
    // Trazado con borde para que se vea sobre cualquier fondo.
    // Ramales (solo algunos viajes): trazo continuo más fino, debajo del recorrido principal.
    (dir.ramales || []).forEach((r, k) => {
      const rp = decodePolyline(r);
      L.polyline(rp, { renderer, color: "#13222C", weight: 7, opacity: 0.25, interactive: false }).addTo(lineGroup);
      L.polyline(rp, { renderer, color: "#FFFFFF", weight: 6, opacity: 1, interactive: false }).addTo(lineGroup);
      L.polyline(rp, { renderer, color: l.color, weight: 3.5, opacity: 0.9, interactive: false, lineCap: "round" }).addTo(lineGroup);
    });
    lineStroke(decodePolyline(dir.trazado), l.color);
  }
  function thinStroke(rp, color) {
    L.polyline(rp, { renderer, color: "#13222C", weight: 7, opacity: 0.25, interactive: false }).addTo(lineGroup);
    L.polyline(rp, { renderer, color: "#FFFFFF", weight: 6, opacity: 1, interactive: false }).addTo(lineGroup);
    L.polyline(rp, { renderer, color, weight: 3.5, opacity: 0.9, interactive: false, lineCap: "round" }).addTo(lineGroup);
  }
  // Paradas de una variante (los viajes de esa línea y sentido con un letrero), del horario: la
  // secuencia del recorrido con más viajes que pasa por la parada de origen; las de sus otros
  // recorridos, aparte ("solo algunos viajes").
  function loadVariant(act) {
    PLAN.load().then((plan) => {
      if (active !== act || !act.variant) return;
      const r = norm(act.variant.ruta);
      const fi = plan.index.get(act.from);
      const pats = plan.pats.filter((pt) => pt.l === act.code && pt.s === act.dir && pt.h && pt.h.some((x) => norm(x) === r))
        .sort((a, b) => (b.p.includes(fi) - a.p.includes(fi)) || (b.dep.length - a.dep.length));
      if (!pats.length) return;   // letrero que no está en el horario: la línea entera
      const ids = (pt) => pt.p.map((i) => plan.ids[i]).filter((id) => byId.has(id));
      const main = ids(pats[0]);
      const others = pats.slice(1).map(ids).filter((x) => x.length > 1);
      const seen = new Set(main);
      const extra = [];
      others.forEach((x) => x.forEach((id) => { if (!seen.has(id)) { seen.add(id); extra.push(id); } }));
      Object.assign(act.variant, { main, extra, others });
      renderLineStops();
      drawLine();
      drawBus();
    }).catch(() => {});
  }
  function lineStroke(pts, color) {
    L.polyline(pts, { renderer, color: "#13222C", weight: 11, opacity: 0.35, interactive: false }).addTo(lineGroup);
    L.polyline(pts, { renderer, color: "#FFFFFF", weight: 9, opacity: 1, interactive: false }).addTo(lineGroup);
    L.polyline(pts, { renderer, color, weight: 6, opacity: 1, interactive: false, lineCap: "round" }).addTo(lineGroup);
  }
  // Trazados (-1 principal, k ramal k) que hace un bus con este letrero, o null si no se sabe.
  function branchesOf(d, ruta) {
    if (!d || !d.trazados || !ruta) return null;
    const r = norm(String(ruta));
    const k = Object.keys(d.trazados).find((x) => norm(x) === r);
    return k ? d.trazados[k] : null;
  }

  // ¿Se ve este punto en la zona del mapa que no tapa el panel?
  function inView(ll) {
    const p = map.latLngToContainerPoint(ll), size = map.getSize(), m = 24;
    const left = isDesktop() ? panel.getBoundingClientRect().right : 0;
    const bottom = isDesktop() ? size.y : size.y - panelCover();
    return p.x > left + m && p.x < size.x - m && p.y > m && p.y < bottom - m;
  }

  // Encuadra unos puntos en la zona del mapa que no tapa el panel.
  // Altura que tapa el panel en el móvil, según su estado final (no la de mitad de animación).
  function panelCover() {
    const st = panel.dataset.state;
    return st === "full" ? innerHeight - 56 : st === "stop" ? innerHeight * 0.64 : st === "min" ? 92 : Math.max(260, innerHeight * 0.46);
  }
  function fitPoints(pts, maxZoom) {
    const r = panel.getBoundingClientRect();
    const opts = isDesktop()
      ? { paddingTopLeft: [r.right + 24, 24], paddingBottomRight: [24, 24] }
      : { paddingTopLeft: [16, 16], paddingBottomRight: [16, panelCover() + 16] };
    map.fitBounds(L.latLngBounds(pts), { ...opts, maxZoom });
  }

  function fitLine() {
    const l = lines[active.code];
    const d = l.sentidos[active.dir];
    fitPoints([d.trazado, ...(d.ramales || [])].flatMap(decodePolyline), 16);
  }

  function showLine(code, from = null, variant = null) {
    leaveStop();
    const changed = !active || active.code !== code || active.from !== from || (active.variant ? active.variant.ruta : null) !== variant;
    if (changed) {
      clearLine();
      // Abierta desde una parada: el sentido que pasa por ella (si pasan los dos, el de la fila tocada).
      const dirWith = from ? dirThrough(lines[code], from, variant || lineRuta) : -1;
      active = { code, dir: Math.max(0, dirWith), stops: new Set(), from, fromDir: dirWith,
        variant: variant && dirWith >= 0 ? { ruta: variant } : null };
      if (active.variant) loadVariant(active);
    }
    const l = lines[code];
    const v = active.variant;
    showView("line");
    const badge = $("#line-badge");
    badge.textContent = code;
    badge.style.setProperty("--lc", l.color);
    badge.style.setProperty("--lt", l.texto);
    // Variante (un letrero): su destino como título y, en lugar de los sentidos, "ver toda la línea".
    $("#line-name").textContent = v ? t("towards", { dest: titleCase(v.ruta) }) : l.nombre;
    $("#line-whole").hidden = !v;
    // Desde una parada, solo los sentidos que pasan por ella (pestañas solo si pasan los dos).
    const dirs = l.sentidos.map((d, i) => i).filter((i) => !from || l.sentidos[i].paradas.includes(from) || (l.sentidos[i].otras || []).includes(from));
    $("#line-dirs").hidden = !!v || dirs.length < 2;
    $("#line-dirs").innerHTML = dirs.map((i) =>
      `<button role="tab" type="button" data-dir="${i}" aria-selected="${i === active.dir}">${esc(t("towards", { dest: l.sentidos[i].destino }))}</button>`).join("");
    renderLineStops();
    document.title = `${t("line_n", { code })} · Próximo Vitrasa`;
    if (!isDesktop()) panel.dataset.state = "peek";
    drawLine();
    if (changed) {
      const origin = from && byId.get(from);
      // Desde una parada: un poco más alejado que la ficha, pero sin encuadrar la línea entera;
      // el usuario aleja el mapa si quiere verla completa.
      if (origin) { focusOn(origin.ll, LINE_STOPS_ZOOM); selRing.setLatLng(origin.ll).addTo(map); }
      else fitLine();
      startTrack();
    } else drawBus();
    renderBusCard();
    lineRuta = null;
  }

  // ¿Va el bus con letrero "ruta" (dato de la API) en este sentido? Cada sentido tiene su
  // destino principal y otros letreros de algunos viajes ("Xestoso por Hospital"…).
  function goesTo(d, ruta) {
    if (!d || !ruta) return false;
    const r = norm(String(ruta));
    return norm(d.destino) === r || (d.letreros || []).some((x) => norm(x) === r);
  }

  // Sentido de la línea que pasa por una parada; si pasan varios, el que va hacia "ruta".
  function dirThrough(l, id, ruta) {
    const idx = l.sentidos.map((d, i) => (d.paradas.includes(id) || (d.otras || []).includes(id) ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 1 && ruta) {
      const hit = idx.find((i) => goesTo(l.sentidos[i], ruta));
      if (hit != null) return hit;
    }
    return idx.length ? idx[0] : -1;
  }

  // ---------- Próximo bus hacia la parada ----------
  // Con la línea abierta desde una parada, se pide cada 30 s la llegada a esa parada y se dibuja
  // el bus más próximo sobre el trazado: distancia de la parada a lo largo del recorrido menos los
  // metros que da la API. Entre actualizaciones avanza a su velocidad media (metros / minutos).
  const BUS = window.PV_BUS;
  let track = null;   // { stop, code, dir, loc, est, at, state, timer, tick, ctl, marker }

  function stopTrack() {
    if (!track) return;
    clearTimeout(track.timer);
    clearInterval(track.tick);
    if (track.ctl) track.ctl.abort();
    (track.markers || []).forEach((mk) => mk.remove());
    track = null;
    $("#line-bus").hidden = true;
  }

  function startTrack() {
    stopTrack();
    if (!BUS || !active || !active.from || active.fromDir < 0) return;
    const dir = lines[active.code].sentidos[active.fromDir];
    const loc = BUS.locateStop(dir, active.from, (id) => (byId.get(id) || {}).ll || [0, 0]);
    if (!loc) return;
    track = { stop: active.from, code: active.code, dir: active.fromDir, loc, est: null, at: 0, state: "loading" };
    // Recién venidos de la ficha de esa parada: se reutilizan sus datos en vez de pedirlos otra vez.
    const age = lastUpdate ? Date.now() - lastUpdate.getTime() : Infinity;
    if (lastArrivals && lastArrivalsId === track.stop && age < REFRESH_MS - 5000) {
      applyEstimates(lastArrivals, lastUpdate.getTime());
      track.timer = setTimeout(fetchTrack, REFRESH_MS - age);
    } else fetchTrack();
    track.tick = setInterval(() => { drawBus(); renderBusCard(); }, 1000);
  }

  async function fetchTrack() {
    const tr = track;
    if (!tr) return;
    clearTimeout(tr.timer);
    if (tr.ctl) tr.ctl.abort();
    const ctl = (tr.ctl = new AbortController());
    const timeout = setTimeout(() => ctl.abort(), 10000);
    try {
      const data = await fetchEstimates(tr.stop, ctl.signal);
      if (track !== tr) return;
      applyEstimates(data.estimaciones || [], Date.now());
    } catch {
      if (track !== tr || ctl.signal.aborted && tr.ctl !== ctl) return;
      if (!tr.est) { tr.state = "error"; renderBusCard(); }
    } finally {
      clearTimeout(timeout);
    }
    if (track === tr) tr.timer = setTimeout(() => { if (!document.hidden) fetchTrack(); }, REFRESH_MS);
  }

  // Elige el bus más próximo de la línea (y del destino, si en la parada paran los dos sentidos).
  function applyEstimates(list, at) {
    const tr = track;
    const l = lines[tr.code];
    let mine = list.filter((e) => normLine(e.linea) === tr.code && !isNaN(Number(e.minutos)));
    const both = l.sentidos.filter((d) => d.paradas.includes(tr.stop) || (d.otras || []).includes(tr.stop)).length > 1;
    // Variante: solo los buses con su letrero.
    const v = active && active.code === tr.code && active.variant;
    if (v) mine = mine.filter((e) => norm(String(e.ruta || "")) === norm(v.ruta));
    else if (both) {
      const same = mine.filter((e) => goesTo(l.sentidos[tr.dir], e.ruta));
      if (same.length) mine = same;
    }
    mine.sort((a, b) => Number(a.minutos) - Number(b.minutos));
    // Posición del bus: sobre el trazado de su letrero si es un único ramal que pasa por la parada.
    const d = l.sentidos[tr.dir];
    const only = mine[0] ? branchesOf(d, mine[0].ruta) : null;
    tr.loc = tr.baseLoc = tr.baseLoc || tr.loc;
    if (only && only.length === 1 && only[0] >= 0 && d.ramales[only[0]]) {
      const sh = BUS.prepare(BUS.decode(d.ramales[only[0]]));
      const p = BUS.project(sh, byId.get(tr.stop).ll);
      if (p.off < 60) tr.loc = { shape: sh, along: p.along, off: p.off, branch: only[0] };
    }
    tr.ests = mine;
    tr.est = mine[0] || null;
    tr.at = at;
    tr.state = tr.est ? "ok" : "none";
    drawBus();
    renderBusCard();
    // La primera vez que se sabe dónde va, si queda fuera de la vista se encuadran bus y parada.
    const b = busNow();
    if (!tr.framed && b && b.state === "route" && active && active.dir === tr.dir) {
      tr.framed = true;
      const s = byId.get(tr.stop);
      const frame = () => { if (track === tr && s && !inView(b.ll)) fitPoints([b.ll, s.ll], LINE_STOPS_ZOOM); };
      // Si el mapa aún se está moviendo hacia la parada, se espera a que termine.
      if (map._animatingZoom || (map._panAnim && map._panAnim._inProgress)) map.once("moveend", frame); else frame();
    }
  }

  // Situación de un bus ahora mismo (avanza entre actualizaciones); i = 0, el más próximo.
  function busNow(i = 0) {
    const est = track && (track.ests || [])[i];
    if (!est) return null;
    const min = (Date.now() - track.at) / 60000;
    return BUS.busAt(track.loc, est, min);
  }

  const BUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a2.5 2.5 0 0 1 2.5 2.5v10.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V6A2.5 2.5 0 0 1 7 3.5z"/><rect x="6" y="17" width="3" height="3" rx="1"/><rect x="15" y="17" width="3" height="3" rx="1"/><rect class="w" x="6.6" y="6.2" width="10.8" height="5" rx="1"/><circle class="w" cx="8" cy="14.4" r="1.1"/><circle class="w" cx="16" cy="14.4" r="1.1"/></svg>';

  // Bus en vivo en el mapa: destacado (anillo y pulso del color de la línea) y, a su lado, lo que
  // le falta para llegar a la parada. Lo usan la línea abierta desde una parada y Cómo llegar.
  function busMarker(color, texto, ll) {
    return L.marker(ll, { keyboard: false, interactive: false, zIndexOffset: 900, icon: L.divIcon({
      className: "bus-pin", iconSize: [40, 40], iconAnchor: [20, 20],
      html: `<span class="bus-dot" style="--lc:${color};--lt:${texto}"><span class="bus-arrow"></span>${BUS_ICON}</span><span class="bus-eta"></span>`,
    }) });
  }
  function placeBus(marker, s, est, at) {
    marker.setLatLng(s.ll);
    if (!map.hasLayer(marker)) marker.addTo(map);
    const el = marker.getElement();
    if (!el) return;
    el.querySelector(".bus-arrow").style.transform = `rotate(${Math.round(s.bearing)}deg)`;
    const m = Math.round(Number(est.minutos) - (Date.now() - at) / 60000);
    el.querySelector(".bus-eta").textContent = m <= 0 ? t("arriving") : `${m} ${t("min")}`;
  }

  function drawBus() {
    const tr = track;
    if (!tr) return;
    tr.markers = tr.markers || [];
    // Todos los buses que la API da camino de la parada, en el sentido que va hacia ella.
    (tr.ests || []).forEach((est, i) => {
      const b = busNow(i);
      let mk = tr.markers[i];
      if (!b || b.state !== "route" || !active || active.dir !== tr.dir) { if (mk) mk.remove(); return; }
      if (!mk) { const l = lines[tr.code]; mk = tr.markers[i] = busMarker(l.color, l.texto, b.ll); }
      placeBus(mk, b, est, tr.at);
    });
    tr.markers.slice((tr.ests || []).length).forEach((mk) => mk.remove());
  }

  // Próximo paso según el horario por la parada del seguimiento, de esa línea y sentido (y, en una
  // variante, con su letrero): segundos desde la medianoche de hoy, null si no hay en 6 h o
  // undefined si aún no han cargado los horarios.
  function nextScheduled(tr) {
    if (!stopPlan) { PLAN.load().then((pl) => { stopPlan = pl; renderBusCard(); }).catch(() => {}); return undefined; }
    const si = stopPlan.index.get(tr.stop);
    if (si == null) return null;
    const v = active && active.variant ? norm(active.variant.ruta) : null;
    const now = new Date();
    const nowS = (now - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 1000;
    const x = stopPlan.upcoming(si, now, 6 * 3600, 0).find((p) => {
      const pt = stopPlan.pats[p.pat];
      return pt.l === tr.code && pt.s === tr.dir && p.at >= nowS - 30 && (!v || (pt.h && pt.h.some((h) => norm(h) === v)));
    });
    return x ? x.at : null;
  }

  function renderBusCard() {
    const card = $("#line-bus");
    const tr = track;
    if (!tr || !active) { card.hidden = true; return; }
    const l = lines[tr.code];
    const s = byId.get(tr.stop);
    card.style.setProperty("--lc", l.color);
    card.style.setProperty("--lt", l.texto);
    if (active.dir !== tr.dir) { card.hidden = true; return; }   // no debería pasar: solo se ven sentidos que pasan por la parada
    const b = busNow();
    let main, sub = "";
    if (tr.state === "loading") main = "…";
    else if (tr.state === "error" || tr.state === "none") {
      // Sin bus en vivo: el próximo paso según el horario publicado.
      const at = nextScheduled(tr);
      if (at) {
        main = esc(t(tr.state === "error" ? "card_sched_err" : "card_sched"));
        sub = `<span class="eta sched"><b>${esc(hhmm(at))}</b></span>`;
      } else main = esc(t(tr.state === "error" ? "times_error" : "bus_none"));
    } else if (b && b.state === "depot") {
      const m = Math.max(0, Math.round(Number(tr.est.minutos) - (Date.now() - tr.at) / 60000));
      main = `${esc(t("bus_depot"))}`;
      sub = `<span class="eta"><b>${m}</b><span>${esc(t("min"))}</span></span>`;
    } else if (b) {
      const m = Math.round(Number(tr.est.minutos) - (Date.now() - tr.at) / 60000);
      main = `${esc(fmtDist(b.left))} · ${esc(t("bus_estimated"))}`;
      sub = m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>`
                   : `<span class="eta"><b>${m}</b><span>${esc(t("min"))}</span></span>`;
    } else main = esc(t("bus_none"));
    card.innerHTML = `<span class="bus-dot">${BUS_ICON}</span>
      <span class="what"><b>${esc(t("bus_title", { stop: s ? s.name : tr.stop }))}</b><small>${main}</small></span>${sub}`;
    card.hidden = false;
  }

  // Tocar la tarjeta: muestra el bus y la parada en el mapa (volviendo a su sentido si hace falta).
  $("#line-bus").addEventListener("click", () => {
    const tr = track;
    if (!tr) return;
    if (active.dir !== tr.dir) {
      active.dir = tr.dir;
      $("#line-dirs").querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", Number(x.dataset.dir) === tr.dir));
      renderLineStops();
      drawLine();
      drawBus();
    }
    const s = byId.get(tr.stop);
    const b = busNow();
    if (b && b.state === "route") fitPoints([b.ll, s.ll], 17);
    else if (s) focusOn(s.ll, LINE_STOPS_ZOOM);
  });

  function renderLineStops() {
    const l = lines[active.code];
    const dir = l.sentidos[active.dir];
    const v = active.variant && active.variant.main ? active.variant : null;
    const list = $("#line-stops");
    list.style.setProperty("--lc", l.color);
    const item = (s) => stopItem(s, { dist: me ? haversine(me, s.ll) : null, noLines: true });
    const items = (v ? v.main : dir.paradas).map((id) => byId.get(id)).filter(Boolean).map(item);
    const extra = (v ? v.extra : dir.otras || []).map((id) => byId.get(id)).filter(Boolean);
    if (extra.length) {
      const head = groupHead(t("some_trips"));
      head.classList.add("branch-head");
      items.push(head, ...extra.map((s) => { const li = item(s); li.classList.add("branch"); return li; }));
    }
    list.replaceChildren(...items);
    $("#line-stops").scrollTop = 0;
  }

  // ---------- Ficha de parada ----------
  function showStop(id, { repaint = false } = {}) {
    const s = byId.get(id);
    if (current !== s) leaveStop();
    if (!repaint) clearLine();   // la ficha de parada se ve sin la línea anterior encima
    current = s;
    showView("stop");
    $("#stop-name").textContent = s.name;
    $("#stop-id").innerHTML = esc(t("stop_n", { id: "\u0000" })).replace("\u0000", `<strong>${esc(s.id)}</strong>`);
    $("#stop-lines").innerHTML = s.lines.map((l) => lineChip(l)).join("");
    $("#stop-dist").textContent = me ? ` · ${fmtDist(haversine(me, s.ll))}, ${t("walk", { n: walkMin(haversine(me, s.ll)) })}` : "";
    $("#infobus").href = INFOBUS_URL(s.id);
    updateFavBtn();
    document.title = `${s.name} · Próximo Vitrasa`;
    if (repaint) return;           // solo volver a escribir los textos (cambio de idioma)
    if (!isDesktop()) panel.dataset.state = "stop";
    selRing.setLatLng(s.ll).addTo(map);
    focusOn(s.ll);
    loadArrivals(true);
    // Horarios publicados (para el horario previsto y el retraso): en segundo plano.
    PLAN.load().then((pl) => {
      stopPlan = pl;
      if (current === s && lastArrivalsId === s.id && lastUpdate) renderArrivals(lastArrivals);
      else if (current === s && arrivalsFailed) renderArrivals(null);
    }).catch(() => {});
  }

  function updateFavBtn() {
    const on = current && !!favStop(current.id);
    const b = $("#fav");
    b.setAttribute("aria-pressed", !!on);
    b.setAttribute("aria-label", on ? t("fav_remove") : t("fav_add"));
  }

  function skeleton() {
    return Array.from({ length: 4 }, () =>
      `<div class="arrival skeleton" aria-hidden="true"><span class="badge">00</span><span class="route"><b>&nbsp;</b></span><span class="eta"><b>00</b></span></div>`
    ).join("");
  }

  // Pide los próximos buses de una parada a la API del Concello.
  async function fetchEstimates(id, signal) {
    const url = `${API_URL}?id=${encodeURIComponent(id)}&ttl=5&tipo=TRANSPORTE-ESTIMACION-PARADA`;
    const r = await fetch(url, { signal, cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    // La API puede responder en Latin-1 sin avisar: si no es UTF-8 válido, se lee como Windows-1252
    // para que las tildes y la ñ no salgan como "�".
    const buf = await r.arrayBuffer();
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { text = new TextDecoder("windows-1252").decode(buf); }
    return JSON.parse(text);
  }

  async function loadArrivals(first) {
    const s = current;
    if (!s) return;
    clearTimeout(refreshTimer);
    if (fetchCtl) fetchCtl.abort();
    const ctl = (fetchCtl = new AbortController());
    const seq = ++reqSeq;
    const box = $("#arrivals");
    if (first) { box.innerHTML = skeleton(); lastUpdate = null; showUpdated(); }
    const timeout = setTimeout(() => ctl.abort(), 10000);
    try {
      const data = await fetchEstimates(s.id, ctl.signal);
      if (seq !== reqSeq) return;
      // El nombre oficial sustituye a los genéricos tipo "Parada 1234".
      const official = data.parada && data.parada[0] && data.parada[0].nombre;
      if (official && /^Parada \d/.test(s.name)) $("#stop-name").textContent = titleCase(official);
      lastArrivalsId = s.id;
      renderArrivals(data.estimaciones || []);
      lastUpdate = new Date();
      showUpdated();
    } catch (e) {
      if (seq !== reqSeq) return;
      renderArrivals(null);   // sin respuesta: aviso y, debajo, el horario previsto
      lastUpdate = null;
      showUpdated();
    } finally {
      clearTimeout(timeout);
    }
    if (seq === reqSeq && current === s) refreshTimer = setTimeout(() => { if (!document.hidden) loadArrivals(false); }, REFRESH_MS);
  }

  let lastUpdate = null;
  let lastArrivals = null;          // para volver a pintar al cambiar de idioma
  let lastArrivalsId = null;        // parada de esos datos (los reutiliza el bus en el mapa)
  function showUpdated() {
    $("#updated").textContent = lastUpdate
      ? t("updated", { time: lastUpdate.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }) : "";
  }

  let stopPlan = null;               // horarios publicados (data/viajes.json), cuando han cargado
  let arrivalsFailed = false;        // la última consulta de la API falló
  const SCHED_AHEAD = 90 * 60;       // horario previsto: los pasos de la próxima hora y media

  // Sentido de una línea al que va un bus de la API en esta parada (null si no se sabe).
  function liveDir(id, linea, ruta) {
    const l = lines && lines[linea];
    if (!l) return null;
    const idx = l.sentidos.map((d, i) => (d.paradas.includes(id) || (d.otras || []).includes(id) ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 1) return idx[0];
    const hit = idx.find((i) => goesTo(l.sentidos[i], ruta));
    return hit == null ? null : hit;
  }

  // Retraso o adelanto de un bus en vivo frente a su paso programado (20). Solo si el emparejamiento
  // no tiene duda: pasos de esa línea y sentido separados al menos 15 min y el bus claramente más
  // cerca de uno de ellos. Devuelve minutos (+ tarde, − antes) o null.
  function delayOf(passes, expected, used) {
    let i = -1, best = Infinity;
    passes.forEach((p, k) => { const d = Math.abs(expected - p.at); if (d < best) { best = d; i = k; } });
    if (i < 0 || used.has(i)) return null;
    const gap = Math.min(i > 0 ? passes[i].at - passes[i - 1].at : Infinity, i < passes.length - 1 ? passes[i + 1].at - passes[i].at : Infinity);
    const diff = expected - passes[i].at;
    if (gap < 15 * 60 || Math.abs(diff) > Math.min(gap / 2 - 120, 15 * 60)) return null;
    used.add(i);
    return Math.round(diff / 60);
  }
  const delayHtml = (d) => d == null ? "" : Math.abs(d) <= 1 ? `<small class="ontime">${esc(t("delay_on"))}</small>`
    : d > 0 ? `<small class="late">${esc(t("delay_late", { n: d }))}</small>` : `<small class="early">${esc(t("delay_early", { n: -d }))}</small>`;

  // list: estimaciones de la API ([] si no da ninguna; null si la consulta falló).
  function renderArrivals(list) {
    lastArrivals = list;
    arrivalsFailed = list == null;
    const box = $("#arrivals");
    const s = current;
    const now = new Date();
    const nowS = (now - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 1000;
    // Horario publicado de esta parada (si ya ha cargado): pasos de hace 30 min a dentro de 3 h.
    const si = stopPlan && s ? stopPlan.index.get(s.id) : null;
    const passes = si != null ? stopPlan.upcoming(si, now, 3 * 3600, 30 * 60) : [];
    const passesOf = new Map();
    passes.forEach((p) => { const k = `${p.line}|${p.dir}`; if (!passesOf.has(k)) passesOf.set(k, []); passesOf.get(k).push(p); });

    // En vivo: agrupa por línea y destino; el próximo y el siguiente.
    const groups = new Map();
    const covered = new Set();   // líneas y sentidos con algún bus en vivo (no se repiten según horario)
    (list || []).forEach((b) => {
      const linea = normLine(b.linea);
      const ruta = titleCase(String(b.ruta || ""));
      const k = `${linea}|${ruta}`;
      if (!groups.has(k)) groups.set(k, { linea, ruta, raw: String(b.ruta || "").trim(), buses: [], dir: s ? liveDir(s.id, linea, b.ruta) : null });
      groups.get(k).buses.push(Number(b.minutos));
    });
    const rows = [];
    for (const g of groups.values()) {
      const mins = g.buses.filter((m) => !isNaN(m)).sort((a, b) => a - b);
      if (!mins.length) continue;
      if (g.dir != null) covered.add(`${g.linea}|${g.dir}`);
      else if (lines && lines[g.linea]) lines[g.linea].sentidos.forEach((_, i) => covered.add(`${g.linea}|${i}`));
      // Retraso: frente a los viajes del horario con su mismo letrero (si los hay; si no, la línea y sentido).
      const all = g.dir != null ? passesOf.get(`${g.linea}|${g.dir}`) || [] : [];
      const rn = norm(g.raw || "");
      const same = all.filter((p) => { const h = stopPlan.pats[p.pat].h; return h && h.some((x) => norm(x) === rn); });
      const ps = same.length ? same : all;
      const delay = ps.length ? delayOf(ps, nowS + mins[0] * 60, new Set()) : null;
      rows.push({ live: true, linea: g.linea, ruta: g.ruta, raw: g.raw, sortMin: mins[0], mins, delay });
    }
    // Según horario (19): líneas y sentidos sin ningún bus en vivo, su próximo paso.
    for (const [k, ps] of passesOf) {
      if (covered.has(k)) continue;
      const next = ps.filter((p) => p.at >= nowS - 30 && p.at <= nowS + SCHED_AHEAD);
      if (!next.length) continue;
      const [linea, dir] = [next[0].line, next[0].dir];
      const ln = lines && lines[linea];
      const ruta = ln && ln.sentidos[dir] ? ln.sentidos[dir].destino : "";
      rows.push({ live: false, linea, ruta, sortMin: (next[0].at - nowS) / 60, at: next.map((p) => p.at) });
    }
    rows.sort((a, b) => a.sortMin - b.sortMin);

    const err = list == null && s ? `<div class="state"><strong>${esc(t("times_error"))}</strong>
        ${esc(t("times_error_body", { infobus: "\u0000" })).replace("\u0000",
          `<a href="${INFOBUS_URL(s.id)}" target="_blank" rel="noopener">Infobus</a>`)}</div>` : "";
    if (!rows.length) {
      box.innerHTML = err || `<div class="state"><strong>${esc(t("empty"))}</strong> ${esc(t("empty_body"))}</div>`;
      return;
    }
    const onlySched = !rows.some((r) => r.live);
    const head = err || (onlySched ? `<p class="note">${esc(t("sched_only"))}</p>` : "");
    box.innerHTML = head + rows.map((g) => {
      let eta, sub;
      if (g.live) {
        const m = g.mins[0];
        eta = m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>`
                     : `<span class="eta"><b>${m}</b><span>${esc(t("min"))}</span></span>`;
        sub = delayHtml(g.delay) + (g.mins[1] != null ? `<small>${esc(t("next", { n: g.mins[1] }))}</small>` : "");
      } else {
        eta = `<span class="eta sched"><b>${esc(hhmm(g.at[0]))}</b></span>`;
        sub = `<small class="sched-tag">${esc(t("scheduled"))}${g.at[1] != null ? ` · ${esc(t("then_at", { time: hhmm(g.at[1]) }))}` : ""}</small>`;
      }
      // Toda la fila (número, destino y tiempo) abre la línea en el mapa.
      const known = lines && lines[g.linea];
      const tag = known ? "button" : "div";
      const attrs = known ? ` type="button" data-line="${esc(g.linea)}" data-ruta="${esc(g.ruta)}"${g.raw ? ` data-raw="${esc(g.raw)}"` : ""} title="${esc(t("see_line", { code: g.linea }))}"` : "";
      return `<${tag} class="arrival${g.live ? "" : " is-sched"}"${attrs}>
        <span class="badge"${lineStyle(g.linea)}>${esc(g.linea)}</span>
        <span class="route"><b>${esc(g.ruta)}</b>${sub}</span>
        ${eta}
      </${tag}>`;
    }).join("");
  }

  // ---------- Horarios de una parada (12 y 13) ----------
  // Los publicados por Vitrasa (data/viajes.json): por línea y sentido, primer y último paso,
  // frecuencia aproximada y todas las horas. Pestañas: laborable, sábado y domingo/festivo.
  let sched = null;   // { id, day }
  const HOLI = (d) => PLAN.isHoliday(d);
  // Tipo de día de hoy: "w" laborable, "6" sábado, "0" domingo o festivo.
  const todayType = (d = new Date()) => (HOLI(d) || d.getDay() === 0 ? "0" : d.getDay() === 6 ? "6" : "w");
  // Bit de los viajes de ese tipo de día: el laborable, el de hoy si lo es (y si no, el miércoles).
  const typeBit = (ty) => (ty === "w" ? 1 << (todayType() === "w" ? new Date().getDay() : 3) : 1 << Number(ty));
  const hhmm = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, "0")}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}`;
  function everyText(times) {
    // Mediana del tiempo entre pasos de 7 a 21 h (o del día entero, si no hay bastantes).
    const gaps = (ts) => ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
    let g = gaps(times.filter((x) => x >= 7 * 3600 && x <= 21 * 3600));
    if (g.length < 2) g = gaps(times);
    if (!g.length) return "";
    const m = Math.max(1, Math.round(g[g.length >> 1] / 60));
    return m < 60 ? t("every_min", { n: m }) : m % 60 ? t("every_h", { h: Math.floor(m / 60), m: m % 60 }) : t("every_h0", { h: m / 60 });
  }
  function showSched(id) {
    const s = byId.get(id);
    leaveStop();
    clearLine();
    showView("sched");
    if (!sched || sched.id !== id) sched = { id, day: todayType() };
    document.title = `${t("sched_title")} · ${s.name} · Próximo Vitrasa`;
    $("#sched-name").textContent = s.name;
    $("#sched-meta").textContent = t("stop_n", { id });
    if (!isDesktop()) panel.dataset.state = "full";
    selRing.setLatLng(s.ll).addTo(map);
    renderSched();
  }
  function renderSched() {
    if (!sched) return;
    document.querySelectorAll("#sched-days [data-day]").forEach((b) => b.setAttribute("aria-selected", b.dataset.day === sched.day));
    const box = $("#sched-list");
    box.innerHTML = `<p class="note">${esc(t("sched_loading"))}</p>`;
    const want = sched.id;
    Promise.all([PLAN.load(), linesReady]).then(([plan]) => {
      if (!sched || sched.id !== want || $("#sched").hidden) return;
      const si = plan.index.get(want);
      const passes = si == null ? [] : plan.stopPasses(si, typeBit(sched.day));
      // Líneas y sentidos que pasan por la parada algún día (para decir "no pasa" en los demás).
      const all = new Map();
      if (si != null) for (const [n, k] of plan.at[si]) { const pt = plan.pats[n]; if (k < pt.p.length - 1) all.set(`${pt.l}|${pt.s}`, { line: pt.l, dir: pt.s, times: [] }); }
      passes.forEach((p) => all.get(`${p.line}|${p.dir}`).times.push(p.t));
      const order = Object.keys(lines || {});
      const groups = [...all.values()].sort((a, b) => (!a.times.length - !b.times.length) || order.indexOf(a.line) - order.indexOf(b.line) || a.dir - b.dir);
      const date = new Date(`${plan.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
      const nowS = (Date.now() - new Date().setHours(0, 0, 0, 0)) / 1000;
      const isToday = sched.day === todayType();
      const html = groups.map((g) => {
        const ln = lines && lines[g.line];
        const dest = ln && ln.sentidos[g.dir] ? ln.sentidos[g.dir].destino : "";
        const head = `<span class="badge"${lineStyle(g.line)}>${esc(g.line)}</span>
          <span class="what"><b>${esc(t("towards", { dest }))}</b>`;
        if (!g.times.length) return `<div class="sched-line off"><summary>${head}<small>${esc(t("no_service"))}</small></span></summary></div>`;
        const ts = g.times;
        const meta = [t("first_last", { first: hhmm(ts[0]), last: hhmm(ts[ts.length - 1]) }), everyText(ts)].filter(Boolean).join(" · ");
        const hours = new Map();
        ts.forEach((x) => { const h = Math.floor(x / 3600); if (!hours.has(h)) hours.set(h, []); hours.get(h).push(x); });
        const rows = [...hours].map(([h, xs]) => `<dt>${String(h % 24).padStart(2, "0")}</dt><dd>${xs.map((x) =>
          `<span${isToday && x < nowS - 60 ? ' class="past"' : ""}>${String(Math.floor(x / 60) % 60).padStart(2, "0")}</span>`).join(" ")}</dd>`).join("");
        return `<details class="sched-line"><summary>${head}<small>${esc(meta)}</small></span>${CHEV}</summary><dl class="sched-hours">${rows}</dl></details>`;
      }).join("");
      box.innerHTML = (html || `<div class="state"><strong>${esc(t("sched_none"))}</strong></div>`) +
        `<p class="note">${esc(t("sched_note", { date }))}</p>`;
    }).catch(() => { if (sched && sched.id === want) box.innerHTML = `<div class="state"><strong>${esc(t("sched_error"))}</strong></div>`; });
  }
  $("#sched-days").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (!b || !sched || b.dataset.day === sched.day) return;
    sched.day = b.dataset.day;
    renderSched();
  });
  $("#sched-open").addEventListener("click", () => { if (current) navigate(`horario/${current.id}`); });
  $("#sched-back").addEventListener("click", goBack);


  function refreshNearDep() {
    clearTimeout(nearTimer);
    const box = document.querySelector(".near-dep-list");
    if (!box || !me || mode !== "near" || $("#home").hidden) return;
    if (document.hidden) { nearTimer = setTimeout(refreshNearDep, REFRESH_MS); return; }
    const near = nearest(me, 12).filter(({ d }) => d <= NEAR_DEP_M).slice(0, 6);
    if (!near.length) { box.innerHTML = `<p class="note">${esc(t("near_dep_none_stops"))}</p>`; return; }
    Promise.all(near.map(({ s }) => getLive(s.id))).then((res) => {
      const box2 = document.querySelector(".near-dep-list");
      if (!box2) return;
      const rows = [];
      res.forEach((e, k) => {
        if (!e.list) return;
        const { s, d } = near[k];
        const walk = walkMin(d * 1.25);
        const seen = new Set();
        e.list.forEach((x) => {
          const m = Number(x.minutos) - Math.round((Date.now() - e.at) / 60000);
          const code = normLine(x.linea), raw = String(x.ruta || "").trim();
          if (isNaN(m) || m < walk - 1) return;   // no da tiempo a llegar andando
          const key = `${code}|${norm(raw)}`;
          if (seen.has(key)) return;              // de cada línea y letrero, el próximo en esa parada
          seen.add(key);
          rows.push({ code, raw, ruta: titleCase(raw), m, s, walk });
        });
      });
      // De cada línea y letrero, solo en la parada donde sale antes.
      rows.sort((a, b) => a.m - b.m || a.walk - b.walk);
      const once = new Set();
      const top = rows.filter((r) => { const k = `${r.code}|${norm(r.raw)}`; if (once.has(k)) return false; once.add(k); return true; }).slice(0, NEAR_DEP_MAX);
      box2.innerHTML = top.length ? top.map((r) => {
        const eta = r.m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>` : `<span class="eta"><b>${r.m}</b><span>${esc(t("min"))}</span></span>`;
        const known = lines && lines[r.code];
        return `<${known ? "button" : "div"} class="arrival"${known ? ` type="button" data-near-line="${esc(r.code)}" data-near-stop="${esc(r.s.id)}" data-near-raw="${esc(r.raw)}"` : ""}>
          <span class="badge"${lineStyle(r.code)}>${esc(r.code)}</span>
          <span class="route"><b>${esc(r.ruta)}</b><small>${esc(r.s.name)} · ${esc(t("walk", { n: r.walk }))}</small></span>${eta}
        </${known ? "button" : "div"}>`;
      }).join("") : `<p class="note">${esc(t("near_dep_none"))}</p>`;
    });
    nearTimer = setTimeout(refreshNearDep, REFRESH_MS);
  }
  // Tocar uno: esa línea (solo los viajes con ese letrero) desde su parada.
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-near-line]");
    if (!b) return;
    e.stopPropagation();
    navigate(`linea/${b.dataset.nearLine}/${b.dataset.nearStop}${b.dataset.nearRaw ? `/${encodeURIComponent(b.dataset.nearRaw)}` : ""}`);
  }, true);

  // ---------- Pestaña Favoritas (5) ----------
  const EDIT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
  let favTimer = null;
  let favPicking = null;          // "home" | "work" mientras se elige con el buscador del propio botón
  const favOpenLines = new Set(); // paradas con el selector de líneas abierto
  function renderFav() {
    clearTimeout(favTimer);
    const items = [];
    // Ir a casa / al trabajo; sin elegir, el botón abre un buscador para escribir la dirección.
    const hw = document.createElement("li");
    hw.className = "fav-hw";
    hw.innerHTML = ["home", "work"].map((k) => {
      const p = favs[k];
      return p ? `<div class="hw"><button type="button" class="hw-go" data-go="${k}"><b>${esc(t(`go_${k}`))}</b><small>${esc(p.label)}</small></button>
          <button type="button" class="icon-btn hw-edit" data-pick="${k}" aria-label="${esc(t(`change_${k}`))}" title="${esc(t(`change_${k}`))}">${EDIT_SVG}</button></div>`
        : `<div class="hw"><button type="button" class="hw-go unset" data-pick="${k}"><b>${esc(t(`set_${k}`))}</b><small>${esc(t("set_hint"))}</small></button></div>`;
    }).join("");
    items.push(hw);
    if (favPicking) items.push(pickerItem());
    // Paradas: con los tiempos en vivo de sus líneas (todas o las elegidas).
    favs.stops.forEach((f) => {
      const s = byId.get(f.id);
      if (!s) return;
      const li = stopItem(s, { dist: me ? haversine(me, s.ll) : null, noLines: true });
      li.classList.add("fav-stop");
      const live = document.createElement("div");
      live.className = "fav-live";
      live.dataset.live = f.id;
      live.textContent = "…";
      const tools = document.createElement("div");
      tools.className = "fav-tools";
      const n = f.lines ? f.lines.length : 0;
      tools.innerHTML = `<button type="button" data-flines="${esc(f.id)}" aria-expanded="${favOpenLines.has(f.id)}">${esc(n === 1 ? t("fav_lines_1") : n ? t("fav_lines_n", { n }) : t("fav_lines_all"))}</button>`;
      li.append(live, tools);
      if (favOpenLines.has(f.id)) {
        const pick = document.createElement("div");
        pick.className = "fav-linepick lines";
        pick.innerHTML = s.lines.map((code) => `<button type="button" class="chip" data-fl="${esc(code)}" data-flstop="${esc(f.id)}" aria-pressed="${!f.lines || f.lines.includes(code)}"${lineStyle(code)}>${esc(code)}</button>`).join("");
        li.append(pick);
      }
      items.push(li);
    });
    // Direcciones y sitios.
    favs.places.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "fav-place";
      li.innerHTML = `<button type="button" data-fplace="${i}">
        <span class="name">${esc(p.label)}</span>
        <span class="sub">${esc(p.site ? t(`site_${p.site}`) : t("fav_address"))}</span>
        ${me ? `<span class="dist">${fmtDist(haversine(me, p.ll))}</span>` : ""}
      </button>
      <button type="button" class="fav-go" data-ftrip="${i}">${esc(t("trip_here"))}</button>`;
      items.push(li);
    });
    fillList(items, favs.stops.length || favs.places.length ? "" : t("no_favs"));
    if (favPicking) { const q = $("#fav-pick-q"); q.focus(); fillPicker(); }
    refreshFavLive();
  }
  // Tiempos en vivo de las paradas favoritas (cada 30 s mientras se ve la pestaña).
  function refreshFavLive() {
    clearTimeout(favTimer);
    if (mode !== "fav" || $("#home").hidden) return;
    favs.stops.forEach((f) => getLive(f.id).then((e) => {
      const box = document.querySelector(`.fav-live[data-live="${CSS.escape(f.id)}"]`);
      if (!box) return;
      if (!e.list) { box.textContent = t("times_error"); return; }
      const by = new Map();
      e.list.forEach((x) => {
        const code = normLine(x.linea), m = Number(x.minutos);
        if (isNaN(m) || (f.lines && !f.lines.includes(code))) return;
        if (!by.has(code)) by.set(code, []);
        by.get(code).push(m - Math.round((Date.now() - e.at) / 60000));
      });
      const rows = [...by].map(([code, ms]) => [code, ms.sort((a, b) => a - b).filter((m) => m >= 0).slice(0, 2)]).filter(([, ms]) => ms.length)
        .sort((a, b) => a[1][0] - b[1][0]);
      box.innerHTML = rows.length ? rows.map(([code, ms]) =>
        `<span class="fl"><i${lineStyle(code)}>${esc(code)}</i>${ms.map((m) => (m <= 0 ? esc(t("arriving")) : `${m}`)).join(", ")}${ms.some((m) => m > 0) ? ` ${esc(t("min"))}` : ""}</span>`).join("")
        : `<span class="fl-none">${esc(t(f.lines ? "fav_none_lines" : "bus_none"))}</span>`;
    }));
    favTimer = setTimeout(() => { if (!document.hidden) refreshFavLive(); }, REFRESH_MS);
  }
  // Buscador del botón "Elegir casa / trabajo".
  function pickerItem() {
    const li = document.createElement("li");
    li.className = "fav-picker";
    li.innerHTML = `<label class="visually-hidden" for="fav-pick-q">${esc(t(`set_${favPicking}`))}</label>
      <div class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>
      <input id="fav-pick-q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(t(`pick_${favPicking}`))}"></div>
      <ul id="fav-pick-res" class="stops"></ul>
      <button type="button" class="fav-cancel" data-pickcancel="1">${esc(t("cancel"))}</button>`;
    return li;
  }
  const pickBtn = (attrs, name, sub) => `<li><button type="button" ${attrs}><span class="name">${name}</span><span class="sub">${esc(sub)}</span></button></li>`;
  function fillPicker() {
    const box = $("#fav-pick-res");
    if (!box) return;
    const q = $("#fav-pick-q").value.trim();
    const out = [];
    if (me && !farFromVigo(me)) out.push(pickBtn('data-pk="me"', esc(t("my_location_now")), t("my_location")));
    if (/\p{L}.*\p{L}.*\p{L}/u.test(q)) {
      const tokens = norm(q).split(" ").filter(Boolean);
      if (!sitesData) ensureSites().then(fillPicker).catch(() => {});
      if (!dirData) ensureDir().then(fillPicker).catch(() => {});
      matchSites(q, 4).forEach((s) => out.push(pickBtn(`data-pk="site" data-i="${s.i}"`, highlight(s.name, tokens), t(`site_${s.type}`))));
      if (dirData) {
        const p = dirData.parse(q);
        dirData.matchStreets(p.street, 4).forEach((st) => {
          const label = p.num ? `${st.name}, ${p.num}` : st.name;
          out.push(pickBtn(`data-pk="addr" data-i="${st.i}" data-num="${esc(p.num || "")}"`, highlight(label, tokens), p.num ? t("res_addr") : t("addr_add_num")));
        });
      }
      matchStops(q).slice(0, 4).forEach((s) => out.push(pickBtn(`data-pk="stop" data-i="${esc(s.id)}"`, highlight(s.name, tokens), t("stop_n", { id: s.id }))));
    }
    box.innerHTML = out.join("");
  }
  function savePick(p) {
    favs[favPicking] = p;
    saveFavs();
    toast(t(`saved_${favPicking}`));
    favPicking = null;
    renderFav();
  }
  // Ir a casa o al trabajo: Cómo llegar desde tu ubicación (si se puede) hasta allí.
  function goTo(p) {
    trip.a = trip.b = null;
    trip.sel = null;
    trip.b = { kind: "addr", ll: p.ll, label: p.label };
    if (me && !farFromVigo(me)) trip.a = { kind: "me", ll: me };
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`);
    if (!trip.a) getPosition((ll) => { if (tripOpen() && !trip.a && !farFromVigo(ll)) setEnd("a", { kind: "me", ll }); });
  }
  $("#list").addEventListener("input", (e) => { if (e.target.id === "fav-pick-q") fillPicker(); });
  $("#list").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || mode !== "fav") return;
    if (b.dataset.pick) { e.stopPropagation(); favPicking = favPicking === b.dataset.pick ? null : b.dataset.pick; renderFav(); return; }
    if (b.dataset.pickcancel) { e.stopPropagation(); favPicking = null; renderFav(); return; }
    if (b.dataset.go) { e.stopPropagation(); goTo(favs[b.dataset.go]); return; }
    if (b.dataset.pk) {
      e.stopPropagation();
      const k = b.dataset.pk;
      if (k === "me") savePick({ ll: me.slice(), label: t("saved_here") });
      else if (k === "site") { const s = sitesData[Number(b.dataset.i)]; savePick({ ll: s.ll, label: s.name, site: s.type }); }
      else if (k === "stop") { const s = byId.get(b.dataset.i); savePick({ ll: s.ll, label: s.name }); }
      else if (k === "addr") {
        const st = dirData.streets[Number(b.dataset.i)];
        if (!b.dataset.num) { const q = $("#fav-pick-q"); q.value = `${st.name}, `; q.focus(); fillPicker(); return; }
        const r = dirData.resolve(st, b.dataset.num);
        savePick({ ll: r.ll, label: `${st.name}, ${b.dataset.num}` });
      }
      return;
    }
    if (b.dataset.flines) {
      e.stopPropagation();
      const id = b.dataset.flines;
      if (favOpenLines.has(id)) favOpenLines.delete(id); else favOpenLines.add(id);
      renderFav();
      return;
    }
    if (b.dataset.fl) {
      e.stopPropagation();
      const f = favStop(b.dataset.flstop), s = byId.get(f.id);
      const on = new Set(f.lines || s.lines);
      if (on.has(b.dataset.fl)) on.delete(b.dataset.fl); else on.add(b.dataset.fl);
      f.lines = on.size === s.lines.length || !on.size ? null : s.lines.filter((c) => on.has(c));
      saveFavs();
      renderFav();
      return;
    }
    if (b.dataset.fplace) { e.stopPropagation(); const p = favs.places[Number(b.dataset.fplace)]; openPlace({ ll: p.ll, label: p.label, approx: false, site: p.site }); return; }
    if (b.dataset.ftrip) { e.stopPropagation(); goTo(favs.places[Number(b.dataset.ftrip)]); }
  }, true);
  // Estrella en la ficha de una dirección o de un sitio.
  function updatePlaceFav() {
    const on = !!(place && favPlace(place));
    const b = $("#place-fav");
    b.setAttribute("aria-pressed", on);
    b.setAttribute("aria-label", on ? t("fav_remove") : t("fav_add"));
  }
  $("#place-fav").addEventListener("click", () => {
    if (!place) return;
    if (favPlace(place)) favs.places = favs.places.filter((f) => placeKey(f) !== placeKey(place));
    else favs.places.push({ ll: place.ll.slice(), label: place.label, ...(place.site ? { site: place.site } : {}) });
    saveFavs();
    updatePlaceFav();
    toast(favPlace(place) ? t("fav_added") : t("fav_removed"));
  });

  // ---------- Dirección (calle y número) ----------
  // En la dirección web: #dir/<lat,lon>~<Calle, número>[~a] ("~a": posición aproximada).
  const PIN_SVG = '<svg viewBox="0 0 34 44" aria-hidden="true"><path d="M17 42s-14-13.2-14-24.5a14 14 0 0 1 28 0C31 28.8 17 42 17 42z" fill="#D3202F" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="17.5" r="5" fill="#fff"/></svg>';
  const placeIcon = L.divIcon({ className: "place-pin", html: PIN_SVG, iconSize: [34, 44], iconAnchor: [17, 42] });
  let placeMarker = null;
  let place = null;   // { ll, label, approx }

  const placeToken = (p) => `dir/${fmtLL(p.ll)}~${encodeURIComponent(p.label)}${p.approx ? "~a" : p.site ? `~s-${p.site}` : ""}`;
  function openPlace(p, { replace = false } = {}) { navigate(placeToken(p), { replace }); }

  function showPlace(tok) {
    const parts = location.hash.slice(1).split("/").slice(1).join("/").split("~").map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    const m = (parts[0] || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!m || !parts[1]) return false;
    leaveStop();
    clearLine();
    const site = parts[2] && parts[2].startsWith("s-") ? parts[2].slice(2) : null;
    const next = { ll: [Number(m[1]), Number(m[2])], label: parts[1], approx: parts[2] === "a", site };
    const same = place && placeToken(place) === placeToken(next);   // p. ej., al cambiar de idioma
    showView("place");
    place = next;
    document.title = `${place.label} · Próximo Vitrasa`;
    $("#place-name").textContent = place.label;
    updatePlaceFav();
    $("#place-meta").textContent = place.site ? t(`site_${place.site}`) : place.approx ? t("addr_approx") : /\d/.test(place.label) ? t("addr_exact") : t("addr_whole");
    $("#place-dist").textContent = me ? ` · ${fmtDist(haversine(me, place.ll))}` : "";
    $("#place-stops").replaceChildren(...nearest(place.ll, 6).map(({ s, d }) => stopItem(s, { dist: d, sub: t("walk", { n: walkMin(d * 1.25) }) })));
    if (!placeMarker) placeMarker = L.marker(place.ll, { icon: placeIcon, keyboard: false, interactive: false, zIndexOffset: 1200 });
    placeMarker.setLatLng(place.ll).addTo(map);
    if (!same) {
      if (!isDesktop()) panel.dataset.state = "stop";
      focusOn(place.ll, Math.max(map.getZoom(), PLACE_ZOOM));
    }
    drawNums();
    return true;
  }
  function leavePlace() {
    if (!place) return;
    place = null;
    if (placeMarker) placeMarker.remove();
    drawNums();
  }
  $("#place-back").addEventListener("click", goBack);

  // ---------- Compartir ----------
  // Enlace a lo que se ve (parada, línea, dirección o trayecto). En el móvil se abre el menú de
  // compartir del teléfono; en el ordenador (o si no hay menú) se copia el enlace.
  // "Mi ubicación" nunca va en el enlace: esa parte se deja vacía para quien lo abra.
  const shareEnd = (p) => (p && p.kind !== "me" ? endToken(p) : "");
  function shareData(ctx) {
    const base = location.origin + location.pathname;
    if (ctx === "stop" && current) {
      return { url: `${base}#${current.id}`, text: `${current.name} · ${t("stop_n", { id: current.id })}` };
    }
    if (ctx === "line" && active) {
      const l = lines[active.code];
      const v = active.from && active.variant ? `/${encodeURIComponent(active.variant.ruta)}` : "";
      return { url: `${base}#linea/${encodeURIComponent(active.code)}${active.from ? `/${active.from}` : ""}${v}`,
        text: `${t("line_n", { code: active.code })} · ${active.variant ? t("towards", { dest: titleCase(active.variant.ruta) }) : l.nombre}` };
    }
    if (ctx === "place" && place) return { url: `${base}#${placeToken(place)}`, text: place.label };
    if (ctx === "sched" && sched) {
      const s = byId.get(sched.id);
      return { url: `${base}#horario/${sched.id}`, text: `${t("sched_title")} · ${s.name} · ${t("stop_n", { id: sched.id })}` };
    }
    if (ctx === "trip") {
      const a = shareEnd(trip.a), b = shareEnd(trip.b);
      if (!a && !b) return null;
      const la = a ? endLabel(trip.a) : "", lb = b ? endLabel(trip.b) : "";
      const text = a && b ? `${t("trip_title")}: ${la} → ${lb}` : b ? t("share_to", { to: lb }) : t("share_from", { from: la });
      return { url: `${base}#${`ir/${a}/${b}`.replace(/\/+$/, "")}`, text };
    }
    return null;
  }
  function copyText(s) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(s);
    return new Promise((ok, ko) => {
      const ta = document.createElement("textarea");
      ta.value = s; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? ok() : ko(); } catch (e) { ko(e); } finally { ta.remove(); }
    });
  }
  const touchDevice = () => matchMedia("(pointer: coarse)").matches;
  async function share(ctx) {
    const d = shareData(ctx);
    if (!d) return;
    if (navigator.share && touchDevice()) {
      try { await navigator.share({ title: "Próximo Vitrasa", text: d.text, url: d.url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }   // cerrado por el usuario: nada que hacer
    }
    try { await copyText(d.url); toast(t("share_copied")); } catch { toast(t("share_fail")); }
  }
  document.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", () => share(b.dataset.share)));
  // El trayecto solo se puede compartir con origen o destino (que no sea "mi ubicación").
  const updateTripShare = () => ($('[data-share="trip"]').hidden = !shareData("trip"));

  // ---------- Información útil ----------
  // Solo enlaces a páginas oficiales de Vitrasa: no se lee ni se interpreta su contenido.
  const VITRASA = "https://www.vitrasa.es";
  const INFO_LINKS = [
    ["info_grp_main", [
      ["l_alerts", "/avisos"],
      ["l_lines", "/lineas-y-horarios/todas-las-lineas"],
      ["l_fares", "/tarifas-y-titulos"],
      ["l_customer", "/informacion/atencion-al-cliente"],
      ["l_rules", "/informacion/normas-del-servicio"],
    ]],
    ["info_grp_services", [
      ["l_night", "/informacion/servicios/bus-nocturno"],
      ["l_airport", "/informacion/serivicios/aeropuerto"],   // así está en vitrasa.es ("serivicios")
      ["l_hospitals", "/hospitales"],
      ["l_uni", "/informacion/servicios/lanzaderas-universidad"],
      ["l_football", "/informacion/servicios/lanzaderas-futbol"],
      ["l_demand", "/informacion/servicios/paradas-a-demanda"],
      ["l_access", "/informacion/servicios/accesibilidad"],
    ]],
  ];
  const EXT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  function renderInfo() {
    $("#info-list").innerHTML = INFO_LINKS.map(([grp, links]) =>
      `<li class="group-head">${esc(t(grp))}</li>` + links.map(([k, path]) =>
        `<li><a class="info-link" href="${VITRASA}${path}" target="_blank" rel="noopener"><span class="name">${esc(t(k))}</span>${EXT_SVG}</a></li>`).join("")).join("");
  }
  function showInfo() {
    leaveStop();
    clearLine();
    showView("info");
    document.title = `${t("info_title")} · Próximo Vitrasa`;
    renderInfo();
    if (!isDesktop()) panel.dataset.state = "full";
  }
  $("#info-btn").addEventListener("click", () => { if (location.hash !== "#info") navigate("info"); });
  $("#info-back").addEventListener("click", goBack);
  $("#place-trip").addEventListener("click", () => { if (place) openTrip({ kind: "addr", ll: place.ll, label: place.label, approx: place.approx }); });

  // ---------- Números de portal en el mapa ----------
  // Con zoom alto se dibujan todos los números de portal conocidos (aunque el mapa base ya traiga
  // algunos). Van en un lienzo propio; solo los que caen en pantalla y sin que se pisen entre ellos.
  // Tocar uno abre esa dirección (o, en "Cómo llegar", la elige como origen o destino).
  // Mismo zoom desde el que el mapa de OpenStreetMap empieza a pintar sus números de portal (17).
  const NUM_ZOOM = 18;     // uno más que el mapa base (17), para no cargar tanto la vista
  const PLACE_ZOOM = 18;   // al abrir una dirección
  map.createPane("nums").style.zIndex = 450;   // encima de los trazados, debajo de las paradas
  map.getPane("nums").style.pointerEvents = "none";
  const numCanvas = L.DomUtil.create("canvas", "num-canvas", map.getPane("nums"));
  let numHits = [];   // { x, y, w, h, pt } en coordenadas del mapa (contenedor)
  const numsOn = () => map.getZoom() >= NUM_ZOOM && !tripRouteOn && !active;

  function drawNums() {
    numHits = [];
    const ctx = numCanvas.getContext("2d");
    const size = map.getSize(), dpr = window.devicePixelRatio || 1;
    if (numCanvas.width !== size.x * dpr || numCanvas.height !== size.y * dpr) {
      numCanvas.width = size.x * dpr; numCanvas.height = size.y * dpr;
      numCanvas.style.width = `${size.x}px`; numCanvas.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(numCanvas, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (!numsOn()) return;
    if (!dirData) { ensureDir().then(drawNums).catch(() => {}); return; }
    const b = map.getBounds().pad(0.05);
    const pts = dirData.portalsIn(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
    const z = map.getZoom();
    // Discretos: letra pequeña, color claro y halo fino (el portal elegido, en rojo).
    ctx.font = `500 ${z >= 19 ? 12 : 11}px Barlow, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round"; ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,.75)";
    const boxes = [];
    const selKey = place && /\d/.test(place.label) ? place.label : null;
    for (const pt of pts) {
      const p = map.latLngToContainerPoint(pt.ll);
      const w = ctx.measureText(pt.n).width + 4, h = 14;
      const box = { x: p.x - w / 2, y: p.y - h / 2, w, h, pt };
      numHits.push(box);
      if (boxes.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) continue;
      boxes.push(box);
      const sel = selKey === `${pt.s.name}, ${pt.n}`;
      ctx.fillStyle = sel ? "#D3202F" : "rgba(91,79,69,.72)";
      ctx.strokeText(pt.n, p.x, p.y);
      ctx.fillText(pt.n, p.x, p.y);
    }
  }
  // Durante el zoom animado el lienzo se esconde; se vuelve a dibujar al terminar.
  map.on("zoomstart", () => { numCanvas.style.visibility = "hidden"; });
  map.on("moveend zoomend resize", () => { numCanvas.style.visibility = ""; drawNums(); });

  // Portal tocado: el número más cercano al toque (a menos de 16 px).
  function numAt(cp) {
    if (!numsOn()) return null;
    let best = null, bd = 16;
    for (const b of numHits) {
      const d = Math.hypot(cp.x - (b.x + b.w / 2), cp.y - (b.y + b.h / 2));
      if (d < bd) { bd = d; best = b.pt; }
    }
    return best;
  }
  // El toque que sigue a una pulsación larga ("Desde aquí / Hasta aquí") no cuenta como toque.
  let heldAt = 0;
  const justHeld = () => Date.now() - heldAt < 700;
  map.on("click", (e) => {
    if (tripOpen() || justHeld()) return;   // en "Cómo llegar" lo atiende su propio manejador
    const pt = numAt(e.containerPoint);
    if (pt) openPlace({ ll: pt.ll, label: `${pt.s.name}, ${pt.n}`, approx: false }, { replace: panel.dataset.view === "place" });
  });

  // ---------- Cómo llegar (de A a B; por ahora, a pie) ----------
  // Cada extremo es { kind: "stop" | "me" | "map", ll: [lat, lon], id? }. En la dirección: #ir/<A>/<B>,
  // con "p1234" para una parada y "lat,lon" para un punto. La ruta se calcula en el propio
  // dispositivo con la red peatonal de OpenStreetMap (js/peaton.js), sin servicios externos.
  const trip = { a: null, b: null, editing: null, picking: null, sel: null, when: null, whenMode: "dep" };   // sel: opción abierta; when: hora elegida (Date) o null = ahora; whenMode: "dep" salir a esa hora, "arr" llegar a esa hora
  const tripLayer = L.layerGroup().addTo(map);
  // Recorrido que le queda al bus en vivo hasta la parada de subida: en su propio panel, debajo de
  // los tramos del viaje (así no tapa la parada de subida).
  map.createPane("tripTail").style.zIndex = 390;
  const tailRenderer = L.canvas({ padding: 0.3, pane: "tripTail" });
  const tripPins = {};
  let tripSeq = 0;
  let lastTrip = null;
  const tripOpen = () => !$("#trip").hidden;
  const fmtLL = (ll) => `${ll[0].toFixed(5)},${ll[1].toFixed(5)}`;
  const stopEnd = (s) => ({ kind: "stop", id: s.id, ll: s.ll });
  const ICON_ME = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';
  const ICON_MAP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg>';
  const ICON_WALK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4.2" r="1.8"/><path d="M9.5 21l2.2-5.5 2.6 2.3V21M11.7 15.5l1-5.3-3.2 1.3-1 3M12.7 10.2l2 2.6 2.8 1"/></svg>';

  // Una dirección viaja en la dirección web como "lat,lon~Rúa de Urzáiz, 19".
  function endToken(p) {
    if (!p) return "";
    if (p.kind === "stop") return `p${p.id}`;
    return p.kind === "addr" ? `${fmtLL(p.ll)}~${encodeURIComponent(p.label)}` : fmtLL(p.ll);
  }
  function parseEnd(tok, prev) {
    if (!tok) return null;
    if (prev && decodeURIComponent(endToken(prev)) === tok) return prev;   // conserva "Mi ubicación" al volver
    if (tok[0] === "p" && byId.has(tok.slice(1))) return stopEnd(byId.get(tok.slice(1)));
    const m = tok.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:~(.+))?$/);
    if (!m) return null;
    const ll = [Number(m[1]), Number(m[2])];
    return m[3] ? { kind: "addr", ll, label: m[3] } : { kind: "map", ll };
  }
  function endLabel(p) {
    if (!p) return "";
    if (p.kind === "stop") return `${byId.get(p.id).name} (${p.id})`;
    if (p.kind === "addr") return p.label;
    return p.kind === "me" ? t("my_location") : t("map_point");
  }

  // Diccionario de calles y portales (js/direcciones.js); se descarga al abrir "Cómo llegar".
  let dirData = null;
  const ensureDir = () => window.PV_DIR.load().then((d) => (dirData = d));
  const pinIcon = (w) => L.divIcon({ className: "trip-pin", html: `<span class="pin pin-${w}">${w.toUpperCase()}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  function openTrip(b) {
    if (!trip.a && me && !farFromVigo(me)) trip.a = { kind: "me", ll: me };
    if (b) trip.b = b;
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`);
  }

  // Profundidad del historial al entrar en "Cómo llegar" (para salir de una vez, ver #trip-back).
  let tripEntryDepth = null;
  function showTrip(h) {
    const d = (history.state && history.state.d) || 0;
    if (panel.dataset.view !== "trip" || tripEntryDepth == null || d < tripEntryDepth) tripEntryDepth = d;
    leaveStop();
    clearLine();
    // Cada parte se decodifica por separado: el nombre de una calle puede llevar "/".
    const [, ta = "", tb = ""] = location.hash.slice(1).split("/").map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    trip.a = parseEnd(ta, trip.a);
    trip.b = parseEnd(tb, trip.b);
    trip.picking = null;
    const same = tripOpen() && lastTrip && lastTrip.hash === location.hash;
    showView("trip");
    document.title = `${t("trip_title")} · Próximo Vitrasa`;
    if (!isDesktop() && panel.dataset.state !== "full") panel.dataset.state = baseState();
    closeSugg();
    renderTripFields();
    renderWhen();
    if (same) {
      // Mismo origen y destino: solo cambia la opción abierta (botón Atrás o Adelante).
      trip.sel = (history.state && history.state.opt) || null;
      renderTripResult();
      drawTrip(true);
    } else computeTrip(true);
    ensureDir().catch(() => {});
  }

  function leaveTrip() {
    tripSeq++;
    trip.picking = null;
    trip.sel = null;
    lastTrip = null;
    stopTripLive();
    tripLayer.clearLayers();
    Object.values(tripPins).forEach((m) => m.remove());
    tripRouteOn = false;
    updateStopVisibility();
  }

  function setEnd(which, p) {
    trip[which] = p;
    trip.picking = null;
    $("#toast").hidden = true;   // el aviso de "toca el mapa" ya no hace falta
    tripReplace();
    $(`#trip-${which}`).blur();
    closeSugg();
    renderTripFields();
    setPanel(baseState());
    computeTrip(true);
  }

  // Dirección web al día con los extremos (sin opción abierta: hay que volver a calcular).
  function tripReplace() {
    trip.sel = null;
    const h = `#ir/${endToken(trip.a)}/${endToken(trip.b)}`.replace(/\/+$/, "");
    history.replaceState({ d: (history.state && history.state.d) || 0 }, "", h);
  }

  // A qué campo va un punto elegido en el mapa: el que se está editando o el primero vacío.
  const targetEnd = () => trip.picking || trip.editing || (!trip.a ? "a" : "b");
  function tripPickStop(s) { setEnd(targetEnd(), stopEnd(s)); }

  function renderTripFields() {
    updateTripShare();
    ["a", "b"].forEach((w) => {
      const inp = $(`#trip-${w}`);
      if (document.activeElement !== inp) inp.value = endLabel(trip[w]);
      $(`[data-clear="${w}"]`).hidden = !inp.value;
      inp.closest(".trip-field").classList.toggle("picking", trip.picking === w);
      const p = trip[w];
      if (p && tripOpen()) {
        if (!tripPins[w]) {
          tripPins[w] = L.marker(p.ll, { icon: pinIcon(w), draggable: true, keyboard: false, zIndexOffset: 1000 })
            .on("dragend", (e) => { const ll = e.target.getLatLng(); setEnd(w, { kind: "map", ll: [ll.lat, ll.lng] }); });
        }
        tripPins[w].setLatLng(p.ll).addTo(map);
      } else if (tripPins[w]) tripPins[w].remove();
    });
  }

  function specialItem(kind, icon, label) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" class="special" data-trip="${kind}">${icon}<span class="name">${esc(label)}</span></button>`;
    return li;
  }

  // Una calle propuesta. num: número escrito; "" toda la calle; null falta el número (al tocarla
  // se completa el campo con "Calle, " para seguir escribiendo).
  function addrItem(st, num, tokens) {
    const li = document.createElement("li");
    let sub;
    if (num === null) sub = t("addr_add_num");
    else if (num === "") sub = t("addr_whole");
    else sub = dirData.resolve(st, num).exact ? t("addr_exact") : t("addr_approx");
    // Calles con el mismo nombre en sitios distintos: se dice cerca de qué parada están.
    if (st.dup && stops.length) sub += ` · ${t("near_stop", { name: nearest(st.ll, 1)[0].s.name })}`;
    const label = num ? `${st.name}, ${num}` : st.name;
    li.innerHTML = `<button type="button" data-addr="${st.i}" data-num="${num === null ? "" : esc(num)}"${num === null ? ' data-fill="1"' : ""}>
      <span class="name">${highlight(label, tokens)}</span>
      <span class="sub">${esc(sub)}</span>
      ${me ? `<span class="dist">${fmtDist(haversine(me, dirData.resolve(st, num || "").ll))}</span>` : ""}
    </button>`;
    return li;
  }

  // Sugerencias mientras se escribe en Desde o Hasta: direcciones (calle y número) y paradas.
  function openSugg(which) {
    trip.editing = which;
    const inp = $(`#trip-${which}`);
    const q = inp.value.trim();
    const typed = q && q !== endLabel(trip[which]) ? q : "";
    $(`[data-clear="${which}"]`).hidden = !inp.value;
    const special = [specialItem("me", ICON_ME, t("my_location")), specialItem("map", ICON_MAP, t("pick_map"))];
    const items = [];
    if (typed && !dirData) ensureDir().then(() => { if (trip.editing === which) openSugg(which); }).catch(() => {});
    if (typed) {
      const tokens = norm(typed).split(" ").filter(Boolean);
      const addr = [];
      if (dirData) {
        const p = dirData.parse(typed);
        const found = dirData.matchStreets(p.street, p.num ? 4 : 6);
        found.forEach((st) => addr.push(addrItem(st, p.num, tokens)));
        // Con número a medio escribir: otros portales conocidos de la primera calle ("1" → 10, 12…).
        if (p.num && found[0]) dirData.numbersStarting(found[0], p.num).forEach((n) => addr.push(addrItem(found[0], n, tokens)));
      }
      const res = matchStops(typed).slice(0, addr.length ? 25 : 40);
      if (!sitesData && /\p{L}.*\p{L}.*\p{L}/u.test(typed)) ensureSites().then(() => { if (trip.editing === which) openSugg(which); }).catch(() => {});
      const sites = /\p{L}.*\p{L}.*\p{L}/u.test(typed) ? matchSites(typed) : [];
      if (sites.length) items.push(groupHead(t("res_sites")), ...sites.map((s) => siteItem(s, tokens)));
      if (addr.length) items.push(groupHead(t("res_addr")), ...addr);
      if (res.length) {
        items.push(groupHead(t("res_stops")));
        res.forEach((s) => items.push(stopItem(s, { nameHtml: highlight(s.name, tokens), noLines: true, dist: me ? haversine(me, s.ll) : null })));
      }
      if (!addr.length && !res.length && !sites.length) {
        const li = document.createElement("li");
        li.className = "group-head";
        li.textContent = t("trip_no_stops", { q: typed });
        items.push(li);
      }
    }
    // Con texto escrito, primero lo encontrado (que se vea encima del teclado del móvil) y después
    // "Mi ubicación" y "Elegir en el mapa"; sin texto, solo esas dos.
    $("#trip-sugg").replaceChildren(...(typed ? [...items, ...special] : [...special, ...recentItems({ noLines: true })]));
    $("#trip-sugg").hidden = false;
    $("#trip-result").hidden = true;
    $("#trip").classList.add("editing");   // mientras se escribe, sin las filas de hora y preferencias
    $("#trip-sugg").scrollTop = 0;
  }
  function closeSugg() {
    trip.editing = null;
    $("#trip-sugg").hidden = true;
    $("#trip-result").hidden = false;
    $("#trip").classList.remove("editing");
  }

  // ---------- Planificador: en bus de A a B ----------
  // Las opciones salen de los horarios (js/planificador.js, data/viajes.json) y después se corrigen
  // con los tiempos en vivo de las paradas de subida. Cada 30 s se vuelve a calcular todo.
  const PLAN = window.PV_PLAN;
  const MAX_WALK_STOP = 1000;        // metros a pie como máximo hasta la parada de subida o desde la de bajada
  const liveCache = new Map();       // parada → { at, list | null } (null: sin respuesta)
  const walkCache = new Map();       // tramos a pie ya calculados
  let tripTimer = null, tripTick = null, tripBuses = [];

  function stopTripLive() {
    clearTimeout(tripTimer);
    clearInterval(tripTick);
    tripTimer = tripTick = null;
    tripBuses.forEach((b) => { if (b.marker) b.marker.remove(); if (b.tail) b.tail.forEach((x) => x.remove()); });
    tripBuses = [];
  }

  const WIDE_WALK_STOP = 2500;       // si así no hay ningún bus, se buscan paradas más lejos
  // Paradas alcanzables a pie desde un punto: Map(índice de parada en el plan → metros).
  function stopsAround(net, plan, ll, radii = [MAX_WALK_STOP, MAX_WALK_STOP * 1.6]) {
    for (const max of radii) {
      const dist = net.around(ll, max);
      const out = new Map();
      for (const s of stops) {
        const i = plan.index.get(s.id);
        if (i == null || haversine(ll, s.ll) > max) continue;
        const m = dist(s.ll);
        if (m <= max) out.set(i, m);
      }
      if (out.size) return out;
    }
    return new Map();
  }

  // Tiempos en vivo de una parada (se reutilizan durante 20 s).
  function getLive(id) {
    const c = liveCache.get(id);
    if (c && Date.now() - c.at < 20000) return Promise.resolve(c);
    if (lastArrivals && lastArrivalsId === id && lastUpdate && Date.now() - lastUpdate.getTime() < 20000) {
      const e = { at: lastUpdate.getTime(), list: lastArrivals };
      liveCache.set(id, e);
      return Promise.resolve(e);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    return fetchEstimates(id, ctl.signal)
      .then((d) => ({ at: Date.now(), list: d.estimaciones || [] }))
      .catch(() => ({ at: Date.now(), list: null }))
      .then((e) => { clearTimeout(timer); liveCache.set(id, e); return e; });
  }

  // Buses en vivo de la línea y sentido de un tramo, en su parada de subida, que de verdad llevan a la
  // parada de bajada (ver PV_PLAN.liveReaches). Si la API da buses de la línea pero ninguno sirve, se
  // devuelve null (se usa el horario, sin marcarlo dudoso).
  function liveFor(plan, leg) {
    const e = liveCache.get(plan.ids[leg.board]);
    if (!e || !e.list) return null;
    const l = lines[leg.line];
    const d = l && l.sentidos[leg.dir];
    const id = plan.ids[leg.board];
    const both = l && l.sentidos.filter((d) => d.paradas.includes(id) || (d.otras || []).includes(id)).length > 1;
    const mine = e.list.filter((x) => normLine(x.linea) === leg.line && (!both || !d || goesTo(d, x.ruta)));
    // Solo los buses que seguro llegan (o de letrero desconocido): ni los de otro ramal o que acaban
    // antes, ni aquellos en los que a esa hora hay viajes con su letrero que llegan y otros que no.
    const good = mine.filter((x) => {
      const r = plan.liveReaches(leg, x.ruta, new Date(e.at + Number(x.minutos) * 60000));
      return r === "yes" || r === "unknown";
    });
    if (mine.length && !good.length) return null;
    return good.map((x) => ({ ...x, _at: e.at }));
  }

  async function computeTrip(fit) {
    const seq = ++tripSeq;
    stopTripLive();
    tripLayer.clearLayers();
    lastTrip = null;
    tripRouteOn = false;
    updateStopVisibility();
    const box = $("#trip-result");
    const ends = [trip.a, trip.b].filter(Boolean).map((p) => p.ll);
    if (ends.length < 2) {
      box.innerHTML = `<p class="trip-note">${esc(t("trip_hint"))}</p>`;
      if (fit && ends.length) focusOn(ends[0], Math.max(map.getZoom(), 15));
      // Se adelanta la descarga de la red y de los horarios para que la ruta salga al instante.
      window.PV_PEATON.load().catch(() => {});
      PLAN.load().catch(() => {});
      return;
    }
    box.innerHTML = `<p class="trip-note">${esc(t("trip_loading"))}</p>`;
    let net, plan = null;
    try { net = await window.PV_PEATON.load(); }
    catch { if (seq === tripSeq) box.innerHTML = `<div class="state"><strong>${esc(t("trip_net_error"))}</strong></div>`; return; }
    try { [plan] = await Promise.all([PLAN.load(), linesReady]); } catch { plan = null; }
    if (seq !== tripSeq) return;
    const r = net.route(trip.a.ll, trip.b.ll);
    lastTrip = {
      hash: location.hash, net, plan, planError: !plan, fecha: net.fecha,
      walk: r ? { dist: r.dist + r.offFrom + r.offTo, r } : null,
      approx: [trip.a, trip.b].filter((p) => p.kind === "addr" && p.approx).map((p) => p.label),
      cands: [], opts: [], live: false,
    };
    if (plan) {
      lastTrip.origins = stopsAround(net, plan, trip.a.ll);
      lastTrip.dests = stopsAround(net, plan, trip.b.ll);
      planSearch();
      // Siempre debe salir al menos una opción en bus: si no hay ninguna, paradas más lejos.
      if (!lastTrip.cands.length) {
        lastTrip.origins = stopsAround(net, plan, trip.a.ll, [WIDE_WALK_STOP]);
        lastTrip.dests = stopsAround(net, plan, trip.b.ll, [WIDE_WALK_STOP]);
        planSearch();
      }
    }
    const st = history.state && history.state.opt;
    trip.sel = st && (st === "walk" || lastTrip.opts.some((o) => o.key === st)) ? st : null;
    renderTripResult();
    drawTrip(fit);
    if (lastTrip.cands.length) refreshLive(seq);
  }

  // Preferencia de ruta (11), recordada en este dispositivo.
  const PREF_KEY = "pv:preferencia";
  let tripPref = "fast";
  try { tripPref = ["fast", "transfers", "walk"].includes(localStorage.getItem(PREF_KEY)) ? localStorage.getItem(PREF_KEY) : "fast"; } catch { /* sin almacenamiento */ }
  function renderPref() {
    document.querySelectorAll("#trip-pref [data-pref]").forEach((b) => b.setAttribute("aria-checked", b.dataset.pref === tripPref));
  }
  $("#trip-pref").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pref]");
    if (!b || b.dataset.pref === tripPref) return;
    tripPref = b.dataset.pref;
    try { localStorage.setItem(PREF_KEY, tripPref); } catch { /* sin almacenamiento */ }
    renderPref();
    trip.sel = null;
    computeTrip(false);
  });
  renderPref();

  // Hora de salida: la elegida o, si no hay (o ya pasó), ahora.
  const tripStart = () => (trip.when && trip.whenMode !== "arr" && trip.when > new Date() ? trip.when : new Date());

  // Busca de nuevo (las opciones del horario, aún sin tiempos en vivo).
  function planSearch() {
    const lt = lastTrip;
    const walk = lt.walk ? lt.walk.dist : Infinity;
    const q = { origins: lt.origins, dests: lt.dests, walk, maxTransfers: 2, prefer: tripPref };
    // "Llegar a las" (10): se busca desde 3 h antes (o desde ahora); si no hay forma de llegar a
    // tiempo, lo antes posible.
    const arriveBy = arriveMode() ? trip.when : null;
    lt.arriveBy = null;
    lt.arriveLate = false;
    if (arriveBy) {
      const now = new Date();
      const start = new Date(Math.max(now.getTime(), arriveBy.getTime() - 3 * 3600000));
      const cands = lt.plan.search({ ...q, time: now, arriveBy });
      if (cands.length) {
        lt.arriveBy = arriveBy;
        setStart(lt, start);
        lt.cands = cands;
      } else lt.arriveLate = true;
    }
    if (!lt.arriveBy) {
      const start = arriveBy ? new Date() : tripStart();
      setStart(lt, start);
      lt.cands = lt.plan.search({ ...q, time: start });
    }
    if (!lt.live) lt.opts = lt.plan.choose(lt.cands, lt.start, walk);
  }
  function setStart(lt, start) {
    lt.start = start;
    lt.base = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  }
  const arriveMode = () => !!(trip.when && trip.whenMode === "arr");

  async function refreshLive(seq) {
    const lt = lastTrip;
    if (!lt || !lt.plan) return;
    clearTimeout(tripTimer);
    const ids = new Set();
    lt.cands.forEach((j) => j.legs.forEach((l) => l.type === "bus" && ids.add(lt.plan.ids[l.board])));
    await Promise.all([...ids].map(getLive));
    if (seq !== tripSeq || lastTrip !== lt) return;
    const now = new Date();
    const re = lt.cands.map((j) => lt.plan.retime(j, (leg) => liveFor(lt.plan, leg), now, lt.start));
    lt.opts = lt.plan.choose(re, lt.start, lt.walk ? lt.walk.dist : Infinity);
    lt.live = true;
    lt.updated = now;
    // La opción abierta se mantiene aunque deje de estar entre las mejores.
    if (trip.sel && trip.sel !== "walk" && !lt.opts.some((o) => o.key === trip.sel)) {
      const keep = re.find((o) => o.key === trip.sel && !o.broken);
      if (keep) lt.opts.push(keep); else trip.sel = null;
    }
    renderTripResult();
    drawTrip(false);
    tripTimer = setTimeout(() => {
      if (seq !== tripSeq || lastTrip !== lt) return;
      if (document.hidden) return;             // al volver a la pestaña se actualiza (visibilitychange)
      planSearch();
      refreshLive(seq);
    }, REFRESH_MS);
  }

  // ---------- Opciones: textos ----------
  const nowSec = () => (Date.now() - lastTrip.base) / 1000;
  const startSec = () => Math.max(nowSec(), (lastTrip.start - lastTrip.base) / 1000);
  const clock = (sec) => new Date(lastTrip.base + sec * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  function durHtml(min) {
    min = Math.max(1, Math.round(min));
    return min < 60 ? `<b>${min}</b><span>${esc(t("min"))}</span>`
      : `<b>${Math.floor(min / 60)}</b><span>h</span> <b>${min % 60}</b><span>${esc(t("min"))}</span>`;
  }
  const stopName = (i) => { const s = byId.get(lastTrip.plan.ids[i]); return s ? s.name : lastTrip.plan.ids[i]; };
  const badge = (code) => `<span class="badge"${lineStyle(code)}>${esc(code)}</span>`;
  const walkChip = (m) => `<span class="walk-chip">${ICON_WALK}<small>${walkMin(m)}</small></span>`;
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  // "Pasa en 4 min" (en vivo) / "A las 9:14" (horario).
  function whenHtml(leg) {
    const m = Math.round((leg.dep - nowSec()) / 60);
    const txt = m <= 0 ? t("arriving") : m < 60 ? t("in_min", { n: m }) : atTime(leg.dep);
    if (leg.live) return `<span class="live">${esc(txt)}</span>`;
    return `<span class="sched">${esc(m < 60 && m > 0 ? atTime(leg.dep) : txt)} · ${esc(t("scheduled"))}</span>`;
  }
  // Hora de una salida o llegada, con "mañana" si es del día siguiente.
  const nextDay = (sec) => sec >= 86400 && new Date(lastTrip.base + sec * 1000).getDate() !== new Date().getDate();
  const atTime = (sec) => t(nextDay(sec) ? "tomorrow_at" : "at_time", { time: clock(sec) });
  const arriveAt = (sec) => t(nextDay(sec) ? "arrive_tomorrow" : "arrive_at", { time: clock(sec) });
  function chain(j) {
    const parts = [];
    j.legs.forEach((l) => {
      if (l.type === "bus") parts.push(badge(l.line));
      else if (l.m >= 60) parts.push(walkChip(l.m));
    });
    return parts.join(CHEV);
  }

  // Transbordos justos: minutos que quedan entre llegar (andando) a la parada del siguiente bus y
  // que este salga. Se sigue proponiendo la opción, pero con aviso si son menos de 5.
  const TIGHT_MIN = 5;
  function transferSlack(j, k) {   // k: posición del tramo a pie del transbordo en j.legs
    const prev = j.legs[k - 1], next = j.legs[k + 1];
    return (next.dep - prev.arr - j.legs[k].m / lastTrip.plan.WALK) / 60;
  }
  const isTight = (j) => j.legs.some((l, k) => l.transfer && transferSlack(j, k) < TIGHT_MIN);

  // Opción que se ve en el mapa: la elegida o, si no, la primera de la lista.
  function shownKey() {
    const lt = lastTrip;
    if (trip.sel) return trip.sel;
    return walkOnTop() || !lt.opts[0] ? "walk" : lt.opts[0].key;
  }
  // ¿Va primero ir andando? Si llega antes que el primer bus (o, con "llegar a las", deja salir más
  // tarde), salvo con la preferencia "Menos a pie": entonces siempre al final, detrás de los buses.
  function walkOnTop() {
    const lt = lastTrip;
    if (!lt.walk) return false;
    const first = lt.opts[0];
    if (!first) return true;
    if (tripPref === "walk") return false;
    return lt.arriveBy
      ? (lt.arriveBy - lt.base) / 1000 - walkMin(lt.walk.dist) * 60 >= first.dep
      : startSec() + walkMin(lt.walk.dist) * 60 <= first.arr;
  }
  const busKey = (l) => `${l.line}|${l.board}`;

  // Lista de opciones; con una elegida, sus pasos.
  function renderTripResult() {
    const lt = lastTrip;
    if (!lt) return;
    const box = $("#trip-result");
    const walkMinTotal = lt.walk ? walkMin(lt.walk.dist) : Infinity;
    const notes = (lt.approx || []).map((label) => `<p class="trip-note">${esc(t("approx_note", { label }))}</p>`).join("");
    if (trip.sel) {
      const j = trip.sel === "walk" ? null : lt.opts.find((o) => o.key === trip.sel);
      if (trip.sel === "walk" || j) { box.innerHTML = renderSteps(j) + notes; return; }
      trip.sel = null;
    }
    const shown = shownKey();
    const cur = (k) => (k === shown ? ' aria-current="true"' : "");
    const arr = !!lt.arriveBy;
    const items = lt.opts.map((j) => {
      const first = j.legs.find((l) => l.type === "bus");
      const total = (j.arr - (arr ? j.dep : startSec())) / 60;
      const leave = arr ? `${esc(t("leave_time", { time: clock(Math.max(j.dep, nowSec())) }))} · ` : "";
      const late = j.late ? ` <span class="warn">${esc(t("arrive_late_live"))}</span>` : "";
      return `<li><button type="button" class="opt" data-opt="${esc(j.key)}"${cur(j.key)}>
        <span class="chain">${chain(j)}</span>
        <span class="eta">${durHtml(total)}</span>
        <span class="when">${leave}${whenHtml(first)} · ${esc(stopName(first.board))}${late}${first.doubtful ? ` <span class="warn">${esc(t("no_live"))}</span>` : ""}${isTight(j) ? ` <span class="warn">${esc(t("tight_transfer"))}</span>` : ""}</span>
        <span class="arr">${esc(arriveAt(j.arr))}</span>
      </button></li>`;
    });
    // Ir andando: primero si llega antes que cualquier bus; si no, al final.
    if (lt.walk) {
      const T = arr ? (lt.arriveBy - lt.base) / 1000 : null;
      const walkDep = arr ? T - walkMinTotal * 60 : startSec();
      const w = `<li><button type="button" class="opt walk" data-opt="walk"${cur("walk")}>
        <span class="chain">${walkChip(lt.walk.dist)}<span class="what">${esc(t("on_foot"))}</span></span>
        <span class="eta">${durHtml(walkMinTotal)}</span>
        <span class="when">${arr ? `${esc(t("leave_time", { time: clock(Math.max(walkDep, nowSec())) }))} · ` : ""}${esc(fmtDist(lt.walk.dist))}</span>
        <span class="arr">${esc(arriveAt(walkDep + walkMinTotal * 60))}</span>
      </button></li>`;
      if (walkOnTop()) items.unshift(w); else items.push(w);
    }
    let head = "";
    if (lt.planError) head = `<p class="trip-note">${esc(t("plan_error"))}</p>`;
    else if (!lt.opts.length) head = `<div class="state"><strong>${esc(t("plan_none"))}</strong></div>`;
    if (lt.arriveLate && trip.when) head = `<p class="trip-note warn">${esc(t("arrive_impossible", { time: trip.when.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }))}</p>` + head;
    if (!items.length) head = `<div class="state"><strong>${esc(t("trip_none"))}</strong></div>`;
    const date = lt.plan ? new Date(`${lt.plan.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" }) : "";
    // Origen de los tiempos, encima de las opciones.
    const src = lt.opts.length ? `<p class="trip-note">${lt.live ? "" : `${esc(t("live_checking"))} `}${esc(t("plan_note", { date }))}</p>` : "";
    box.innerHTML = `${head}${src}<ul class="trip-opts">${items.join("")}</ul>${notes}`;
  }

  function renderSteps(j) {
    const lt = lastTrip;
    const back = `<button type="button" class="opts-back" data-opt-back="1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>${esc(t("all_options"))}</button>`;
    if (!j) {
      // A pie: como antes de existir el planificador.
      const date = new Date(`${lt.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
      const osm = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${fmtLL(trip.a.ll)}%3B${fmtLL(trip.b.ll)}`;
      return `${back}<div class="trip-card"><span class="mode">${ICON_WALK}</span>
          <span class="what">${esc(t("on_foot"))}<small>${fmtDist(lt.walk.dist)}</small></span>
          <span class="eta">${durHtml(walkMin(lt.walk.dist))}</span></div>
        <p class="trip-note">${esc(t("trip_source", { date }))} <a href="${osm}" target="_blank" rel="noopener">${esc(t("trip_compare"))}</a></p>`;
    }
    const steps = [];
    const legs = j.legs;
    legs.forEach((l, k) => {
      if (l.type === "walk") {
        const next = legs[k + 1];
        let text;
        if (k === 0) text = t("step_walk_to", { dist: fmtDist(l.m), place: stopName(next.board) });
        else if (l.transfer) text = l.m < 30 ? t("step_change_same") : t("step_change", { dist: fmtDist(l.m), place: stopName(next.board) });
        else text = t("step_walk_dest", { dist: fmtDist(l.m) });
        if (l.m < 30 && !l.transfer) return;
        // Transbordo: siempre la espera prevista en la parada hasta que pase el siguiente bus
        // (con aviso si es menos de 5 min).
        let tight = "";
        if (l.transfer) {
          const n = Math.max(0, Math.floor(transferSlack(j, k)));
          tight = n < TIGHT_MIN ? `<small class="warn">${esc(n < 1 ? t("tight_step_0") : t("tight_step", { n }))}</small>`
            : `<small class="wait">${esc(t("wait_step", { dur: n < 60 ? `${n} ${t("min")}` : `${Math.floor(n / 60)} h ${n % 60} ${t("min")}` }))}</small>`;
        }
        steps.push(`<li class="step walk"><span class="ico">${ICON_WALK}</span>
          <span class="txt">${esc(text)}<small>${esc(t("walk", { n: walkMin(l.m) }))}</small>${tight}</span></li>`);
      } else {
        const ln = lines[l.line];
        const dest = ln && ln.sentidos[l.dir] ? ln.sentidos[l.dir].destino : "";
        const rideMin = Math.max(1, Math.round((l.arr - l.dep) / 60));
        const where = l.live ? ` <span class="bus-pos" data-bus="${esc(busKey(l))}"></span>` : "";
        steps.push(`<li class="step bus" style="--lc:${ln ? ln.color : "var(--ink)"}"><span class="ico">${badge(l.line)}</span>
          <span class="txt">${esc(t("step_board", { stop: stopName(l.board), id: lastTrip.plan.ids[l.board] }))}
            <small class="dest">${esc(t("towards", { dest }))}</small>
            <small>${whenHtml(l)}${where}${l.doubtful ? ` · <span class="warn">${esc(t("no_live"))}</span>` : ""}</small>
            <small>${esc(t(l.stops === 1 ? "stops_1" : "stops_n", { n: l.stops, min: rideMin }))}</small>
            <b class="alight">${esc(t("step_alight", { stop: stopName(l.alight) }))}</b></span></li>`);
      }
    });
    steps.push(`<li class="step end"><span class="ico"><span class="pin pin-b">B</span></span>
      <span class="txt">${esc(t(nextDay(j.arr) ? "step_arrive_tomorrow" : "step_arrive", { time: clock(j.arr) }))}</span></li>`);
    const total = (j.arr - (lt.arriveBy ? j.dep : startSec())) / 60;
    const leave = lt.arriveBy ? `<p class="trip-note">${esc(t("leave_time", { time: clock(Math.max(j.dep, nowSec())) }))}${j.late ? ` · <span class="warn">${esc(t("arrive_late_live"))}</span>` : ""}</p>` : "";
    return `${back}<div class="opt-head"><span class="chain">${chain(j)}</span><span class="eta">${durHtml(total)}</span></div>${leave}
      <ol class="steps">${steps.join("")}</ol>`;
  }

  // ---------- Opciones: mapa ----------
  function walkPath(from, to) {
    const k = `${fmtLL(from)}|${fmtLL(to)}`;
    if (!walkCache.has(k)) {
      const r = lastTrip.net.route(from, to);
      walkCache.set(k, r ? [from, ...r.coords, to] : [from, to]);
      if (walkCache.size > 200) walkCache.delete(walkCache.keys().next().value);
    }
    return walkCache.get(k);
  }
  // Trazado de un tramo en bus. Muchos recorridos mezclan el trazado principal de la línea y algún
  // ramal (p. ej. los viajes de la 18A que empiezan en Rúa do Areal), así que cada trozo entre
  // paradas se dibuja con el trazado que pasa por ellas (a menos de 60 m), alargándolo todo lo
  // posible; si ninguno pasa, en línea recta. Así siempre empieza y acaba en sus paradas.
  const ON_SHAPE = 60;
  function busPath(leg) {
    const plan = lastTrip.plan;
    const pt = plan.pats[leg.pat];
    return pathThrough(lines[pt.l].sentidos[pt.s], pt.p.map((i) => plan.ids[i]), leg.from, leg.to, `p${pt.n}`);
  }
  // Recorrido de un sentido de línea pasando por una lista de paradas (ids), de la posición "from" a
  // la "to": cada trozo con el trazado (principal o ramal) que pasa por sus paradas.
  const pathCache = new Map();
  function pathThrough(dir, ids, from = 0, to = ids.length - 1, key = null) {
    const k = key || ids.join(",");
    if (!pathCache.has(k)) {
      const lls = ids.map((id) => byId.get(id).ll);
      const shapes = [dir.trazado, ...(dir.ramales || [])].map((enc) => {
        const sh = BUS.prepare(BUS.decode(enc));
        const r = BUS.stopsAlong(sh, lls);
        return { sh, along: r.map((x) => x.along), off: r.map((x) => x.off) };
      });
      pathCache.set(k, { shapes, lls });
      if (pathCache.size > 300) pathCache.delete(pathCache.keys().next().value);
    }
    const { shapes, lls } = pathCache.get(k);
    const out = [];
    const leg = { to };
    let kk = from;
    while (kk < leg.to) {
      let best = null;
      for (const s of shapes) {
        let e = kk;
        while (e < leg.to && s.off[e] <= ON_SHAPE && s.off[e + 1] <= ON_SHAPE && s.along[e + 1] >= s.along[e]) e++;
        if (e > kk && (!best || e > best.e)) best = { s, e };
      }
      if (best) {
        if (!out.length) out.push(lls[kk]);   // desde la propia parada
        out.push(...BUS.slice(best.s.sh, best.s.along[kk], best.s.along[best.e]));
        kk = best.e;
      } else {
        out.push(lls[kk], lls[kk + 1]);
        kk++;
      }
    }
    out.push(lls[leg.to]);                   // hasta la propia parada
    return out;
  }
  const walkStyle = (pts) => [
    L.polyline(pts, { renderer, color: "#FFFFFF", weight: 10, opacity: 0.95, interactive: false, lineCap: "round", lineJoin: "round" }),
    L.polyline(pts, { renderer, color: "#1C6FA8", weight: 6, opacity: 1, interactive: false, lineCap: "round", lineJoin: "round", dashArray: "0.1 10" }),
  ];

  // Dibuja la opción elegida (o la primera de la lista) y sus buses en camino.
  function drawTrip(fit) {
    const lt = lastTrip;
    tripLayer.clearLayers();
    tripBuses.forEach((b) => { if (b.marker) b.marker.remove(); if (b.tail) b.tail.forEach((x) => x.remove()); });
    tripBuses = [];
    clearInterval(tripTick);
    tripRouteOn = !!lt;
    updateStopVisibility();
    if (!lt) return;
    const shown = shownKey();
    const all = [trip.a.ll, trip.b.ll];
    if (shown === "walk") {
      if (!lt.walk) { if (fit) fitPoints(all, 17); return; }
      const r = lt.walk.r;
      const thin = { renderer, color: "#1C6FA8", weight: 2.5, opacity: 0.8, dashArray: "3 6", interactive: false };
      if (r.offFrom > 4) L.polyline([trip.a.ll, r.from], thin).addTo(tripLayer);
      if (r.offTo > 4) L.polyline([r.to, trip.b.ll], thin).addTo(tripLayer);
      walkStyle(r.coords).forEach((p) => p.addTo(tripLayer));
      if (fit) fitPoints([...r.coords, ...all], 17);
      return;
    }
    const j = lt.opts.find((o) => o.key === shown);
    if (!j) return;
    const plan = lt.plan;
    const llOf = (i) => byId.get(plan.ids[i]).ll;
    j.legs.forEach((l, k) => {
      if (l.type !== "walk") return;
      const from = k === 0 ? trip.a.ll : llOf(j.legs[k - 1].alight);
      const to = k === j.legs.length - 1 ? trip.b.ll : llOf(j.legs[k + 1].board);
      if (l.m < 8) return;
      const pts = walkPath(from, to);
      walkStyle(pts).forEach((p) => p.addTo(tripLayer));
      all.push(...pts);
    });
    j.legs.forEach((l) => {
      if (l.type !== "bus") return;
      const ln = lines[l.line];
      const pts = busPath(l);
      L.polyline(pts, { renderer, color: "#13222C", weight: 11, opacity: 0.35, interactive: false }).addTo(tripLayer);
      L.polyline(pts, { renderer, color: "#FFFFFF", weight: 9, opacity: 1, interactive: false }).addTo(tripLayer);
      L.polyline(pts, { renderer, color: ln.color, weight: 6, opacity: 1, interactive: false, lineCap: "round" }).addTo(tripLayer);
      // Paradas del tramo: las intermedias, pequeñas; la de subida y la de bajada, más grandes.
      const pt = plan.pats[l.pat];
      for (let k = l.from + 1; k < l.to; k++) {
        L.circleMarker(llOf(pt.p[k]), { renderer, radius: 3.5, weight: 2.5, color: ln.color, fillColor: "#FFFFFF", fillOpacity: 1, interactive: false }).addTo(tripLayer);
      }
      [l.board, l.alight].forEach((i) => L.circleMarker(llOf(i), { renderer, radius: 6.5, weight: 4, color: ln.color, fillColor: "#FFFFFF", fillOpacity: 1, interactive: false }).addTo(tripLayer));
      all.push(...pts);
      // Bus en camino hacia la parada de subida (con dato en vivo).
      if (l.live && isFinite(Number(l.live.metros))) {
        const dir = ln.sentidos[l.dir];
        const loc = BUS.locateStop(dir, plan.ids[l.board], (id) => (byId.get(id) || {}).ll || [0, 0]);
        if (loc) tripBuses.push({ key: busKey(l), loc, est: l.live, at: l.live._at, color: ln.color, texto: ln.texto });
      }
    });
    drawTripBuses();
    if (tripBuses.length) tripTick = setInterval(drawTripBuses, 1000);
    else tripTick = setInterval(() => { if (lastTrip && !trip.sel) renderTripResult(); }, 15000);   // "pasa en N min" al día
    if (fit) fitPoints(all, 17);
  }

  const busState = (b) => BUS.busAt(b.loc, b.est, (Date.now() - b.at) / 60000);
  function drawTripBuses() {
    tripBuses.forEach((b) => {
      const s = busState(b);
      // En los pasos: a qué distancia va el bus de la parada.
      const span = document.querySelector(`#trip-result .bus-pos[data-bus="${CSS.escape(b.key)}"]`);
      if (span) span.textContent = s && s.state === "route" ? `· ${t("bus_far", { dist: fmtDist(s.left) })}` : s && s.state === "depot" ? `· ${t("bus_depot")}` : "";
      if (!s || s.state !== "route") {
        if (b.marker) { b.marker.remove(); b.marker = null; }
        if (b.tail) { b.tail.forEach((x) => x.remove()); b.tail = null; }
        return;
      }
      if (!b.marker) b.marker = busMarker(b.color, b.texto, s.ll);
      placeBus(b.marker, s, b.est, b.at);
      // Lo que le queda por recorrer hasta la parada de subida: mismo color, más clarito.
      const sh = b.loc.shape;
      const pts = s.d <= b.loc.along ? BUS.slice(sh, s.d, b.loc.along)
        : [...BUS.slice(sh, s.d, sh.length), ...BUS.slice(sh, 0, b.loc.along)];   // circular: termina la vuelta
      if (!b.tail) {
        b.tail = [
          L.polyline(pts, { renderer: tailRenderer, color: "#FFFFFF", weight: 8, opacity: 0.9, interactive: false, lineCap: "round", lineJoin: "round" }),
          L.polyline(pts, { renderer: tailRenderer, color: b.color, weight: 5, opacity: 0.45, interactive: false, lineCap: "round", lineJoin: "round" }),
        ];
        b.tail.forEach((x) => x.addTo(map));
      } else b.tail.forEach((x) => x.setLatLngs(pts));
    });
  }

  // Elegir una opción (entra en el historial: el botón Atrás del móvil vuelve a la lista).
  $("#trip-result").addEventListener("click", (e) => {
    if (e.target.closest("[data-opt-back]")) { goBack(); return; }
    const b = e.target.closest("button[data-opt]");
    if (!b || !lastTrip) return;
    trip.sel = b.dataset.opt;
    history.pushState({ d: ((history.state && history.state.d) || 0) + 1, opt: trip.sel }, "", location.href);
    renderTripResult();
    drawTrip(true);
    $("#trip-result").scrollTop = 0;
  });

  map.on("click", (e) => {
    if (!tripOpen() || justHeld()) return;
    // Si se toca un número de portal, se elige esa dirección; si no, el punto del mapa.
    const pt = numAt(e.containerPoint);
    if (pt) setEnd(targetEnd(), { kind: "addr", ll: pt.ll, label: `${pt.s.name}, ${pt.n}` });
    else setEnd(targetEnd(), { kind: "map", ll: [e.latlng.lat, e.latlng.lng] });
  });

  // ---------- "Desde aquí / Hasta aquí" en cualquier punto del mapa (32) ----------
  // Móvil: mantener pulsado; ordenador: botón derecho. Un menú pequeño en ese punto (con la
  // dirección si hay un portal a menos de 40 m) para usarlo como origen o destino de Cómo llegar.
  const hereMenu = L.popup({ closeButton: false, className: "here-pop", autoPanPaddingTopLeft: [16, 16], autoPanPaddingBottomRight: [16, 16] });
  let herePoint = null;
  function nearestAddr(ll) {
    if (!dirData) return null;
    const d = 0.0005;
    let best = null, bd = 40;
    for (const pt of dirData.portalsIn(ll[0] - d, ll[1] - d * 1.35, ll[0] + d, ll[1] + d * 1.35)) {
      const m = haversine(ll, pt.ll);
      if (m < bd) { bd = m; best = pt; }
    }
    return best ? { kind: "addr", ll: best.ll, label: `${best.s.name}, ${best.n}` } : null;
  }
  function openHereMenu(latlng) {
    const ll = [latlng.lat, latlng.lng];
    const fill = () => {
      herePoint = nearestAddr(ll) || { kind: "map", ll };
      herePoint.at = ll;
      const box = L.DomUtil.create("div", "here");
      box.innerHTML = `<small>${esc(herePoint.kind === "addr" ? herePoint.label : t("map_point"))}</small>
        <button type="button" data-here="a"><span class="pin pin-a">A</span>${esc(t("here_from"))}</button>
        <button type="button" data-here="b"><span class="pin pin-b">B</span>${esc(t("here_to"))}</button>`;
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener("click", (e) => { const b = e.target.closest("[data-here]"); if (b) useHere(b.dataset.here); });
      hereMenu.setLatLng(latlng).setContent(box);
      if (!map.hasLayer(hereMenu)) hereMenu.openOn(map);
    };
    fill();
    if (!dirData) ensureDir().then(() => { if (map.hasLayer(hereMenu) && herePoint && herePoint.at === ll) fill(); }).catch(() => {});
  }
  function useHere(which) {
    const p = herePoint && { kind: herePoint.kind, ll: herePoint.ll, label: herePoint.label };
    map.closePopup(hereMenu);
    if (!p) return;
    if (p.kind !== "addr") delete p.label;
    if (tripOpen()) { setEnd(which, p); return; }
    // Fuera de Cómo llegar: un viaje nuevo (con "Mi ubicación" como origen si se elige el destino).
    trip.a = trip.b = null;
    trip.sel = null;
    trip[which] = p;
    if (which === "b" && me && !farFromVigo(me)) trip.a = { kind: "me", ll: me };
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`.replace(/\/+$/, ""));
  }
  // Ordenador (y algunos móviles, que lo lanzan al mantener pulsado): botón derecho.
  map.on("contextmenu", (e) => { if (justHeld()) return; heldAt = Date.now(); openHereMenu(e.latlng); });
  // Móvil: pulsación larga propia (no todos los navegadores lanzan "contextmenu"), sin moverse.
  {
    let timer = null, x0 = 0, y0 = 0;
    const el = map.getContainer();
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener("touchstart", (e) => {
      cancel();
      if (e.touches.length !== 1 || e.target.closest(".leaflet-popup, .leaflet-control")) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        heldAt = Date.now();
        const r = el.getBoundingClientRect();
        openHereMenu(map.containerPointToLatLng([x0 - r.left, y0 - r.top]));
        if (navigator.vibrate) try { navigator.vibrate(15); } catch { /* sin vibración */ }
      }, 550);
    }, { passive: true });
    el.addEventListener("touchmove", (e) => { if (timer && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 10) cancel(); }, { passive: true });
    el.addEventListener("touchend", cancel, { passive: true });
    el.addEventListener("touchcancel", cancel, { passive: true });
  }

  ["a", "b"].forEach((w) => {
    const inp = $(`#trip-${w}`);
    inp.addEventListener("focus", () => {
      trip.picking = null;
      renderTripFields();
      openSugg(w);
      if (inp.dataset.keep) { delete inp.dataset.keep; inp.setSelectionRange(inp.value.length, inp.value.length); }
      else inp.select();
      if (!isDesktop()) panel.dataset.state = "full";
    });
    inp.addEventListener("input", () => openSugg(w));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = $("#trip-sugg button[data-site], #trip-sugg button[data-addr], #trip-sugg button[data-id]");
        if (first) first.click();
      }
      if (e.key === "Escape") { inp.value = endLabel(trip[w]); inp.blur(); closeSugg(); setPanel(baseState()); }
    });
  });
  // Tocar una sugerencia no quita el foco al campo (así se puede seguir escribiendo).
  $("#trip-sugg").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  $("#trip-sugg").addEventListener("click", (e) => {
    e.stopPropagation();   // aquí una parada no abre su ficha: se elige como origen o destino
    const w = trip.editing || targetEnd();
    const stop = e.target.closest("button[data-id]");
    if (e.target.closest("button[data-recent-clear]")) { recents = []; saveRecents(); openSugg(w); return; }
    if (stop) { addRecent({ id: stop.dataset.id }); setEnd(w, stopEnd(byId.get(stop.dataset.id))); return; }
    const rc = e.target.closest("button[data-recent]");
    if (rc) { const r = recents[Number(rc.dataset.recent)]; if (r) { addRecent(r); setEnd(w, { kind: "addr", ll: r.ll, label: r.label }); } return; }
    const si = e.target.closest("button[data-site]");
    if (si && sitesData) { const s = sitesData[Number(si.dataset.site)]; addRecent({ ll: s.ll, label: s.name, site: s.type }); setEnd(w, { kind: "addr", ll: s.ll, label: s.name }); return; }
    const ad = e.target.closest("button[data-addr]");
    if (ad && dirData) {
      const st = dirData.streets[Number(ad.dataset.addr)];
      const inp = $(`#trip-${w}`);
      if (ad.dataset.fill) {
        // Calle sin número: se completa el campo para escribir el número a continuación.
        inp.value = `${st.name}, `;
        inp.dataset.keep = "1";
        inp.focus();
        delete inp.dataset.keep;
        inp.setSelectionRange(inp.value.length, inp.value.length);
        openSugg(w);
        return;
      }
      const num = ad.dataset.num;
      const r = dirData.resolve(st, num);
      addRecent({ ll: r.ll, label: num ? `${st.name}, ${num}` : st.name });
      setEnd(w, { kind: "addr", ll: r.ll, label: num ? `${st.name}, ${num}` : st.name, approx: !r.exact && !!num });
      return;
    }
    const sp = e.target.closest("button[data-trip]");
    if (!sp) return;
    if (sp.dataset.trip === "me") {
      getPosition((ll) => {
        if (!farFromVigo(ll)) { setEnd(w, { kind: "me", ll }); return; }
        // Lejos de Vigo: no se usa como origen ni destino y el mapa se queda donde está.
        const inp = $(`#trip-${w}`);
        inp.value = endLabel(trip[w]);
        inp.blur();
        closeSugg();
        renderTripFields();
        setPanel(baseState());
        toast(t("geo_far_trip"));
      });
    } else {
      // Elegir en el mapa: el siguiente toque en el mapa marca el punto.
      $(`#trip-${w}`).blur();
      closeSugg();
      trip.picking = w;
      renderTripFields();
      setPanel("min");
      toast(t("pick_map_hint"));
    }
  });
  document.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => {
    const w = b.dataset.clear;
    trip[w] = null;
    tripReplace();
    $(`#trip-${w}`).value = "";
    renderTripFields();
    computeTrip(false);
    $(`#trip-${w}`).focus();
  }));
  $("#trip-swap").addEventListener("click", () => {
    [trip.a, trip.b] = [trip.b, trip.a];
    tripReplace();
    renderTripFields();
    computeTrip(false);
  });
  // Hora de salida: "Salir ahora" o una hora concreta (hasta 7 días después).
  const localISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  function renderWhen() {
    const inp = $("#when-at");
    const later = !!trip.when;
    $("#when-now").setAttribute("aria-pressed", !later);
    inp.closest(".when-pick").classList.toggle("on", later);
    $("#when-mode").value = trip.whenMode === "arr" ? "arr" : "dep";
    $("#when-mode-text").textContent = t(trip.whenMode === "arr" ? "arrive_by" : "leave_at");
    $("#when-text").textContent = later ? whenLabel(trip.when) : t("when_pick");
    if (later) inp.value = localISO(trip.when);
    else if (document.activeElement !== inp) inp.value = "";
  }
  // "hoy, 13:00", "mañana, 8:30" o "vie 23 oct, 9:00", en el idioma de la web.
  function whenLabel(d) {
    const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
    if (day === 0) return t("when_today", { time });
    if (day === 1) return t("when_tomorrow", { time });
    return `${d.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
  }
  // En el ordenador, tocar la hora abre el calendario del navegador (en el móvil ya lo hace el toque).
  $("#when-at").addEventListener("click", (e) => { try { e.target.showPicker(); } catch { /* no lo admite */ } });
  $("#when-mode").addEventListener("change", (e) => {
    trip.whenMode = e.target.value;
    renderWhen();
    if (!trip.when) { $("#when-at").focus(); return; }   // falta elegir la hora
    trip.sel = null;
    tripReplace();
    computeTrip(false);
  });
  $("#when-now").addEventListener("click", () => {
    if (!trip.when) return;
    trip.when = null;
    renderWhen();
    tripReplace();
    computeTrip(false);
  });
  $("#when-at").addEventListener("focus", (e) => {
    const now = new Date();
    e.target.min = localISO(now);
    e.target.max = localISO(new Date(now.getTime() + 7 * 86400000));
    if (!e.target.value) e.target.value = localISO(new Date(Math.ceil(now.getTime() / 900000) * 900000 + 900000));
  });
  // La hora elegida. También al cerrar el selector sin cambiar la hora propuesta al abrirlo (en el
  // móvil, aceptar esa hora no lanza "change") y al salir de él con otra hora escrita.
  function applyWhen(e) {
    const d = e.target.value ? new Date(e.target.value) : null;   // "AAAA-MM-DDTHH:MM" se lee como hora local
    const now = Date.now();
    const when = d && !isNaN(d) && d.getTime() > now + 60000 ? new Date(Math.min(d.getTime(), now + 7 * 86400000)) : null;
    if (when && trip.when && when.getTime() === trip.when.getTime()) return;
    if (!when && !trip.when) { renderWhen(); return; }
    trip.when = when;
    renderWhen();
    tripReplace();
    computeTrip(false);
  }
  $("#when-at").addEventListener("change", applyWhen);
  $("#when-at").addEventListener("blur", applyWhen);

  // Volver (junto al título): sale de "Cómo llegar" al menú principal de una vez, aunque se hayan
  // visto varios trayectos u opciones seguidos (cada uno queda en el historial del navegador).
  let toHome = false;
  $("#trip-back").addEventListener("click", () => {
    const d = (history.state && history.state.d) || 0;
    const steps = d - (tripEntryDepth == null ? d : tripEntryDepth) + 1;
    tripEntryDepth = null;
    if (steps > 0 && d - steps >= 0) { toHome = true; history.go(-steps); }
    else navigate("", { replace: true });
  });
  // Tras salir, si se ha vuelto a otra pantalla (p. ej. la parada desde la que se abrió), al inicio.
  addEventListener("popstate", () => {
    if (!toHome) return;
    toHome = false;
    if (location.hash && location.hash !== "#") navigate("", { replace: true });
  });
  $("#go-trip").addEventListener("click", () => { clearTimeout(qTimer); $("#q").blur(); openTrip(); });
  $("#trip-here").addEventListener("click", () => { if (current) openTrip(stopEnd(current)); });

  // ---------- Eventos ----------
  // Paradas y líneas se abren desde cualquier lista o chapa del panel.
  $("#panel").addEventListener("click", (e) => {
    const stop = e.target.closest("button[data-id]");
    // Abrir un resultado anula la búsqueda que estaba a punto de ejecutarse.
    if (stop || e.target.closest("button[data-line], button[data-addr], button[data-site]")) clearTimeout(qTimer);
    const fromSearch = mode === "search" || mode === "recent";
    if (e.target.closest("#list button[data-recent-clear]")) {
      recents = []; saveRecents(); $("#q").focus(); render(); return;
    }
    const rc = e.target.closest("#list button[data-recent]");
    if (rc) {
      const r = recents[Number(rc.dataset.recent)];
      if (!r) return;
      addRecent(r);
      $("#q").blur();
      openPlace({ ll: r.ll, label: r.label, approx: false, ...(r.site ? { site: r.site } : {}) });
      return;
    }
    // Sitio del buscador: su ficha (como una dirección), con su tipo.
    const si = e.target.closest("#list button[data-site]");
    if (si && sitesData) {
      const s = sitesData[Number(si.dataset.site)];
      addRecent({ ll: s.ll, label: s.name, site: s.type });
      $("#q").blur();
      openPlace({ ll: s.ll, label: s.name, approx: false, site: s.type });
      return;
    }
    // Dirección del buscador: sin número, se completa "Calle, " para escribirlo; con número, se abre.
    const ad = e.target.closest("#list button[data-addr]");
    if (ad && dirData) {
      const st = dirData.streets[Number(ad.dataset.addr)];
      if (ad.dataset.fill) {
        const q = $("#q");
        q.value = `${st.name}, `;
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
        render();
        return;
      }
      const num = ad.dataset.num;
      const r = dirData.resolve(st, num);
      addRecent({ ll: r.ll, label: num ? `${st.name}, ${num}` : st.name });
      $("#q").blur();
      openPlace({ ll: r.ll, label: num ? `${st.name}, ${num}` : st.name, approx: !r.exact && !!num });
      return;
    }
    if (stop) { if (fromSearch && stop.closest("#list")) addRecent({ id: stop.dataset.id }); $("#q").blur(); navigate(stop.dataset.id); return; }
    const line = e.target.closest("button[data-line]");
    if (line) {
      $("#q").blur();
      // Si se abre desde una parada, la línea se muestra alrededor de esa parada y con su próximo bus.
      lineRuta = line.dataset.ruta || null;
      // Desde una parada, la fila abre solo los viajes con ese letrero (como una línea aparte).
      const ruta = current && line.dataset.raw;
      navigate(`linea/${line.dataset.line}${current ? `/${current.id}` : ""}${ruta ? `/${encodeURIComponent(ruta)}` : ""}`);
      return;
    }
    const dir = e.target.closest("button[data-dir]");
    if (dir && active) {
      active.dir = Number(dir.dataset.dir);
      $("#line-dirs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b === dir));
      renderLineStops();
      drawLine();
      // Si este sentido también pasa por la parada de origen, se siguen sus buses.
      const d = lines[active.code].sentidos[active.dir];
      if (active.from && active.fromDir !== active.dir && (d.paradas.includes(active.from) || (d.otras || []).includes(active.from))) {
        active.fromDir = active.dir;
        startTrack();
      }
      drawBus();
      renderBusCard();
    }
  });
  $("#back").addEventListener("click", goBack);
  $("#line-back").addEventListener("click", goBack);
  // Desde una variante, la línea completa (con sus dos sentidos y todos sus ramales).
  $("#line-whole").addEventListener("click", () => {
    if (active) navigate(`linea/${active.code}${active.from ? `/${active.from}` : ""}`);
  });
  $("#fav").addEventListener("click", () => {
    if (!current) return;
    const id = current.id;
    if (favStop(id)) favs.stops = favs.stops.filter((f) => f.id !== id);
    else favs.stops.push({ id, lines: null });
    saveFavs();
    updateFavBtn();
    refreshIcon(current);
    toast(favStop(id) ? t("fav_added") : t("fav_removed"));
  });
  $("#refresh").addEventListener("click", () => loadArrivals(false));
  // Tocar una pestaña muestra su contenido aunque quedara texto en el buscador.
  TABS.forEach((tab) => $(`#tab-${tab}`).addEventListener("click", () => { $("#q").value = ""; setTab(tab); }));
  $("#locate").addEventListener("click", locate);

  $("#q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { if (location.hash) navigate(""); else render(); }, 120);
  });
  $("#q").addEventListener("focus", () => {
    if (!isDesktop()) $("#panel").dataset.state = "full";
    if (!$("#q").value.trim() && !location.hash && recents.length) render();
  });
  // Al salir del buscador vacío, vuelve la pestaña. Tocar un reciente no quita el foco (mousedown).
  $("#q").addEventListener("blur", () => setTimeout(() => { if (mode === "recent" && document.activeElement !== $("#q")) render(); }, 150));
  $("#list").addEventListener("mousedown", (e) => { if (mode === "recent" && e.target.closest("button")) e.preventDefault(); });
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Resultados al día con lo escrito antes de abrir el primero.
      clearTimeout(qTimer);
      if (!location.hash) render();
      const first = $("#list button[data-id], #list button[data-line], #list button[data-site], #list button[data-addr]");
      if (first) first.click();
    }
    if (e.key === "Escape") { e.target.value = ""; render(); }
  });

  // Hoja inferior (móvil): deslizar hacia abajo la reduce hasta dejar casi todo el mapa a la vista;
  // hacia arriba la amplía. Tocar el asa alterna entre minimizada y normal.
  // En "Cómo llegar" con origen y destino, alto (como la ficha de parada) para ver las opciones.
  const baseState = () => (current || (tripOpen() && trip.a && trip.b) ? "stop" : "peek");
  function setPanel(state) {
    if (isDesktop()) return;
    panel.dataset.state = state;
    if (state !== "full") $("#q").blur();
  }
  $("#grip").addEventListener("click", () => setPanel(panel.dataset.state === "min" ? baseState() : "min"));
  let y0 = null, t0 = 0;
  panel.addEventListener("touchstart", (e) => {
    // Solo desde la cabecera del panel, para no interferir con el desplazamiento de las listas.
    if (!e.target.closest(".grip, .brand, .stop-head, .tabs, .dirs, .stop-foot")) { y0 = null; return; }
    y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  panel.addEventListener("touchend", (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    if (Math.abs(dy) < 30 || Date.now() - t0 > 800) return;
    const st = panel.dataset.state;
    if (dy > 0) setPanel(st === "full" ? baseState() : "min");
    else setPanel(st === "min" ? baseState() : "full");
  });
  // Tocar la cabecera con el panel minimizado lo vuelve a abrir.
  panel.addEventListener("click", (e) => {
    if (panel.dataset.state === "min" && !e.target.closest(".lang, .grip")) setPanel(baseState());
  }, true);
  panel.addEventListener("transitionend", () => map.invalidateSize());

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (current) loadArrivals(false);
    if (track) fetchTrack();
    if (tripOpen() && lastTrip && lastTrip.plan && lastTrip.cands.length) { planSearch(); refreshLive(tripSeq); }
  });

  // ---------- Idioma: textos fijos y desplegable con banderas ----------
  function applyStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    document.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
    $("#lang-btn .flag").innerHTML = flagSvg(lang);
    $("#lang-code").textContent = lang.toUpperCase();
    $("#lang-menu").innerHTML = I18N.langs.map((l) =>
      `<li role="option" aria-selected="${l.code === lang}"><button type="button" data-lang="${l.code}" lang="${l.code}">
        <svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${l.flag}</svg><span>${esc(l.name)}</span></button></li>`).join("");
  }
  function toggleLangMenu(open) {
    const menu = $("#lang-menu");
    const show = open != null ? open : menu.hidden;
    menu.hidden = !show;
    $("#lang-btn").setAttribute("aria-expanded", show);
    if (show) (menu.querySelector('[aria-selected="true"] button') || menu.querySelector("button")).focus();
  }
  function setLang(code) {
    lang = code;
    try { localStorage.setItem(LANG_KEY, code); } catch { /* sin almacenamiento */ }
    applyStatic();
    // Volver a pintar lo que está a la vista con el idioma nuevo.
    if (current) {
      showStop(current.id, { repaint: true });
      if (lastArrivals) renderArrivals(lastArrivals);
      showUpdated();
    } else if (active) showLine(active.code, active.from, active.variant ? active.variant.ruta : null);
    else if (place) { document.title = "Próximo Vitrasa"; showPlace(); }
    else if (!$("#info").hidden) showInfo();
    else if (!$("#sched").hidden && sched) showSched(sched.id);
    else if (tripOpen()) {
      renderTripFields();
      renderWhen();
      if (lastTrip) renderTripResult(); else computeTrip(false);
      document.title = `${t("trip_title")} · Próximo Vitrasa`;
    }
    else render();
  }
  $("#lang-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleLangMenu(); });
  $("#lang-menu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lang]");
    if (!b) return;
    toggleLangMenu(false);
    $("#lang-btn").focus();
    if (b.dataset.lang !== lang) setLang(b.dataset.lang);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".lang")) toggleLangMenu(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#lang-menu").hidden) { toggleLangMenu(false); $("#lang-btn").focus(); }
  });
  applyStatic();

  // ---------- App instalable ----------
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
