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
  let lineOrigin = null;          // parada desde la que se abrió la línea
  let active = null;              // línea iluminada: { code, dir }

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
    map.getContainer().classList.toggle("hide-stops", !!active && map.getZoom() < LINE_STOPS_ZOOM);
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

  fetch("data/lineas.json")
    .then((r) => r.json())
    .then((d) => {
      lines = d;
      // Con las líneas ya cargadas: abrir un enlace #linea/… o dar color a las chapas visibles.
      if (location.hash.startsWith("#linea/")) route();
      else if (current) $("#stop-lines").innerHTML = current.lines.map((l) => lineChip(l)).join("");
      else render();
    })
    .catch(() => { lines = {}; });

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
    const items = [];
    if (lineRes.length) {
      items.push(groupHead(t("res_lines")));
      lineRes.forEach((code) => items.push(lineItem(code, highlight(lines[code].nombre, tokens))));
      if (shown.length) items.push(groupHead(t("res_stops")));
    }
    shown.forEach((s) => items.push(stopItem(s, { nameHtml: highlight(s.name, tokens), dist: me ? haversine(me, s.ll) : null })));
    fillList(items,
      res.length || lineRes.length ? (res.length > shown.length ? t("many", { n: res.length }) : "") : t("no_results", { q }));
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

  function locate() {
    // En "Cómo llegar" solo se centra el mapa en tu posición, sin salir de la vista.
    if (tripOpen()) { getPosition((ll) => focusOn(ll, 16)); return; }
    getPosition(() => {
        if (location.hash) navigate("");
        $("#q").value = "";
        setTab("near");
        if (haversine(me, VIGO) > 25000) {
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
    if (h.startsWith("linea/")) {
      const code = h.slice(6);
      if (!lines) return;                      // se reintenta al cargar las líneas
      if (lines[code]) { showLine(code); return; }
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
    ["home", "line", "stop", "trip"].forEach((v) => ($(`#${v}`).hidden = v !== id));
    panel.dataset.view = id;
    if (id !== "trip") leaveTrip();
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

  function showLine(code) {
    leaveStop();
    const changed = !active || active.code !== code;
    if (changed) {
      clearLine();
      // Abierta desde una parada: el sentido que pasa por ella.
      const dirWith = lineOrigin ? lines[code].sentidos.findIndex((d) => d.paradas.includes(lineOrigin) || (d.otras || []).includes(lineOrigin)) : -1;
      active = { code, dir: Math.max(0, dirWith), stops: new Set() };
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
      const origin = lineOrigin && byId.get(lineOrigin);
      // Desde una parada: un poco más alejado que la ficha, pero sin encuadrar la línea entera;
      // el usuario aleja el mapa si quiere verla completa.
      if (origin) { focusOn(origin.ll, LINE_STOPS_ZOOM); selRing.setLatLng(origin.ll).addTo(map); }
      else fitLine();
    }
    lineOrigin = null;
  }

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
      const url = `${API_URL}?id=${encodeURIComponent(s.id)}&ttl=5&tipo=TRANSPORTE-ESTIMACION-PARADA`;
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      // La API puede responder en Latin-1 sin avisar: si no es UTF-8 válido, se lee como Windows-1252
      // para que las tildes y la ñ no salgan como "�".
      const buf = await r.arrayBuffer();
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch { text = new TextDecoder("windows-1252").decode(buf); }
      const data = JSON.parse(text);
      if (seq !== reqSeq) return;
      // El nombre oficial sustituye a los genéricos tipo "Parada 1234".
      const official = data.parada && data.parada[0] && data.parada[0].nombre;
      if (official && /^Parada \d/.test(s.name)) $("#stop-name").textContent = titleCase(official);
      renderArrivals(data.estimaciones || []);
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
      const attrs = known ? ` type="button" data-line="${esc(g.linea)}" title="${esc(t("see_line", { code: g.linea }))}"` : "";
      return `<${tag} class="arrival"${attrs}>
        <span class="badge"${lineStyle(g.linea)}>${esc(g.linea)}</span>
        <span class="route"><b>${esc(g.ruta)}</b>${next}</span>
        ${eta}
      </${tag}>`;
    }).join("");
  }

  // ---------- Cómo llegar (de A a B; por ahora, a pie) ----------
  // Cada extremo es { kind: "stop" | "me" | "map", ll: [lat, lon], id? }. En la dirección: #ir/<A>/<B>,
  // con "p1234" para una parada y "lat,lon" para un punto. La ruta se calcula en el propio
  // dispositivo con la red peatonal de OpenStreetMap (js/peaton.js), sin servicios externos.
  const trip = { a: null, b: null, editing: null, picking: null };
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

  function endToken(p) { return !p ? "" : p.kind === "stop" ? `p${p.id}` : fmtLL(p.ll); }
  function parseEnd(tok, prev) {
    if (!tok) return null;
    if (prev && endToken(prev) === tok) return prev;   // conserva "Mi ubicación" al volver
    if (tok[0] === "p" && byId.has(tok.slice(1))) return stopEnd(byId.get(tok.slice(1)));
    const m = tok.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    return m ? { kind: "map", ll: [Number(m[1]), Number(m[2])] } : null;
  }
  function endLabel(p) {
    if (!p) return "";
    if (p.kind === "stop") return `${byId.get(p.id).name} (${p.id})`;
    return p.kind === "me" ? t("my_location") : t("map_point");
  }
  const pinIcon = (w) => L.divIcon({ className: "trip-pin", html: `<span class="pin pin-${w}">${w.toUpperCase()}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  function openTrip(b) {
    if (!trip.a && me) trip.a = { kind: "me", ll: me };
    if (b) trip.b = b;
    navigate(`ir/${endToken(trip.a)}/${endToken(trip.b)}`);
  }

  function showTrip(h) {
    leaveStop();
    clearLine();
    const [, ta = "", tb = ""] = h.split("/");
    trip.a = parseEnd(ta, trip.a);
    trip.b = parseEnd(tb, trip.b);
    trip.picking = null;
    showView("trip");
    document.title = `${t("trip_title")} · Próximo Vitrasa`;
    if (!isDesktop() && panel.dataset.state !== "full") panel.dataset.state = "peek";
    closeSugg();
    renderTripFields();
    computeTrip(true);
  }

  function leaveTrip() {
    tripSeq++;
    trip.picking = null;
    lastTrip = null;
    tripLayer.clearLayers();
    Object.values(tripPins).forEach((m) => m.remove());
  }

  function setEnd(which, p) {
    trip[which] = p;
    trip.picking = null;
    $("#toast").hidden = true;   // el aviso de "toca el mapa" ya no hace falta
    const h = `#ir/${endToken(trip.a)}/${endToken(trip.b)}`.replace(/\/+$/, "");
    history.replaceState(history.state, "", h);
    $(`#trip-${which}`).blur();
    closeSugg();
    renderTripFields();
    setPanel(baseState());
    computeTrip(true);
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

  // Sugerencias mientras se escribe en Desde o Hasta.
  function openSugg(which) {
    trip.editing = which;
    const inp = $(`#trip-${which}`);
    const q = inp.value.trim();
    const typed = q && q !== endLabel(trip[which]) ? q : "";
    $(`[data-clear="${which}"]`).hidden = !inp.value;
    const items = [specialItem("me", ICON_ME, t("my_location")), specialItem("map", ICON_MAP, t("pick_map"))];
    if (typed) {
      const tokens = norm(typed).split(" ").filter(Boolean);
      const res = matchStops(typed).slice(0, 40);
      if (res.length) {
        items.push(groupHead(t("res_stops")));
        res.forEach((s) => items.push(stopItem(s, { nameHtml: highlight(s.name, tokens), noLines: true, dist: me ? haversine(me, s.ll) : null })));
      } else {
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

  async function computeTrip(fit) {
    const seq = ++tripSeq;
    tripLayer.clearLayers();
    lastTrip = null;
    const box = $("#trip-result");
    const ends = [trip.a, trip.b].filter(Boolean).map((p) => p.ll);
    if (ends.length < 2) {
      box.innerHTML = `<p class="trip-note">${esc(t("trip_hint"))}</p>`;
      if (fit && ends.length) focusOn(ends[0], Math.max(map.getZoom(), 15));
      // Se adelanta la descarga de la red para que la ruta salga al instante.
      window.PV_PEATON.load().catch(() => {});
      return;
    }
    box.innerHTML = `<p class="trip-note">${esc(t("trip_loading"))}</p>`;
    let net;
    try { net = await window.PV_PEATON.load(); }
    catch { if (seq === tripSeq) box.innerHTML = `<div class="state"><strong>${esc(t("trip_net_error"))}</strong></div>`; return; }
    if (seq !== tripSeq) return;
    const r = net.route(trip.a.ll, trip.b.ll);
    if (!r) {
      box.innerHTML = `<div class="state"><strong>${esc(t("trip_none"))}</strong></div>`;
      if (fit) fitPoints(ends, 17);
      return;
    }
    // Tramo a pie: puntos azules sobre un borde blanco, como en los mapas habituales.
    // Si el punto pedido está lejos de la calle, una línea fina lo une con ella.
    const thin = { renderer, color: "#1C6FA8", weight: 2.5, opacity: 0.8, dashArray: "3 6", interactive: false };
    if (r.offFrom > 4) L.polyline([trip.a.ll, r.from], thin).addTo(tripLayer);
    if (r.offTo > 4) L.polyline([r.to, trip.b.ll], thin).addTo(tripLayer);
    L.polyline(r.coords, { renderer, color: "#FFFFFF", weight: 10, opacity: 0.95, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(tripLayer);
    L.polyline(r.coords, { renderer, color: "#1C6FA8", weight: 6, opacity: 1, interactive: false, lineCap: "round", lineJoin: "round", dashArray: "0.1 10" }).addTo(tripLayer);
    lastTrip = { total: r.dist + r.offFrom + r.offTo, fecha: net.fecha };
    renderTripResult();
    if (fit) fitPoints([...r.coords, ...ends], 17);
  }

  function renderTripResult() {
    if (!lastTrip) return;
    const min = walkMin(lastTrip.total);
    const eta = min < 60 ? `<b>${min}</b><span>${esc(t("min"))}</span>`
      : `<b>${Math.floor(min / 60)}</b><span>h</span> <b>${min % 60}</b><span>${esc(t("min"))}</span>`;
    const date = new Date(`${lastTrip.fecha}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
    const osm = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${fmtLL(trip.a.ll)}%3B${fmtLL(trip.b.ll)}`;
    $("#trip-result").innerHTML = `<div class="trip-card">
        <span class="mode">${ICON_WALK}</span>
        <span class="what">${esc(t("on_foot"))}<small>${fmtDist(lastTrip.total)}</small></span>
        <span class="eta">${eta}</span>
      </div>
      <p class="trip-note">${esc(t("trip_source", { date }))} <a href="${osm}" target="_blank" rel="noopener">${esc(t("trip_compare"))}</a></p>`;
  }

  map.on("click", (e) => {
    if (!tripOpen()) return;
    setEnd(targetEnd(), { kind: "map", ll: [e.latlng.lat, e.latlng.lng] });
  });

  ["a", "b"].forEach((w) => {
    const inp = $(`#trip-${w}`);
    inp.addEventListener("focus", () => {
      trip.picking = null;
      renderTripFields();
      openSugg(w);
      inp.select();
      if (!isDesktop()) panel.dataset.state = "full";
    });
    inp.addEventListener("input", () => openSugg(w));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = $("#trip-sugg button[data-id]");
        if (first) first.click();
      }
      if (e.key === "Escape") { inp.value = endLabel(trip[w]); inp.blur(); closeSugg(); setPanel(baseState()); }
    });
  });
  $("#trip-sugg").addEventListener("click", (e) => {
    e.stopPropagation();   // aquí una parada no abre su ficha: se elige como origen o destino
    const w = trip.editing || targetEnd();
    const stop = e.target.closest("button[data-id]");
    if (stop) { setEnd(w, stopEnd(byId.get(stop.dataset.id))); return; }
    const sp = e.target.closest("button[data-trip]");
    if (!sp) return;
    if (sp.dataset.trip === "me") {
      getPosition((ll) => setEnd(w, { kind: "me", ll }));
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
    const h = `#ir/${endToken(trip.a)}/${endToken(trip.b)}`.replace(/\/+$/, "");
    history.replaceState(history.state, "", h);
    $(`#trip-${w}`).value = "";
    renderTripFields();
    computeTrip(false);
    $(`#trip-${w}`).focus();
  }));
  $("#trip-swap").addEventListener("click", () => {
    [trip.a, trip.b] = [trip.b, trip.a];
    const h = `#ir/${endToken(trip.a)}/${endToken(trip.b)}`.replace(/\/+$/, "");
    history.replaceState(history.state, "", h);
    renderTripFields();
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
    if (stop || e.target.closest("button[data-line]")) clearTimeout(qTimer);
    if (stop) { $("#q").blur(); navigate(stop.dataset.id); return; }
    const line = e.target.closest("button[data-line]");
    if (line) {
      $("#q").blur();
      // Si se abre desde una parada, la línea se muestra alrededor de esa parada.
      lineOrigin = current ? current.id : null;
      navigate(`linea/${line.dataset.line}`);
      return;
    }
    const dir = e.target.closest("button[data-dir]");
    if (dir && active) {
      active.dir = Number(dir.dataset.dir);
      $("#line-dirs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b === dir));
      renderLineStops();
      drawLine();
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
      const first = $("#list button[data-id], #list button[data-line]");
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

  document.addEventListener("visibilitychange", () => { if (!document.hidden && current) loadArrivals(false); });

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
    } else if (active) showLine(active.code);
    else if (tripOpen()) { renderTripFields(); computeTrip(false); document.title = `${t("trip_title")} · Próximo Vitrasa`; }
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
