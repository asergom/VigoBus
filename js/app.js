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

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; }
  }
  function saveFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* sin almacenamiento */ }
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
    else if (favs.includes(s.id)) bg = "#13222C";
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
    // En "Cómo llegar", con un viaje dibujado, las paradas se atenúan (y se ocultan al alejar).
    const route = !!active || tripRouteOn;
    map.getContainer().classList.toggle("hide-stops", route && map.getZoom() < LINE_STOPS_ZOOM);
    map.getContainer().classList.toggle("dim-stops", tripRouteOn);
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

  function renderNear() {
    if (!stops.length) return;
    if (me) {
      const items = nearest(me, NEAR_COUNT).map(({ s, d }) => stopItem(s, { dist: d, sub: t("walk", { n: walkMin(d) }) }));
      fillList(items, "");
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

  function renderFav() {
    const list = favs.map((id) => byId.get(id)).filter(Boolean);
    if (!list.length) {
      fillList([], t("no_favs"));
      return;
    }
    fillList(list.map((s) => stopItem(s, { dist: me ? haversine(me, s.ll) : null })), "");
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
    const items = [];
    if (lineRes.length) {
      items.push(groupHead(t("res_lines")));
      lineRes.forEach((code) => items.push(lineItem(code, highlight(lines[code].nombre, tokens))));
    }
    if (addr.length) items.push(groupHead(t("res_addr")), ...addr);
    if ((lineRes.length || addr.length) && shown.length) items.push(groupHead(t("res_stops")));
    shown.forEach((s) => items.push(stopItem(s, { nameHtml: highlight(s.name, tokens), dist: me ? haversine(me, s.ll) : null })));
    fillList(items,
      res.length || lineRes.length || addr.length ? (res.length > shown.length ? t("many", { n: res.length }) : "") : t("no_results", { q }));
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

  function renderLines() {
    if (!lines) { fillList([], t("loading_lines")); return; }
    const items = Object.keys(lines).map((code) => lineItem(code));
    fillList(items, items.length ? "" : t("lines_error"));
  }

  const TABS = ["near", "fav", "lines"];
  function render() {
    const q = $("#q").value.trim();
    if (q) { mode = "search"; renderSearch(q); return; }
    if (mode === "search") mode = TABS.find((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true") || "near";
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
    if (h.startsWith("dir/") && showPlace(h.slice(4))) return;
    if (h.startsWith("linea/")) {
      // #linea/18A o #linea/18A/5660 (abierta desde esa parada: se ve el próximo bus hacia ella).
      const [code, from] = h.slice(6).split("/");
      if (!lines) return;                      // se reintenta al cargar las líneas
      if (lines[code]) { showLine(code, byId.has(from) ? from : null); return; }
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
    ["home", "line", "stop", "trip", "place"].forEach((v) => ($(`#${v}`).hidden = v !== id));
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
    active.stops = new Set([...dir.paradas, ...(dir.otras || [])]);
    updateStopVisibility();
    stops.forEach((s) => {
      const on = active.stops.has(s.id);
      s.marker.setOpacity(on ? 1 : 0.12).setZIndexOffset(on ? 500 : 0);
      if (on || prev.has(s.id)) refreshIcon(s);
    });
    // Trazado con borde para que se vea sobre cualquier fondo.
    // Ramales (solo algunos viajes): trazo continuo más fino, debajo del recorrido principal.
    (dir.ramales || []).forEach((r) => {
      const rp = decodePolyline(r);
      L.polyline(rp, { renderer, color: "#13222C", weight: 7, opacity: 0.25, interactive: false }).addTo(lineGroup);
      L.polyline(rp, { renderer, color: "#FFFFFF", weight: 6, opacity: 1, interactive: false }).addTo(lineGroup);
      L.polyline(rp, { renderer, color: l.color, weight: 3.5, opacity: 0.9, interactive: false, lineCap: "round" }).addTo(lineGroup);
    });
    const pts = decodePolyline(dir.trazado);
    L.polyline(pts, { renderer, color: "#13222C", weight: 11, opacity: 0.35, interactive: false }).addTo(lineGroup);
    L.polyline(pts, { renderer, color: "#FFFFFF", weight: 9, opacity: 1, interactive: false }).addTo(lineGroup);
    L.polyline(pts, { renderer, color: l.color, weight: 6, opacity: 1, interactive: false, lineCap: "round" }).addTo(lineGroup);
  }

  // ¿Se ve este punto en la zona del mapa que no tapa el panel?
  function inView(ll) {
    const p = map.latLngToContainerPoint(ll), size = map.getSize(), m = 24;
    const left = isDesktop() ? panel.getBoundingClientRect().right : 0;
    const bottom = isDesktop() ? size.y : size.y - Math.max(260, innerHeight * 0.46);
    return p.x > left + m && p.x < size.x - m && p.y > m && p.y < bottom - m;
  }

  // Encuadra unos puntos en la zona del mapa que no tapa el panel.
  function fitPoints(pts, maxZoom) {
    const r = panel.getBoundingClientRect();
    const opts = isDesktop()
      ? { paddingTopLeft: [r.right + 24, 24], paddingBottomRight: [24, 24] }
      : { paddingTopLeft: [16, 16], paddingBottomRight: [16, Math.max(260, innerHeight * 0.46) + 16] };
    map.fitBounds(L.latLngBounds(pts), { ...opts, maxZoom });
  }

  function fitLine() {
    const l = lines[active.code];
    const d = l.sentidos[active.dir];
    fitPoints([d.trazado, ...(d.ramales || [])].flatMap(decodePolyline), 16);
  }

  function showLine(code, from = null) {
    leaveStop();
    const changed = !active || active.code !== code || active.from !== from;
    if (changed) {
      clearLine();
      // Abierta desde una parada: el sentido que pasa por ella (si pasan los dos, el de la fila tocada).
      const dirWith = from ? dirThrough(lines[code], from, lineRuta) : -1;
      active = { code, dir: Math.max(0, dirWith), stops: new Set(), from, fromDir: dirWith };
    }
    const l = lines[code];
    showView("line");
    const badge = $("#line-badge");
    badge.textContent = code;
    badge.style.setProperty("--lc", l.color);
    badge.style.setProperty("--lt", l.texto);
    $("#line-name").textContent = l.nombre;
    $("#line-dirs").hidden = l.sentidos.length < 2;
    $("#line-dirs").innerHTML = l.sentidos.map((d, i) =>
      `<button role="tab" type="button" data-dir="${i}" aria-selected="${i === active.dir}">${esc(t("towards", { dest: d.destino }))}</button>`).join("");
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

  // Sentido de la línea que pasa por una parada; si pasan varios, el que va hacia "ruta".
  function dirThrough(l, id, ruta) {
    const idx = l.sentidos.map((d, i) => (d.paradas.includes(id) || (d.otras || []).includes(id) ? i : -1)).filter((i) => i >= 0);
    if (idx.length > 1 && ruta) {
      const hit = idx.find((i) => norm(l.sentidos[i].destino) === norm(ruta));
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
    if (track.marker) track.marker.remove();
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
    if (both) {
      const same = mine.filter((e) => norm(String(e.ruta || "")) === norm(l.sentidos[tr.dir].destino));
      if (same.length) mine = same;
    }
    mine.sort((a, b) => Number(a.minutos) - Number(b.minutos));
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

  // Situación del bus ahora mismo (avanza entre actualizaciones).
  function busNow() {
    if (!track || !track.est) return null;
    const min = (Date.now() - track.at) / 60000;
    return BUS.busAt(track.loc, track.est, min);
  }

  const BUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a2.5 2.5 0 0 1 2.5 2.5v10.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V6A2.5 2.5 0 0 1 7 3.5z"/><rect x="6" y="17" width="3" height="3" rx="1"/><rect x="15" y="17" width="3" height="3" rx="1"/><rect class="w" x="6.6" y="6.2" width="10.8" height="5" rx="1"/><circle class="w" cx="8" cy="14.4" r="1.1"/><circle class="w" cx="16" cy="14.4" r="1.1"/></svg>';

  function drawBus() {
    const tr = track;
    if (!tr) return;
    const b = busNow();
    // Solo en el sentido que va hacia la parada y con el bus ya en camino.
    if (!b || b.state !== "route" || !active || active.dir !== tr.dir) {
      if (tr.marker) tr.marker.remove();
      return;
    }
    if (!tr.marker) {
      const l = lines[tr.code];
      const icon = L.divIcon({
        className: "bus-pin",
        html: `<span class="bus-dot" style="--lc:${l.color};--lt:${l.texto}"><span class="bus-arrow"></span>${BUS_ICON}</span>`,
        iconSize: [34, 34], iconAnchor: [17, 17],
      });
      tr.marker = L.marker(b.ll, { icon, keyboard: false, interactive: false, zIndexOffset: 900 });
    }
    tr.marker.setLatLng(b.ll);
    if (!map.hasLayer(tr.marker)) tr.marker.addTo(map);
    const arrow = tr.marker.getElement() && tr.marker.getElement().querySelector(".bus-arrow");
    if (arrow) arrow.style.transform = `rotate(${Math.round(b.bearing)}deg)`;
  }

  function renderBusCard() {
    const card = $("#line-bus");
    const tr = track;
    if (!tr) { card.hidden = true; return; }
    const l = lines[tr.code];
    const s = byId.get(tr.stop);
    const b = busNow();
    let main, sub = "";
    if (tr.state === "loading") main = "…";
    else if (tr.state === "error") main = esc(t("times_error"));
    else if (tr.state === "none") main = esc(t("bus_none"));
    else if (b && b.state === "depot") {
      const m = Math.max(0, Math.round(Number(tr.est.minutos) - (Date.now() - tr.at) / 60000));
      main = `${esc(t("bus_depot"))}`;
      sub = `<span class="eta"><b>${m}</b><span>${esc(t("min"))}</span></span>`;
    } else if (b) {
      const m = Math.round(Number(tr.est.minutos) - (Date.now() - tr.at) / 60000);
      main = `${esc(fmtDist(b.left))} · ${esc(t("bus_estimated"))}`;
      sub = m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>`
                   : `<span class="eta"><b>${m}</b><span>${esc(t("min"))}</span></span>`;
    } else main = esc(t("bus_none"));
    card.style.setProperty("--lc", l.color);
    card.style.setProperty("--lt", l.texto);
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
    const list = $("#line-stops");
    list.style.setProperty("--lc", l.color);
    const item = (s) => stopItem(s, { dist: me ? haversine(me, s.ll) : null, noLines: true });
    const items = dir.paradas.map((id) => byId.get(id)).filter(Boolean).map(item);
    const extra = (dir.otras || []).map((id) => byId.get(id)).filter(Boolean);
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
  }

  function updateFavBtn() {
    const on = current && favs.includes(current.id);
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
      renderArrivals(data.estimaciones || []);
      lastArrivalsId = s.id;
      lastUpdate = new Date();
      showUpdated();
    } catch (e) {
      if (seq !== reqSeq) return;
      lastArrivals = null;
      box.innerHTML = `<div class="state"><strong>${esc(t("times_error"))}</strong>
        ${esc(t("times_error_body", { infobus: "\u0000" })).replace("\u0000",
          `<a href="${INFOBUS_URL(s.id)}" target="_blank" rel="noopener">Infobus</a>`)}</div>`;
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

  function renderArrivals(list) {
    lastArrivals = list;
    const box = $("#arrivals");
    if (!list.length) {
      box.innerHTML = `<div class="state"><strong>${esc(t("empty"))}</strong> ${esc(t("empty_body"))}</div>`;
      return;
    }
    // Agrupa por línea y destino; muestra el próximo y el siguiente.
    const groups = new Map();
    list.forEach((b) => {
      const linea = normLine(b.linea);
      const ruta = titleCase(String(b.ruta || ""));
      const k = `${linea}|${ruta}`;
      if (!groups.has(k)) groups.set(k, { linea, ruta, mins: [] });
      groups.get(k).mins.push(Number(b.minutos));
    });
    const rows = [...groups.values()]
      .map((g) => ({ ...g, mins: g.mins.filter((m) => !isNaN(m)).sort((a, b) => a - b) }))
      .filter((g) => g.mins.length)
      .sort((a, b) => a.mins[0] - b.mins[0]);

    box.innerHTML = rows.map((g) => {
      const m = g.mins[0];
      const eta = m <= 0 ? `<span class="eta now"><b>${esc(t("arriving"))}</b></span>`
                         : `<span class="eta"><b>${m}</b><span>${esc(t("min"))}</span></span>`;
      const next = g.mins[1] != null ? `<small>${esc(t("next", { n: g.mins[1] }))}</small>` : "";
      // Toda la fila (número, destino y tiempo) abre la línea en el mapa.
      const known = lines && lines[g.linea];
      const tag = known ? "button" : "div";
      const attrs = known ? ` type="button" data-line="${esc(g.linea)}" data-ruta="${esc(g.ruta)}" title="${esc(t("see_line", { code: g.linea }))}"` : "";
      return `<${tag} class="arrival"${attrs}>
        <span class="badge"${lineStyle(g.linea)}>${esc(g.linea)}</span>
        <span class="route"><b>${esc(g.ruta)}</b>${next}</span>
        ${eta}
      </${tag}>`;
    }).join("");
  }

  // ---------- Dirección (calle y número) ----------
  // En la dirección web: #dir/<lat,lon>~<Calle, número>[~a] ("~a": posición aproximada).
  const PIN_SVG = '<svg viewBox="0 0 34 44" aria-hidden="true"><path d="M17 42s-14-13.2-14-24.5a14 14 0 0 1 28 0C31 28.8 17 42 17 42z" fill="#D3202F" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="17.5" r="5" fill="#fff"/></svg>';
  const placeIcon = L.divIcon({ className: "place-pin", html: PIN_SVG, iconSize: [34, 44], iconAnchor: [17, 42] });
  let placeMarker = null;
  let place = null;   // { ll, label, approx }

  const placeToken = (p) => `dir/${fmtLL(p.ll)}~${encodeURIComponent(p.label)}${p.approx ? "~a" : ""}`;
  function openPlace(p, { replace = false } = {}) { navigate(placeToken(p), { replace }); }

  function showPlace(tok) {
    const parts = location.hash.slice(1).split("/").slice(1).join("/").split("~").map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    const m = (parts[0] || "").match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (!m || !parts[1]) return false;
    leaveStop();
    clearLine();
    const next = { ll: [Number(m[1]), Number(m[2])], label: parts[1], approx: parts[2] === "a" };
    const same = place && placeToken(place) === placeToken(next);   // p. ej., al cambiar de idioma
    showView("place");
    place = next;
    document.title = `${place.label} · Próximo Vitrasa`;
    $("#place-name").textContent = place.label;
    $("#place-meta").textContent = place.approx ? t("addr_approx") : /\d/.test(place.label) ? t("addr_exact") : t("addr_whole");
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
  $("#place-trip").addEventListener("click", () => { if (place) openTrip({ kind: "addr", ll: place.ll, label: place.label, approx: place.approx }); });

  // ---------- Números de portal en el mapa ----------
  // Con zoom alto se dibujan todos los números de portal conocidos (aunque el mapa base ya traiga
  // algunos). Van en un lienzo propio; solo los que caen en pantalla y sin que se pisen entre ellos.
  // Tocar uno abre esa dirección (o, en "Cómo llegar", la elige como origen o destino).
  // Mismo zoom desde el que el mapa de OpenStreetMap empieza a pintar sus números de portal (17).
  const NUM_ZOOM = 17;
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
    ctx.font = `600 ${z >= 19 ? 13 : z >= 18 ? 12 : 11}px Barlow, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.95)";
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
      ctx.fillStyle = sel ? "#D3202F" : "#5B4F45";
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
  map.on("click", (e) => {
    if (tripOpen()) return;   // en "Cómo llegar" lo atiende su propio manejador
    const pt = numAt(e.containerPoint);
    if (pt) openPlace({ ll: pt.ll, label: `${pt.s.name}, ${pt.n}`, approx: false }, { replace: panel.dataset.view === "place" });
  });

  // ---------- Cómo llegar (de A a B; por ahora, a pie) ----------
  // Cada extremo es { kind: "stop" | "me" | "map", ll: [lat, lon], id? }. En la dirección: #ir/<A>/<B>,
  // con "p1234" para una parada y "lat,lon" para un punto. La ruta se calcula en el propio
  // dispositivo con la red peatonal de OpenStreetMap (js/peaton.js), sin servicios externos.
  const trip = { a: null, b: null, editing: null, picking: null, sel: null, when: null };   // sel: opción abierta; when: salida más tarde (Date) o null = ahora
  const tripLayer = L.layerGroup().addTo(map);
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

  function showTrip(h) {
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
    if (!isDesktop() && panel.dataset.state !== "full") panel.dataset.state = "peek";
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
    const items = [specialItem("me", ICON_ME, t("my_location")), specialItem("map", ICON_MAP, t("pick_map"))];
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
      if (addr.length) items.push(groupHead(t("res_addr")), ...addr);
      if (res.length) {
        items.push(groupHead(t("res_stops")));
        res.forEach((s) => items.push(stopItem(s, { nameHtml: highlight(s.name, tokens), noLines: true, dist: me ? haversine(me, s.ll) : null })));
      }
      if (!addr.length && !res.length) {
        const li = document.createElement("li");
        li.className = "group-head";
        li.textContent = t("trip_no_stops", { q: typed });
        items.push(li);
      }
    }
    $("#trip-sugg").replaceChildren(...items);
    $("#trip-sugg").hidden = false;
    $("#trip-result").hidden = true;
  }
  function closeSugg() {
    trip.editing = null;
    $("#trip-sugg").hidden = true;
    $("#trip-result").hidden = false;
  }

  // ---------- Planificador: en bus de A a B ----------
  // Las opciones salen de los horarios (js/planificador.js, data/viajes.json) y después se corrigen
  // con los tiempos en vivo de las paradas de subida. Cada 30 s se vuelve a calcular todo.
  const PLAN = window.PV_PLAN;
  const MAX_WALK_STOP = 1000;        // metros a pie como máximo hasta la parada de subida o desde la de bajada
  const liveCache = new Map();       // parada → { at, list | null } (null: sin respuesta)
  const walkCache = new Map();       // tramos a pie ya calculados
  const patShape = new Map();        // recorrido → { sh, along[] }
  let tripTimer = null, tripTick = null, tripBuses = [];

  function stopTripLive() {
    clearTimeout(tripTimer);
    clearInterval(tripTick);
    tripTimer = tripTick = null;
    tripBuses.forEach((b) => b.marker && b.marker.remove());
    tripBuses = [];
  }

  // Paradas alcanzables a pie desde un punto: Map(índice de parada en el plan → metros).
  function stopsAround(net, plan, ll) {
    for (const max of [MAX_WALK_STOP, MAX_WALK_STOP * 1.6]) {
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

  // Buses en vivo de la línea y sentido de un tramo, en su parada de subida.
  function liveFor(plan, leg) {
    const e = liveCache.get(plan.ids[leg.board]);
    if (!e || !e.list) return null;
    const l = lines[leg.line];
    const dest = l && l.sentidos[leg.dir] ? norm(l.sentidos[leg.dir].destino) : null;
    const id = plan.ids[leg.board];
    const both = l && l.sentidos.filter((d) => d.paradas.includes(id) || (d.otras || []).includes(id)).length > 1;
    return e.list.filter((x) => normLine(x.linea) === leg.line && (!both || !dest || norm(String(x.ruta || "")) === dest))
      .map((x) => ({ ...x, _at: e.at }));
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
    }
    const st = history.state && history.state.opt;
    trip.sel = st && (st === "walk" || lastTrip.opts.some((o) => o.key === st)) ? st : null;
    renderTripResult();
    drawTrip(fit);
    if (lastTrip.cands.length) refreshLive(seq);
  }

  // Hora de salida: la elegida o, si no hay (o ya pasó), ahora.
  const tripStart = () => (trip.when && trip.when > new Date() ? trip.when : new Date());

  // Busca de nuevo (las opciones del horario, aún sin tiempos en vivo).
  function planSearch() {
    const lt = lastTrip;
    const start = tripStart();
    lt.start = start;
    lt.base = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    lt.cands = lt.plan.search({ origins: lt.origins, dests: lt.dests, walk: lt.walk ? lt.walk.dist : Infinity, time: start });
    if (!lt.live) lt.opts = lt.plan.choose(lt.cands, start, lt.walk ? lt.walk.dist : Infinity);
  }

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
    const txt = m <= 0 ? t("arriving") : m < 60 ? t("in_min", { n: m }) : t("at_time", { time: clock(leg.dep) });
    if (leg.live) return `<span class="live">${esc(txt)}</span>`;
    return `<span class="sched">${esc(m < 60 && m > 0 ? t("at_time", { time: clock(leg.dep) }) : txt)} · ${esc(t("scheduled"))}</span>`;
  }
  function chain(j) {
    const parts = [];
    j.legs.forEach((l) => {
      if (l.type === "bus") parts.push(badge(l.line));
      else if (l.m >= 60) parts.push(walkChip(l.m));
    });
    return parts.join(CHEV);
  }

  // Opción que se ve en el mapa: la elegida o, si no, la primera de la lista.
  function shownKey() {
    const lt = lastTrip;
    if (trip.sel) return trip.sel;
    const walkFirst = lt.walk && (!lt.opts[0] || startSec() + walkMin(lt.walk.dist) * 60 <= lt.opts[0].arr);
    return walkFirst || !lt.opts[0] ? "walk" : lt.opts[0].key;
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
    const items = lt.opts.map((j) => {
      const first = j.legs.find((l) => l.type === "bus");
      const total = (j.arr - startSec()) / 60;
      return `<li><button type="button" class="opt" data-opt="${esc(j.key)}"${cur(j.key)}>
        <span class="chain">${chain(j)}</span>
        <span class="eta">${durHtml(total)}</span>
        <span class="when">${whenHtml(first)} · ${esc(stopName(first.board))}${first.doubtful ? ` <span class="warn">${esc(t("no_live"))}</span>` : ""}</span>
        <span class="arr">${esc(t("arrive_at", { time: clock(j.arr) }))}</span>
      </button></li>`;
    });
    // Ir andando: primero si llega antes que cualquier bus; si no, al final.
    if (lt.walk) {
      const w = `<li><button type="button" class="opt walk" data-opt="walk"${cur("walk")}>
        <span class="chain">${walkChip(lt.walk.dist)}<span class="what">${esc(t("on_foot"))}</span></span>
        <span class="eta">${durHtml(walkMinTotal)}</span>
        <span class="when">${esc(fmtDist(lt.walk.dist))}</span>
        <span class="arr">${esc(t("arrive_at", { time: clock(startSec() + walkMinTotal * 60) }))}</span>
      </button></li>`;
      const firstBus = lt.opts[0];
      if (!firstBus || startSec() + walkMinTotal * 60 <= firstBus.arr) items.unshift(w); else items.push(w);
    }
    let head = "";
    if (lt.planError) head = `<p class="trip-note">${esc(t("plan_error"))}</p>`;
    else if (!lt.opts.length) head = `<div class="state"><strong>${esc(t("plan_none"))}</strong></div>`;
    if (!items.length) head = `<div class="state"><strong>${esc(t("trip_none"))}</strong></div>`;
    const date = lt.plan ? new Date(`${lt.plan.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" }) : "";
    const foot = lt.opts.length ? `<p class="trip-note">${lt.live ? "" : `${esc(t("live_checking"))} `}${esc(t("plan_note", { date }))}</p>` : "";
    box.innerHTML = `${head}<ul class="trip-opts">${items.join("")}</ul>${notes}${foot}`;
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
        steps.push(`<li class="step walk"><span class="ico">${ICON_WALK}</span>
          <span class="txt">${esc(text)}<small>${esc(t("walk", { n: walkMin(l.m) }))}</small></span></li>`);
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
      <span class="txt">${esc(t("step_arrive", { time: clock(j.arr) }))}</span></li>`);
    const total = (j.arr - startSec()) / 60;
    return `${back}<div class="opt-head"><span class="chain">${chain(j)}</span><span class="eta">${durHtml(total)}</span></div>
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
  function busPath(leg) {
    const plan = lastTrip.plan;
    const pt = plan.pats[leg.pat];
    if (!patShape.has(pt.n)) {
      const dir = lines[pt.l].sentidos[pt.s];
      const sh = BUS.prepare(BUS.decode(pt.f < 0 ? dir.trazado : dir.ramales[pt.f]));
      const along = BUS.stopsAlong(sh, pt.p.map((i) => byId.get(plan.ids[i]).ll)).map((r) => r.along);
      patShape.set(pt.n, { sh, along });
    }
    const { sh, along } = patShape.get(pt.n);
    return along[leg.to] > along[leg.from] ? BUS.slice(sh, along[leg.from], along[leg.to])
      : [byId.get(plan.ids[leg.board]).ll, byId.get(plan.ids[leg.alight]).ll];
  }
  const walkStyle = (pts) => [
    L.polyline(pts, { renderer, color: "#FFFFFF", weight: 10, opacity: 0.95, interactive: false, lineCap: "round", lineJoin: "round" }),
    L.polyline(pts, { renderer, color: "#1C6FA8", weight: 6, opacity: 1, interactive: false, lineCap: "round", lineJoin: "round", dashArray: "0.1 10" }),
  ];

  // Dibuja la opción elegida (o la primera de la lista) y sus buses en camino.
  function drawTrip(fit) {
    const lt = lastTrip;
    tripLayer.clearLayers();
    tripBuses.forEach((b) => b.marker && b.marker.remove());
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
      [l.board, l.alight].forEach((i) => L.circleMarker(llOf(i), { renderer, radius: 6, weight: 3.5, color: ln.color, fillColor: "#FFFFFF", fillOpacity: 1, interactive: false }).addTo(tripLayer));
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
      if (!s || s.state !== "route") { if (b.marker) b.marker.remove(); return; }
      if (!b.marker) {
        b.marker = L.marker(s.ll, { keyboard: false, interactive: false, zIndexOffset: 900, icon: L.divIcon({
          className: "bus-pin", iconSize: [34, 34], iconAnchor: [17, 17],
          html: `<span class="bus-dot" style="--lc:${b.color};--lt:${b.texto}"><span class="bus-arrow"></span>${BUS_ICON}</span>` }) });
      }
      b.marker.setLatLng(s.ll);
      if (!map.hasLayer(b.marker)) b.marker.addTo(map);
      const arrow = b.marker.getElement() && b.marker.getElement().querySelector(".bus-arrow");
      if (arrow) arrow.style.transform = `rotate(${Math.round(s.bearing)}deg)`;
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
    if (!tripOpen()) return;
    // Si se toca un número de portal, se elige esa dirección; si no, el punto del mapa.
    const pt = numAt(e.containerPoint);
    if (pt) setEnd(targetEnd(), { kind: "addr", ll: pt.ll, label: `${pt.s.name}, ${pt.n}` });
    else setEnd(targetEnd(), { kind: "map", ll: [e.latlng.lat, e.latlng.lng] });
  });

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
        const first = $("#trip-sugg button[data-addr], #trip-sugg button[data-id]");
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
    if (stop) { setEnd(w, stopEnd(byId.get(stop.dataset.id))); return; }
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
    if (later) inp.value = localISO(trip.when);
    else if (document.activeElement !== inp) inp.value = "";
  }
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
  $("#when-at").addEventListener("change", (e) => {
    const d = e.target.value ? new Date(e.target.value) : null;   // "AAAA-MM-DDTHH:MM" se lee como hora local
    const now = Date.now();
    trip.when = d && !isNaN(d) && d.getTime() > now + 60000 ? new Date(Math.min(d.getTime(), now + 7 * 86400000)) : null;
    renderWhen();
    tripReplace();
    computeTrip(false);
  });

  $("#trip-back").addEventListener("click", goBack);
  $("#go-trip").addEventListener("click", () => { clearTimeout(qTimer); $("#q").blur(); openTrip(); });
  $("#trip-here").addEventListener("click", () => { if (current) openTrip(stopEnd(current)); });

  // ---------- Eventos ----------
  // Paradas y líneas se abren desde cualquier lista o chapa del panel.
  $("#panel").addEventListener("click", (e) => {
    const stop = e.target.closest("button[data-id]");
    // Abrir un resultado anula la búsqueda que estaba a punto de ejecutarse.
    if (stop || e.target.closest("button[data-line], button[data-addr]")) clearTimeout(qTimer);
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
      $("#q").blur();
      openPlace({ ll: r.ll, label: num ? `${st.name}, ${num}` : st.name, approx: !r.exact && !!num });
      return;
    }
    if (stop) { $("#q").blur(); navigate(stop.dataset.id); return; }
    const line = e.target.closest("button[data-line]");
    if (line) {
      $("#q").blur();
      // Si se abre desde una parada, la línea se muestra alrededor de esa parada y con su próximo bus.
      lineRuta = line.dataset.ruta || null;
      navigate(`linea/${line.dataset.line}${current ? `/${current.id}` : ""}`);
      return;
    }
    const dir = e.target.closest("button[data-dir]");
    if (dir && active) {
      active.dir = Number(dir.dataset.dir);
      $("#line-dirs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b === dir));
      renderLineStops();
      drawLine();
      drawBus();
    }
  });
  $("#back").addEventListener("click", goBack);
  $("#line-back").addEventListener("click", goBack);
  $("#fav").addEventListener("click", () => {
    if (!current) return;
    const id = current.id;
    favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    saveFavs();
    updateFavBtn();
    refreshIcon(current);
    toast(favs.includes(id) ? t("fav_added") : t("fav_removed"));
  });
  $("#refresh").addEventListener("click", () => loadArrivals(false));
  // Tocar una pestaña muestra su contenido aunque quedara texto en el buscador.
  TABS.forEach((tab) => $(`#tab-${tab}`).addEventListener("click", () => { $("#q").value = ""; setTab(tab); }));
  $("#locate").addEventListener("click", locate);

  $("#q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { if (location.hash) navigate(""); else render(); }, 120);
  });
  $("#q").addEventListener("focus", () => { if (!isDesktop()) $("#panel").dataset.state = "full"; });
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Resultados al día con lo escrito antes de abrir el primero.
      clearTimeout(qTimer);
      if (!location.hash) render();
      const first = $("#list button[data-id], #list button[data-line], #list button[data-addr]");
      if (first) first.click();
    }
    if (e.key === "Escape") { e.target.value = ""; render(); }
  });

  // Hoja inferior (móvil): deslizar hacia abajo la reduce hasta dejar casi todo el mapa a la vista;
  // hacia arriba la amplía. Tocar el asa alterna entre minimizada y normal.
  const baseState = () => (current ? "stop" : "peek");
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
    } else if (active) showLine(active.code, active.from);
    else if (place) { document.title = "Próximo Vitrasa"; showPlace(); }
    else if (tripOpen()) {
      renderTripFields();
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
